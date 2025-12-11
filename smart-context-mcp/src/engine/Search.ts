import path from "path";
import { BM25FRanking, BM25FConfig } from "./Ranking.js";
import { FileSearchResult, Document, SearchOptions, SearchFieldType, SymbolInfo } from "../types.js";
import { TrigramIndex, TrigramIndexOptions } from "./TrigramIndex.js";
import { IFileSystem } from "../platform/FileSystem.js";

const BUILTIN_EXCLUDE_GLOBS = [
    "**/node_modules/**",
    "**/.git/**",
    "**/.mcp/**",
    "**/dist/**",
    "**/coverage/**",
    "**/*.test.*",
    "**/*.spec.*"
];

const MAX_CANDIDATE_FILES = 400;
const DEFAULT_PREVIEW_LENGTH = 240;
const DEFAULT_MATCHES_PER_FILE = 5;

export interface ScoutArgs extends SearchOptions {
    keywords?: string[];
    patterns?: string[];
    includeGlobs?: string[];
    excludeGlobs?: string[];
    gitDiffMode?: boolean;
    basePath?: string;
}

interface SearchQuery {
    raw: string;
    regex: RegExp;
    literalHint?: string;
}

export interface SymbolMetadataProvider {
    getSymbolsForFile(filePath: string): Promise<SymbolInfo[]>;
}

export interface SearchEngineOptions {
    maxPreviewLength?: number;
    maxMatchesPerFile?: number;
    trigram?: TrigramIndexOptions;
    symbolMetadataProvider?: SymbolMetadataProvider;
    fieldWeights?: BM25FConfig["fieldWeights"];
}

export class SearchEngine {
    private readonly rootPath: string;
    private readonly fileSystem: IFileSystem;
    private readonly bm25Ranking: BM25FRanking;
    private readonly defaultExcludeGlobs: string[];
    private readonly trigramIndex: TrigramIndex;
    private readonly maxPreviewLength: number;
    private readonly maxMatchesPerFile: number;
    private readonly symbolMetadataProvider?: SymbolMetadataProvider;
    private readonly symbolCache = new Map<string, SymbolInfo[]>();
    private readonly symbolLoaders = new Map<string, Promise<SymbolInfo[]>>();

    constructor(rootPath: string, fileSystem: IFileSystem, initialExcludeGlobs: string[] = [], options: SearchEngineOptions = {}) {
        this.rootPath = path.resolve(rootPath);
        this.fileSystem = fileSystem;
        this.bm25Ranking = new BM25FRanking({ fieldWeights: options.fieldWeights });
        const combined = [...BUILTIN_EXCLUDE_GLOBS, ...initialExcludeGlobs];
        this.defaultExcludeGlobs = Array.from(new Set(combined));
        this.maxPreviewLength = options.maxPreviewLength ?? DEFAULT_PREVIEW_LENGTH;
        this.maxMatchesPerFile = options.maxMatchesPerFile ?? DEFAULT_MATCHES_PER_FILE;
        this.symbolMetadataProvider = options.symbolMetadataProvider;
        this.trigramIndex = new TrigramIndex(this.rootPath, this.fileSystem, {
            ignoreGlobs: this.defaultExcludeGlobs,
            ...options.trigram
        });
    }

    public async warmup(): Promise<void> {
        await this.trigramIndex.ensureReady();
    }

    public async rebuild(): Promise<void> {
        await this.trigramIndex.rebuild();
        this.symbolCache.clear();
        this.symbolLoaders.clear();
    }

    public async invalidateFile(absPath: string): Promise<void> {
        await this.trigramIndex.refreshFile(absPath);
        this.dropSymbolMetadata(absPath);
    }

    public async invalidateDirectory(absDir: string): Promise<void> {
        await this.trigramIndex.refreshDirectory(absDir);
        this.dropSymbolMetadata(absDir, true);
    }

    public escapeRegExp(value: string, options: SearchOptions = {}): string {
        const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return options.wordBoundary ? `\\b${escaped}\\b` : escaped;
    }

    public async runFileGrep(searchPattern: string, filePath: string): Promise<number[]> {
        let regex: RegExp;
        try {
            regex = new RegExp(searchPattern, "g");
        } catch {
            regex = new RegExp(this.escapeRegExp(searchPattern), "g");
        }
        let content: string;
        try {
            content = await this.fileSystem.readFile(filePath);
        } catch {
            return [];
        }
        const lines = content.split(/\r?\n/);
        const matches: number[] = [];
        for (let index = 0; index < lines.length; index++) {
            regex.lastIndex = 0;
            if (regex.test(lines[index])) {
                matches.push(index + 1);
            }
        }
        return matches;
    }

    public async scout(args: ScoutArgs): Promise<FileSearchResult[]> {
        const { keywords, patterns, includeGlobs, excludeGlobs, gitDiffMode, basePath, wordBoundary } = args;

        if ((!keywords || keywords.length === 0) && (!patterns || patterns.length === 0)) {
            throw new Error("At least one keyword or pattern is required.");
        }

        if (gitDiffMode) {
            console.warn("gitDiffMode is not yet fully implemented.");
        }

        const queries = this.buildSearchQueries({ keywords, patterns, wordBoundary });
        const baseCwd = basePath ? path.resolve(basePath) : this.rootPath;
        const normalizedBase = baseCwd.startsWith(this.rootPath) ? baseCwd : this.rootPath;
        const combinedExcludeGlobs = [...this.defaultExcludeGlobs, ...(excludeGlobs || [])];
        const includeRegexes = includeGlobs && includeGlobs.length > 0
            ? includeGlobs.map(glob => this.globToRegExp(glob))
            : undefined;
        const excludeRegexes = combinedExcludeGlobs.map(glob => this.globToRegExp(glob));

        const candidateScores = await this.collectCandidateFiles(queries);
        const matchesById = new Map<string, FileSearchResult>();
        const matchOrigins = new Map<string, string>();

        for (const [relativePath] of candidateScores) {
            const normalizedRelative = relativePath.replace(/\\/g, "/");
            const absPath = path.isAbsolute(relativePath)
                ? relativePath
                : path.join(this.rootPath, relativePath);
            let content: string;
            try {
                content = await this.fileSystem.readFile(absPath);
            } catch {
                continue;
            }
            const fileMatches = this.collectMatchesFromFile(normalizedRelative, content, queries);
            for (const match of fileMatches) {
                const absMatchPath = path.join(this.rootPath, match.filePath);
                const relativeToBase = this.normalizeRelativePath(absMatchPath, normalizedBase);
                if (!relativeToBase) {
                    continue;
                }
                if (!this.shouldInclude(relativeToBase, includeRegexes, excludeRegexes)) {
                    continue;
                }
                const normalizedMatch: FileSearchResult = {
                    ...match,
                    filePath: relativeToBase
                };
                const docId = `${normalizedMatch.filePath}:${normalizedMatch.lineNumber}`;
                matchesById.set(docId, normalizedMatch);
                matchOrigins.set(docId, normalizedRelative);
            }
        }

        if (matchesById.size === 0) {
            return [];
        }

        const fieldAssignments = await this.assignFieldTypes(matchesById);

        const documents: Document[] = Array.from(matchesById.entries()).map(([docId, match]) => {
            const originPath = matchOrigins.get(docId);
            const originScore = originPath ? candidateScores.get(originPath) ?? 0 : 0;
            return {
                id: docId,
                text: match.preview,
                score: originScore,
                filePath: match.filePath,
                fieldType: fieldAssignments.get(docId)
            };
        });
        const queryText = queries.map(q => q.raw).join(" ");
        const rankedDocuments = this.bm25Ranking.rank(documents, queryText);

        return rankedDocuments.map(doc => {
            const match = matchesById.get(doc.id);
            if (!match) {
                const [filePath, line] = this.splitDocId(doc.id);
                return {
                    filePath,
                    lineNumber: line,
                    preview: "",
                    score: doc.score,
                    scoreDetails: doc.scoreDetails
                };
            }
            return {
                ...match,
                score: doc.score,
                scoreDetails: doc.scoreDetails
            };
        });
    }

    private buildSearchQueries(args: { keywords?: string[]; patterns?: string[]; wordBoundary?: boolean }): SearchQuery[] {
        const queries: SearchQuery[] = [];
        for (const keyword of args.keywords ?? []) {
            const escaped = this.escapeRegExp(keyword, { wordBoundary: args.wordBoundary });
            queries.push({
                raw: keyword,
                regex: new RegExp(escaped, "g"),
                literalHint: keyword.toLowerCase()
            });
        }
        for (const pattern of args.patterns ?? []) {
            let regex: RegExp;
            try {
                regex = new RegExp(pattern, "g");
            } catch (error) {
                throw new Error(`Invalid search pattern '${pattern}': ${(error as Error).message}`);
            }
            queries.push({
                raw: pattern,
                regex,
                literalHint: this.extractLiteralHint(pattern)
            });
        }
        return queries;
    }

    private extractLiteralHint(pattern: string): string | undefined {
        const literalSegments = pattern
            .split(/[^a-zA-Z0-9]+/)
            .filter(segment => segment.length >= 3);
        if (literalSegments.length === 0) {
            return undefined;
        }
        return literalSegments.reduce((longest, current) => current.length > longest.length ? current : longest).toLowerCase();
    }

    private async collectCandidateFiles(queries: SearchQuery[]): Promise<Map<string, number>> {
        const candidates = new Map<string, number>();
        for (const query of queries) {
            if (!query.literalHint || query.literalHint.length === 0) {
                continue;
            }
            const matches = await this.trigramIndex.search(query.literalHint, MAX_CANDIDATE_FILES);
            for (const candidate of matches) {
                const normalizedPath = candidate.filePath.replace(/\\/g, "/");
                const previous = candidates.get(normalizedPath) ?? 0;
                candidates.set(normalizedPath, Math.max(previous, candidate.score));
            }
        }
        if (candidates.size === 0) {
            const fallback = this.trigramIndex.listFiles().slice(0, MAX_CANDIDATE_FILES);
            for (const filePath of fallback) {
                const normalizedPath = filePath.replace(/\\/g, "/");
                candidates.set(normalizedPath, 0);
            }
        }
        return candidates;
    }

    private collectMatchesFromFile(relativePath: string, content: string, queries: SearchQuery[]): FileSearchResult[] {
        const matches: FileSearchResult[] = [];
        const lines = content.split(/\r?\n/);
        for (let index = 0; index < lines.length; index++) {
            const line = lines[index];
            for (const query of queries) {
                query.regex.lastIndex = 0;
                if (query.regex.test(line)) {
                    matches.push({
                        filePath: relativePath,
                        lineNumber: index + 1,
                        preview: this.formatPreview(line)
                    });
                    break;
                }
            }
            if (matches.length >= this.maxMatchesPerFile) {
                break;
            }
        }
        return matches;
    }

    private formatPreview(line: string): string {
        const trimmed = line.trim();
        if (trimmed.length <= this.maxPreviewLength) {
            return trimmed;
        }
        return `${trimmed.slice(0, this.maxPreviewLength - 1)}…`;
    }

    private async assignFieldTypes(matches: Map<string, FileSearchResult>): Promise<Map<string, SearchFieldType>> {
        const assignments = new Map<string, SearchFieldType>();
        const tasks = Array.from(matches.entries()).map(async ([docId, match]) => {
            const fieldType = await this.classifyField(match.filePath, match.lineNumber, match.preview);
            assignments.set(docId, fieldType);
        });
        await Promise.all(tasks);
        return assignments;
    }

    private async classifyField(relativePath: string, lineNumber: number, preview: string): Promise<SearchFieldType> {
        if (this.isCommentLine(preview)) {
            return "comment";
        }
        const symbol = await this.findSymbolForLine(relativePath, lineNumber);
        if (symbol && symbol.range) {
            const startLine = symbol.range.startLine + 1;
            const endLine = symbol.range.endLine + 1;
            const exportFlag = this.isExportedSymbol(symbol);
            if (lineNumber === startLine) {
                return "symbol-definition";
            }
            const signatureBoundary = Math.min(endLine, startLine + 2);
            if (lineNumber > startLine && lineNumber <= signatureBoundary) {
                return "signature";
            }
            if (exportFlag) {
                return "exported-member";
            }
        }
        if (/^\s*export\s+/i.test(preview)) {
            return "exported-member";
        }
        return "code-body";
    }

    private async findSymbolForLine(relativePath: string, lineNumber: number): Promise<SymbolInfo | undefined> {
        const symbols = await this.getSymbolsForRelativePath(relativePath);
        if (!symbols) {
            return undefined;
        }
        return symbols.find(symbol => {
            if (!symbol.range) {
                return false;
            }
            const start = symbol.range.startLine + 1;
            const end = symbol.range.endLine + 1;
            return lineNumber >= start && lineNumber <= end;
        });
    }

    private async getSymbolsForRelativePath(relativePath: string): Promise<SymbolInfo[] | undefined> {
        if (!this.symbolMetadataProvider) {
            return undefined;
        }
        const key = this.normalizeCacheKey(relativePath);
        if (this.symbolCache.has(key)) {
            return this.symbolCache.get(key);
        }
        let loader = this.symbolLoaders.get(key);
        if (!loader) {
            const absPath = path.isAbsolute(relativePath)
                ? relativePath
                : path.join(this.rootPath, relativePath);
            loader = this.symbolMetadataProvider.getSymbolsForFile(absPath).catch(() => []);
            this.symbolLoaders.set(key, loader);
        }
        const symbols = await loader;
        this.symbolCache.set(key, symbols);
        this.symbolLoaders.delete(key);
        return symbols;
    }

    private dropSymbolMetadata(targetPath: string, includeDescendants: boolean = false): void {
        const relative = this.normalizeRelativePath(targetPath, this.rootPath);
        if (!relative) {
            return;
        }
        const normalized = this.normalizeCacheKey(relative);
        const predicate = (key: string) => key === normalized || (includeDescendants && key.startsWith(`${normalized}/`));
        for (const key of Array.from(this.symbolCache.keys())) {
            if (predicate(key)) {
                this.symbolCache.delete(key);
            }
        }
        for (const key of Array.from(this.symbolLoaders.keys())) {
            if (predicate(key)) {
                this.symbolLoaders.delete(key);
            }
        }
    }

    private normalizeCacheKey(relativePath: string): string {
        return relativePath.replace(/\\/g, "/");
    }

    private isExportedSymbol(symbol: SymbolInfo): boolean {
        if ((symbol as any).exportKind) {
            return true;
        }
        if (Array.isArray(symbol.modifiers)) {
            return symbol.modifiers.some(mod => mod.toLowerCase() === "export");
        }
        return false;
    }

    private isCommentLine(line: string): boolean {
        const trimmed = line.trim();
        return /^(\/\/|\/\*|\*|#)/.test(trimmed);
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
        return relative.replace(/\\/g, '/') || path.basename(absolute);
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

    private splitDocId(docId: string): [string, number] {
        const separatorIndex = docId.lastIndexOf(':');
        if (separatorIndex === -1) {
            return [docId, 0];
        }
        const filePath = docId.slice(0, separatorIndex);
        const line = parseInt(docId.slice(separatorIndex + 1), 10);
        return [filePath, Number.isFinite(line) ? line : 0];
    }
}
