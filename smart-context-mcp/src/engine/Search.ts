import path from "path";
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import { Dirent } from 'fs';
import { QueryTokenizer } from "./QueryTokenizer.js";
const execAsync = promisify(exec);
import { BM25FRanking, BM25FConfig } from "./Ranking.js";
import { FileSearchResult, Document, SearchOptions, SearchFieldType, SearchProjectResultEntry, SymbolInfo, SymbolIndex } from "../types.js";
import { TrigramIndex, TrigramIndexOptions } from "./TrigramIndex.js";
import { IFileSystem } from "../platform/FileSystem.js";
import { CallGraphMetricsBuilder, CallGraphSignals } from "./CallGraphMetricsBuilder.js";
import { CallGraphBuilder } from "../ast/CallGraphBuilder.js";
import { HybridScorer } from './scoring/HybridScorer.js';
import { CandidateCollector } from './search/CandidateCollector.js';
import { ResultProcessor } from './search/ResultProcessor.js';
import { FilenameScorer } from './scoring/FilenameScorer.js';
import { CommentParser } from '../utils/CommentParser.js';

const BUILTIN_EXCLUDE_GLOBS = [
    "**/node_modules/**",
    "**/.git/**",
    "**/.mcp/**",
    "**/dist/**",
    "**/coverage/**",
    "**/*.test.*",
    "**/*.spec.*"
];

const DEFAULT_PREVIEW_LENGTH = 240;
const DEFAULT_MATCHES_PER_FILE = 5;

export interface ScoutArgs extends SearchOptions {
    maxResults?: number;
    query?: string;
    keywords?: string[]; // Deprecated, use query
    patterns?: string[]; // Deprecated, use query
    includeGlobs?: string[];
    excludeGlobs?: string[];
    gitDiffMode?: boolean;
    basePath?: string;
    fileTypes?: string[];
    snippetLength?: number;
    matchesPerFile?: number;
    groupByFile?: boolean;
    deduplicateByContent?: boolean;
}

interface SearchQuery {
    raw: string;
    regex: RegExp;
    literalHint?: string;
}

export interface SearchEngineOptions {
    maxPreviewLength?: number;
    maxMatchesPerFile?: number;
    trigram?: TrigramIndexOptions;
    symbolIndex?: SymbolIndex;
    fieldWeights?: BM25FConfig["fieldWeights"];
    callGraphBuilder?: CallGraphBuilder;
}

interface KeywordConstraint {
    raw: string;
    normalized: string;
    requiresCaseSensitive: boolean;
}

export class SearchEngine {
    private readonly rootPath: string;
    private readonly fileSystem: IFileSystem;
    private readonly bm25Ranking: BM25FRanking;
    private defaultExcludeGlobs: string[];
    private readonly trigramIndex: TrigramIndex;
    private readonly maxPreviewLength: number;
    private readonly maxMatchesPerFile: number;
    private readonly symbolIndex?: SymbolIndex;
    private readonly queryTokenizer: QueryTokenizer;
    private readonly callGraphMetricsBuilder?: CallGraphMetricsBuilder;
    private callGraphSignals?: Map<string, CallGraphSignals>;

    // Extracted components
    private hybridScorer: HybridScorer;
    private candidateCollector: CandidateCollector;
    private resultProcessor: ResultProcessor;
    private filenameScorer: FilenameScorer;
    private commentParser: CommentParser;

    constructor(rootPath: string, fileSystem: IFileSystem, initialExcludeGlobs: string[] = [], options: SearchEngineOptions = {}) {
        this.rootPath = path.resolve(rootPath);
        this.fileSystem = fileSystem;
        this.bm25Ranking = new BM25FRanking({ fieldWeights: options.fieldWeights });
        const combined = [...BUILTIN_EXCLUDE_GLOBS, ...initialExcludeGlobs];
        this.defaultExcludeGlobs = Array.from(new Set(combined));
        this.maxPreviewLength = options.maxPreviewLength ?? DEFAULT_PREVIEW_LENGTH;
        this.maxMatchesPerFile = options.maxMatchesPerFile ?? DEFAULT_MATCHES_PER_FILE;
        this.symbolIndex = options.symbolIndex;
        this.callGraphMetricsBuilder = options.callGraphBuilder
            ? new CallGraphMetricsBuilder(options.callGraphBuilder)
            : undefined;
        this.queryTokenizer = new QueryTokenizer();
        this.trigramIndex = new TrigramIndex(this.rootPath, this.fileSystem, {
            ignoreGlobs: this.defaultExcludeGlobs,
            ...options.trigram
        });

        // Initialize extracted components
        this.filenameScorer = new FilenameScorer();
        this.commentParser = new CommentParser();
        
        this.hybridScorer = new HybridScorer(
            this.rootPath,
            this.fileSystem,
            this.trigramIndex,
            this.bm25Ranking,
            this.symbolIndex
        );
        
        this.candidateCollector = new CandidateCollector(
            this.rootPath,
            this.trigramIndex,
            this.symbolIndex,
            this.fileSystem
        );
        
        this.resultProcessor = new ResultProcessor();
    }

    public async updateExcludeGlobs(patterns: string[]): Promise<void> {
        const combined = [...BUILTIN_EXCLUDE_GLOBS, ...patterns];
        this.defaultExcludeGlobs = Array.from(new Set(combined));
        await this.trigramIndex.updateIgnoreGlobs(this.defaultExcludeGlobs);
    }

    public async warmup(): Promise<void> {
        await this.trigramIndex.ensureReady();
    }

    public async rebuild(): Promise<void> {
        await this.trigramIndex.rebuild();
        this.callGraphSignals = undefined;
    }

    public async invalidateFile(absPath: string): Promise<void> {
        await this.trigramIndex.refreshFile(absPath);
        this.callGraphSignals = undefined;
    }

    public async invalidateDirectory(absDir: string): Promise<void> {
        await this.trigramIndex.refreshDirectory(absDir);
        this.callGraphSignals = undefined;
    }

    public async runFileGrep(searchPattern: string, filePath: string): Promise<number[]> {
        // Kept for backward compatibility or direct usage if needed
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

    public escapeRegExp(value: string, options: SearchOptions = {}): string {
        const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return options.wordBoundary ? `\\b${escaped}\\b` : escaped;
    }

    public async scout(args: ScoutArgs): Promise<FileSearchResult[]> {
        const { query, includeGlobs, excludeGlobs, basePath, patterns } = args;

        if (!query && (!args.keywords || args.keywords.length === 0) && (!patterns || patterns.length === 0)) {
            throw new Error("A query string, keyword, or pattern is required.");
        }

        const smartCase = args.smartCase ?? true;
        const caseSensitive = Boolean(args.caseSensitive);
        const wordBoundary = Boolean(args.wordBoundary);

        const keywordSource = query && query.trim().length > 0
            ? this.queryTokenizer.tokenize(query)
            : (args.keywords ?? []).filter((kw): kw is string => typeof kw === "string" && kw.trim().length > 0);

        const keywordConstraints = this.buildKeywordConstraints(keywordSource, { caseSensitive, smartCase });
        const normalizedKeywords = keywordConstraints.map(keyword => keyword.normalized);
        const keywordLabels = keywordConstraints.map(keyword => keyword.raw);
        const shouldApplyKeywordFilter = keywordConstraints.length > 0 && (!patterns || patterns.length === 0);

        const effectiveQuery = query || keywordSource.join(' ');
        const normalizedQuery = effectiveQuery ? this.queryTokenizer.normalize(effectiveQuery) : '';

        console.log(`[Search] Hybrid search for query: "${effectiveQuery}" (keywords: ${keywordLabels.join(', ')})`);

        const combinedExcludeGlobs = [...this.defaultExcludeGlobs, ...(excludeGlobs || [])];
        const includeRegexes = includeGlobs && includeGlobs.length > 0
            ? includeGlobs.map(glob => this.globToRegExp(glob))
            : undefined;
        const excludeRegexes = combinedExcludeGlobs.map(glob => this.globToRegExp(glob));

        const previewLength = this.normalizeSnippetLength(args.snippetLength);
        const matchesPerFile = this.normalizeMatchesPerFile(args.matchesPerFile);

        let candidates = await this.candidateCollector.collectHybridCandidates(normalizedKeywords);

        if (candidates.size === 0) {
            const fallbackCandidates = await this.candidateCollector.collectFilesystemCandidates(
                basePath ? path.resolve(basePath) : this.rootPath,
                (relativePath) => this.shouldInclude(relativePath, includeRegexes, excludeRegexes)
            );
            if (fallbackCandidates.size > 0) {
                candidates = fallbackCandidates;
                console.log(`[Search] Added ${fallbackCandidates.size} fallback candidates via filesystem scan, total: ${candidates.size}`);
            }
        }

        if (patterns && patterns.length > 0 && candidates.size < 1000) {
            const allFiles = this.trigramIndex.listFiles();
            for (const file of allFiles) candidates.add(file);
        }

        console.log(`[Search] Collected ${candidates.size} candidates`);

        const contentCache = new Map<string, string>();
        const fileSearchResults: FileSearchResult[] = [];

        for (const candidatePath of candidates) {
            const absPath = path.isAbsolute(candidatePath)
                ? candidatePath
                : path.join(this.rootPath, candidatePath);

            const relativeToBase = this.normalizeRelativePath(absPath, basePath ? path.resolve(basePath) : this.rootPath);
            if (!relativeToBase || !this.shouldInclude(relativeToBase, includeRegexes, excludeRegexes)) {
                continue;
            }

            const content = contentCache.get(absPath) ?? await this.fileSystem.readFile(absPath);
            contentCache.set(absPath, content);
            const contentLines = content.split(/\r?\n/);

            const filenameMatchType = this.filenameScorer.scoreFilename(relativeToBase, normalizedKeywords, { wordBoundary });
            const keywordLines = normalizedKeywords.length > 0
                ? this.findKeywordMatches(content, keywordConstraints, { wordBoundary, caseSensitive }, matchesPerFile)
                : [];

            const patternLines = patterns && patterns.length > 0
                ? this.findPatternMatches(content, patterns, matchesPerFile)
                : [];

            if (shouldApplyKeywordFilter && keywordLines.length === 0 && filenameMatchType === 'none') {
                continue;
            }

            if (keywordLines.length === 0 && patternLines.length === 0 && filenameMatchType === 'none') {
                continue;
            }

            // Using HybridScorer to check if the file is relevant enough to proceed
            // Note: Currently HybridScorer calculates scores, but we also do per-line matching here.
            // Ideally, we would rely on HybridScorer's score, but line details are needed.
            // For now, we proceed with line matching.
            
            const filenameMultiplier = filenameMatchType === 'exact'
                ? 10
                : filenameMatchType === 'partial'
                    ? 5
                    : 1;

            const totalKeywordOccurrences = keywordLines.reduce((sum, entry) => sum + entry.occurrences, 0);
            const keywordScore = totalKeywordOccurrences > 0
                ? Math.max(1, totalKeywordOccurrences * 120 * filenameMultiplier)
                : 0;
            const patternScore = patternLines.length > 0
                ? Math.max(1, patternLines.length * 200 * filenameMultiplier)
                : 0;

            const symbolScoreVal = this.symbolIndex
                ? await this.scoreSymbolsHelper(absPath, keywordConstraints.map(k => k.raw))
                : 0;
            const symbolBonusVal = symbolScoreVal > 0 ? symbolScoreVal * 20 * filenameMultiplier : 0;

            if (keywordLines.length === 0 && patternLines.length === 0 && filenameMatchType !== 'none') {
                const preview = this.extractLinePreview(content, 1, previewLength);
                const typeSignals = ['filename'];
                if (symbolBonusVal > 0) typeSignals.push('symbol');

                const filenameScore = Math.max(1, 80 * filenameMultiplier + symbolBonusVal);
                fileSearchResults.push({
                    filePath: relativeToBase,
                    lineNumber: 1,
                    preview,
                    score: filenameScore,
                    scoreDetails: {
                        type: typeSignals.join('+'),
                        details: [
                            { type: 'filename', score: filenameScore },
                            ...(symbolBonusVal > 0 ? [{ type: 'symbol', score: symbolBonusVal }] : [])
                        ],
                        totalScore: filenameScore,
                        contentScore: 0,
                        filenameMultiplier,
                        depthMultiplier: 1,
                        fieldWeight: 1,
                        filenameMatchType
                    }
                });
                continue;
            }

            for (const lineNumber of patternLines) {
                const preview = this.extractLinePreview(content, lineNumber, previewLength);
                const matchTotalScore = patternScore + symbolBonusVal;
                const typeSignals = ['pattern'];
                if (filenameMatchType !== 'none') typeSignals.push('filename');
                if (symbolBonusVal > 0) typeSignals.push('symbol');

                fileSearchResults.push({
                    filePath: relativeToBase,
                    lineNumber,
                    preview,
                    score: matchTotalScore,
                    scoreDetails: {
                        type: typeSignals.join('+'),
                        details: [
                            { type: 'pattern', score: patternScore },
                            ...(symbolBonusVal > 0 ? [{ type: 'symbol', score: symbolBonusVal }] : [])
                        ],
                        totalScore: matchTotalScore,
                        contentScore: 0,
                        filenameMultiplier,
                        depthMultiplier: 1,
                        fieldWeight: 1,
                        filenameMatchType
                    }
                });
            }

            for (const { lineNumber, occurrences } of keywordLines) {
                const preview = this.extractLinePreview(content, lineNumber, previewLength);
                const matchTotalScore = keywordScore + symbolBonusVal;
                const typeSignals = ['content'];
                const lineText = contentLines[lineNumber - 1]?.trim() ?? '';
                if (this.commentParser.isCommentLine(lineText)) {
                    typeSignals.push('comment');
                }
                if (filenameMatchType !== 'none') typeSignals.push('filename');
                if (symbolBonusVal > 0) typeSignals.push('symbol');

                fileSearchResults.push({
                    filePath: relativeToBase,
                    lineNumber,
                    preview,
                    score: matchTotalScore + occurrences,
                    scoreDetails: {
                        type: typeSignals.join('+'),
                        details: [
                            { type: 'content', score: keywordScore },
                            ...(symbolBonusVal > 0 ? [{ type: 'symbol', score: symbolBonusVal }] : [])
                        ],
                        totalScore: matchTotalScore + occurrences,
                        contentScore: keywordScore,
                        filenameMultiplier,
                        depthMultiplier: 1,
                        fieldWeight: 1,
                        filenameMatchType
                    }
                });
            }
        }

        fileSearchResults.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
        console.log(`[Search] Returning ${fileSearchResults.length} results`);

        return this.resultProcessor.postProcessResults(fileSearchResults, {
            fileTypes: args.fileTypes,
            snippetLength: previewLength,
            groupByFile: args.groupByFile,
            deduplicateByContent: args.deduplicateByContent
        });
    }

    private async scoreSymbolsHelper(filePath: string, keywords: string[]): Promise<number> {
        if (!this.symbolIndex) return 0;
        try {
            const symbols = await this.symbolIndex.getSymbolsForFile(filePath);
            let score = 0;
            for (const symbol of symbols) {
                const lowerSymbol = symbol.name.toLowerCase();
                for (const keyword of keywords) {
                    const lowerKw = keyword.toLowerCase();
                    if (lowerSymbol === lowerKw) score += 8;
                    else if (lowerSymbol.includes(lowerKw)) score += 4;
                }
            }
            return score;
        } catch { return 0; }
    }

    private normalizeMatchesPerFile(requested?: number): number {
        if (typeof requested === "number" && Number.isFinite(requested)) {
            return Math.max(1, Math.floor(requested));
        }
        return this.maxMatchesPerFile;
    }

    private normalizeSnippetLength(requested?: number): number {
        if (typeof requested === "number" && Number.isFinite(requested)) {
            if (requested <= 0) {
                return 0;
            }
            return Math.min(2000, Math.max(16, Math.floor(requested)));
        }
        return this.maxPreviewLength;
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
        
        let effectiveNormalized = normalized;
        const hasTrailingGlobstar = normalized.endsWith('/**');
        if (hasTrailingGlobstar) {
            effectiveNormalized = normalized.slice(0, -3);
        }

        let pattern = effectiveNormalized
            .replace(/\*\*/g, doubleStarPlaceholder)
            .replace(/\*/g, singleStarPlaceholder)
            .replace(/\?/g, questionPlaceholder)
            .replace(/([.+^${}()|[\]\\])/g, '\\$1')
            .replace(new RegExp(doubleStarPlaceholder, 'g'), '.*')
            .replace(new RegExp(singleStarPlaceholder, 'g'), '[^/]*')
            .replace(new RegExp(questionPlaceholder, 'g'), '.');
            
        if (hasTrailingGlobstar) {
            pattern = `${pattern}(?:/.*)?`;
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
        const matchesExclude = excludeRegexes?.some(regex => {
            const matched = regex.test(normalized);
            return matched;
        }) ?? false;
        
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

    public async searchFilenames(
        query: string,
        options: {
            fuzzyFilename?: boolean;
            filenameOnly?: boolean;
            maxResults?: number;
        } = {}
    ): Promise<SearchProjectResultEntry[]> {
        const allFiles = await this.fileSystem.listFiles(this.rootPath);
        const { fuzzyFilename = true, filenameOnly = false, maxResults = 20 } = options;

        const matches = allFiles
            .map((filepath: string) => ({
                filepath,
                filename: path.basename(filepath),
                score: this.filenameScorer.calculateFilenameScore(
                    filepath,
                    query,
                    { fuzzy: fuzzyFilename, basenameOnly: filenameOnly }
                )
            }))
            .filter((match: { score: number }) => match.score > 0)
            .sort((a: { score: number }, b: { score: number }) => b.score - a.score)
            .slice(0, maxResults);

        return matches.map((match: { filepath: string, filename: string, score: number }) => ({
            type: "filename",
            path: match.filepath,
            score: match.score / 100,
            context: `File: ${match.filename}`,
            line: undefined
        }));
    }

    private buildKeywordConstraints(rawKeywords: string[], options: { caseSensitive: boolean; smartCase: boolean }): KeywordConstraint[] {
        const smartCase = options.smartCase !== false;
        return rawKeywords
            .map(keyword => keyword.trim())
            .filter(keyword => keyword.length > 0)
            .map(raw => {
                const requiresCaseSensitive = options.caseSensitive || (smartCase && /[A-Z]/.test(raw));
                return {
                    raw,
                    normalized: raw.toLowerCase(),
                    requiresCaseSensitive
                };
            });
    }

    private findKeywordMatches(
        content: string,
        keywords: KeywordConstraint[],
        options: { wordBoundary: boolean; caseSensitive: boolean },
        limit: number
    ): { lineNumber: number; occurrences: number }[] {
        if (keywords.length === 0) {
            return [];
        }

        const lines = content.split(/\r?\n/);
        const matches: { lineNumber: number; occurrences: number }[] = [];
        const regexes = keywords.map(keyword => {
            const needle = keyword.requiresCaseSensitive ? keyword.raw : keyword.normalized;
            const flags = (keyword.requiresCaseSensitive || options.caseSensitive) ? 'g' : 'gi';
            return new RegExp(this.escapeRegExp(needle, { wordBoundary: options.wordBoundary }), flags);
        });

        for (let index = 0; index < lines.length && matches.length < limit; index++) {
            const line = lines[index];
            let occurrences = 0;
            for (const regex of regexes) {
                regex.lastIndex = 0;
                const lineMatches = [...line.matchAll(regex)];
                occurrences += lineMatches.length;
            }

            if (occurrences > 0) {
                matches.push({ lineNumber: index + 1, occurrences });
            }
        }

        return matches;
    }

    private findPatternMatches(content: string, patterns: string[], limit: number): number[] {
        if (!patterns || patterns.length === 0) {
            return [];
        }
        const regexes: RegExp[] = [];
        for (const pattern of patterns) {
            try {
                regexes.push(new RegExp(pattern, 'i'));
            } catch {
                continue;
            }
        }

        const lines = content.split(/\r?\n/);
        const matches: number[] = [];
        for (let index = 0; index < lines.length && matches.length < limit; index++) {
            const line = lines[index];
            for (const regex of regexes) {
                regex.lastIndex = 0;
                if (regex.test(line)) {
                    matches.push(index + 1);
                    break;
                }
            }
        }

        return matches;
    }

    private extractLinePreview(content: string, lineNumber: number, snippetLength: number): string {
        const lines = content.split(/\r?\n/);
        const line = lines[lineNumber - 1] ?? '';
        if (snippetLength <= 0) {
            return '';
        }
        if (line.length <= snippetLength) {
            return line;
        }
        return line.slice(0, snippetLength);
    }
}
