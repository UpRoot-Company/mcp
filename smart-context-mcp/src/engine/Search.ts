import { exec } from "child_process";
import { promisify } from "util";
import * as path from "path";
import { BM25Ranking } from "./Ranking.js";
import { FileSearchResult, Document } from "../types.js";

const execAsync = promisify(exec);

const BUILTIN_EXCLUDE_GLOBS = [
    "**/node_modules/**",
    "**/.git/**",
    "**/.mcp/**",
    "**/dist/**",
    "**/coverage/**",
    "**/*.test.*",
    "**/*.spec.*"
];

export interface ScoutArgs {
    keywords?: string[];
    patterns?: string[];
    includeGlobs?: string[];
    excludeGlobs?: string[];
    gitDiffMode?: boolean;
    basePath?: string;
}

export class SearchEngine {
    private bm25Ranking: BM25Ranking;
    private defaultExcludeGlobs: string[];

    constructor(initialExcludeGlobs: string[] = []) {
        this.bm25Ranking = new BM25Ranking();
        const combined = [...BUILTIN_EXCLUDE_GLOBS, ...initialExcludeGlobs];
        this.defaultExcludeGlobs = Array.from(new Set(combined));
    }

    public escapeRegExp(value: string): string {
        return `\\b${value.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\b`;
    }

    public async runGrep(
        searchPattern: string,
        currentGrepCwd: string,
        excludeDirNames: string[] = [],
        gitDiffMode: boolean = false
    ): Promise<FileSearchResult[]> {
        const escapedPattern = searchPattern.replace(/"/g, '\\"');
        let command = `grep -n -r -I -E "${escapedPattern}" .`;

        if (excludeDirNames.length > 0) {
            command += ` ${excludeDirNames.map(dir => `--exclude-dir='${dir}'`).join(' ')}`;
        }
        if (gitDiffMode) {
            console.warn('gitDiffMode is not yet fully implemented.');
        }

        try {
            const { stdout } = await execAsync(command, { cwd: currentGrepCwd });
            const matches: FileSearchResult[] = stdout
                .split('\n')
                .filter(line => line.trim() !== '')
                .map(line => {
                    const parts = line.split(':');
                    if (parts.length < 3) return null;

                    const filePath = parts[0];
                    const lineNumber = parseInt(parts[1], 10);
                    const preview = parts.slice(2).join(':');

                    if (isNaN(lineNumber)) return null;

                    return {
                        filePath: path.isAbsolute(filePath) ? filePath : path.resolve(currentGrepCwd, filePath),
                        lineNumber,
                        preview,
                    };
                })
                .filter((m): m is FileSearchResult => m !== null);
            return matches;
        } catch (error: any) {
            if (error.code === 1) {
                return [];
            }
            throw new Error(`Grep command failed: ${error.message}`);
        }
    }

    public async runFileGrep(searchPattern: string, filePath: string): Promise<number[]> {
        const escapedPattern = searchPattern.replace(/"/g, '\\"');
        const command = `grep -n -E "${escapedPattern}" "${filePath}"`;
        try {
            const { stdout } = await execAsync(command);
            const lineNumbers: number[] = [];
            stdout.split('\n').forEach((line) => {
                const parts = line.split(':');
                const num = parseInt(parts[0], 10);
                if (!isNaN(num)) {
                    lineNumbers.push(num);
                }
            });
            return lineNumbers;
        } catch (error: any) {
            if (error.code === 1) return [];
            throw error;
        }
    }

    public async scout(args: ScoutArgs): Promise<FileSearchResult[]> {
        const { keywords, patterns, includeGlobs, excludeGlobs, gitDiffMode, basePath } = args;

        if ((!keywords || keywords.length === 0) && (!patterns || patterns.length === 0)) {
            throw new Error('At least one keyword or pattern is required.');
        }

        const searchConfigs = [
            ...(keywords || []).map((k) => ({ pattern: this.escapeRegExp(k) })),
            ...(patterns || []).map((p) => ({ pattern: p }))
        ];

        let allMatches: FileSearchResult[] = [];
        const baseCwd = basePath ? path.resolve(basePath) : process.cwd();
        const combinedExcludeGlobs = [...this.defaultExcludeGlobs, ...(excludeGlobs || [])];
        const includeRegexes = includeGlobs && includeGlobs.length > 0
            ? includeGlobs.map(glob => this.globToRegExp(glob))
            : undefined;
        const excludeRegexes = combinedExcludeGlobs.map(glob => this.globToRegExp(glob));
        const excludeDirNames = this.extractDirectoryNamesFromGlobs(combinedExcludeGlobs);

        for (const config of searchConfigs) {
            const matches = await this.runGrep(config.pattern, baseCwd, excludeDirNames, gitDiffMode);
            const filteredMatches = matches
                .map(match => {
                    const relativePath = this.normalizeRelativePath(match.filePath, baseCwd);
                    if (!relativePath) {
                        return null;
                    }
                    return { ...match, filePath: relativePath };
                })
                .filter((match): match is FileSearchResult => match !== null)
                .filter(match => this.shouldInclude(match.filePath, includeRegexes, excludeRegexes));
            allMatches.push(...filteredMatches);
        }

        const uniqueMatches = Array.from(new Map(allMatches.map(match => [`${match.filePath}:${match.lineNumber}`, match])).values());

        const scoredDocuments: Document[] = uniqueMatches.map(match => ({
            id: `${match.filePath}:${match.lineNumber}`,
            text: match.preview,
            score: 0
        }));

        const searchQuery = [...(keywords || []), ...(patterns || [])].join(' ');
        const rankedDocuments = this.bm25Ranking.rank(scoredDocuments, searchQuery);

        const rankedFileMatches: FileSearchResult[] = rankedDocuments.map((rankedDoc: Document) => {
            const originalMatch = uniqueMatches.find(um => `${um.filePath}:${um.lineNumber}` === rankedDoc.id)!;
            return {
                ...originalMatch,
                score: rankedDoc.score
            };
        });

        return rankedFileMatches;
    }

    private globToRegExp(glob: string): RegExp {
        const normalized = glob.replace(/\\/g, '/').replace(/^\.\//, '');
        if (!normalized.includes('/') && !/[?*]/.test(normalized)) {
            const escaped = normalized.replace(/[-/\\^$+?.()|[\]{}]/g, '\\$&');
            return new RegExp(`(^|/)${escaped}(/|$)`);
        }

        const doubleStarPlaceholder = "__DOUBLE_STAR__";
        const singleStarPlaceholder = "__SINGLE_STAR__";
        const questionPlaceholder = "__QUESTION_MARK__";
        const hasTrailingGlobstar = normalized.endsWith('/**');
        let pattern = normalized
            .replace(/\*\*/g, doubleStarPlaceholder)
            .replace(/\*/g, singleStarPlaceholder)
            .replace(/\?/g, questionPlaceholder)
            .replace(/([.+^${}()|[\]\\])/g, '\\$1')
            .replace(new RegExp(doubleStarPlaceholder, 'g'), '.*')
            .replace(new RegExp(singleStarPlaceholder, 'g'), '[^/]*')
            .replace(new RegExp(questionPlaceholder, 'g'), '.');
        if (hasTrailingGlobstar) {
            pattern = pattern.replace(/\/\.\*$/, '(?:/.*)?');
        }
        return new RegExp(`^${pattern}$`);
    }

    private normalizeRelativePath(filePath: string, basePath: string): string | null {
        const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(basePath, filePath);
        const relative = path.relative(basePath, absolute);
        if (relative.startsWith('..')) {
            return null;
        }
        return relative || path.basename(absolute);
    }

    private shouldInclude(relativePath: string, includeRegexes?: RegExp[], excludeRegexes?: RegExp[]): boolean {
        const normalized = relativePath.split(path.sep).join('/');
        const hasIncludePatterns = !!(includeRegexes && includeRegexes.length > 0);
        const matchesInclude = hasIncludePatterns ? includeRegexes!.some(regex => regex.test(normalized)) : true;
        if (!matchesInclude) {
            return false;
        }
        const matchesExclude = excludeRegexes?.some(regex => regex.test(normalized)) ?? false;
        if (matchesExclude && !(hasIncludePatterns && matchesInclude)) {
            return false;
        }
        return true;
    }

    private extractDirectoryNamesFromGlobs(globs: string[]): string[] {
        const dirs = new Set<string>();
        for (const glob of globs) {
            const normalized = glob.replace(/\\/g, '/');
            const segments = normalized.split('/').filter(Boolean);
            if (segments.length === 0) {
                continue;
            }
            let candidate = segments[segments.length - 1];
            if (/[*?[]/.test(candidate) && segments.length > 1) {
                candidate = segments[segments.length - 2];
            }
            if (/[*?[]/.test(candidate)) {
                continue;
            }
            dirs.add(candidate);
        }
        return Array.from(dirs);
    }
}
