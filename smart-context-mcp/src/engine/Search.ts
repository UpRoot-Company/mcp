import path from "path";
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import { QueryTokenizer } from "./QueryTokenizer.js";
const execAsync = promisify(exec);
import { BM25FRanking, BM25FConfig } from "./Ranking.js";
import { FileSearchResult, Document, SearchOptions, SearchFieldType, SearchProjectResultEntry, SymbolInfo } from "../types.js";
import { TrigramIndex, TrigramIndexOptions } from "./TrigramIndex.js";
import { IFileSystem } from "../platform/FileSystem.js";
import { CallGraphMetricsBuilder, CallGraphSignals } from "./CallGraphMetricsBuilder.js";
import { CallGraphBuilder } from "../ast/CallGraphBuilder.js";

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

export interface SymbolIndex {
    getSymbolsForFile(filePath: string): Promise<SymbolInfo[]>;
    getAllSymbols(): Promise<Map<string, SymbolInfo[]>>;
}

export interface SearchEngineOptions {
    maxPreviewLength?: number;
    maxMatchesPerFile?: number;
    trigram?: TrigramIndexOptions;
    symbolIndex?: SymbolIndex;
    fieldWeights?: BM25FConfig["fieldWeights"];
    callGraphBuilder?: CallGraphBuilder;
}

interface ScoredMatch {
    path: string;
    score: number;
    matchType: string;
    preview: string;
    breakdown?: ScoreBreakdown;
}

interface ScoreBreakdown {
    content: number;
    filename: number;
    symbol: number;
    comment: number;
    pattern: number;
    filenameMatchType: "exact" | "partial" | "none";
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
        // No longer dropping symbol metadata here, as symbolIndex handles its own caching/invalidation
        this.callGraphSignals = undefined;
    }

    public async invalidateDirectory(absDir: string): Promise<void> {
        await this.trigramIndex.refreshDirectory(absDir);
        // No longer dropping symbol metadata here, as symbolIndex handles its own caching/invalidation
        this.callGraphSignals = undefined;
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

        const candidates = await this.collectHybridCandidates(normalizedKeywords);

        if (patterns && patterns.length > 0 && candidates.size < 1000) {
            const allFiles = this.trigramIndex.listFiles();
            for (const file of allFiles) candidates.add(file);
        }

        console.log(`[Search] Collected ${candidates.size} candidates`);

        const contentCache = new Map<string, string>();
        const scoredResults: ScoredMatch[] = [];

        for (const candidatePath of candidates) {
            const absPath = path.isAbsolute(candidatePath)
                ? candidatePath
                : path.join(this.rootPath, candidatePath);

            const relativeToBase = this.normalizeRelativePath(absPath, basePath ? path.resolve(basePath) : this.rootPath);
            if (!relativeToBase || !this.shouldInclude(relativeToBase, includeRegexes, excludeRegexes)) {
                continue;
            }

            if (shouldApplyKeywordFilter) {
                const matchesConstraints = await this.matchesKeywordConstraints(
                    absPath,
                    relativeToBase,
                    keywordConstraints,
                    { wordBoundary },
                    contentCache
                );
                if (!matchesConstraints) {
                    continue;
                }
            }

            const scoreResult = await this.calculateHybridScore(absPath, normalizedKeywords, normalizedQuery, patterns);

            if (scoreResult.total > 0) {
                scoredResults.push({
                    path: relativeToBase,
                    score: scoreResult.total,
                    matchType: scoreResult.signals.join('+'),
                    preview: await this.generatePreview(absPath, normalizedKeywords),
                    breakdown: scoreResult.breakdown
                });
            }
        }

        scoredResults.sort((a, b) => b.score - a.score);

        const topResults = scoredResults.slice(0, args.maxResults || 20);
        console.log(`[Search] Returning ${topResults.length} results`);

        const fileSearchResults: FileSearchResult[] = [];
        for (const result of topResults) {
            const breakdown = result.breakdown;
            const filenameMatchType = breakdown?.filenameMatchType ?? "none";
            const filenameMultiplier = filenameMatchType === "exact"
                ? 10
                : filenameMatchType === "partial"
                    ? 5
                    : 1;

            fileSearchResults.push({
                filePath: result.path,
                lineNumber: 1,
                preview: result.preview,
                score: result.score,
                scoreDetails: {
                    type: result.matchType,
                    details: [{ type: result.matchType, score: result.score }],
                    totalScore: result.score,
                    contentScore: breakdown?.content ?? 0,
                    filenameMultiplier,
                    depthMultiplier: 1,
                    fieldWeight: 1,
                    filenameMatchType
                }
            });
        }

        return this.postProcessResults(fileSearchResults, {
            fileTypes: args.fileTypes,
            snippetLength: previewLength,
            groupByFile: args.groupByFile,
            deduplicateByContent: args.deduplicateByContent
        });
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

    private postProcessResults(
        results: FileSearchResult[],
        options: {
            fileTypes?: string[];
            snippetLength: number;
            groupByFile?: boolean;
            deduplicateByContent?: boolean;
        }
    ): FileSearchResult[] {
        let processed = this.filterByFileType(results, options.fileTypes);

        if (options.deduplicateByContent) {
            processed = this.deduplicateByContent(processed);
        }

        processed = this.applySnippetLength(processed, options.snippetLength);

        if (options.groupByFile) {
            processed = this.groupResultsByFile(processed);
        }

        return processed;
    }

    private filterByFileType(results: FileSearchResult[], fileTypes?: string[]): FileSearchResult[] {
        if (!fileTypes || fileTypes.length === 0) {
            return results;
        }
        const normalized = new Set(fileTypes.map(ext => ext.replace(/^\./, "").toLowerCase()));
        return results.filter(result => {
            const fileExt = path.extname(result.filePath).replace(".", "").toLowerCase();
            return fileExt ? normalized.has(fileExt) : false;
        });
    }

    private applySnippetLength(results: FileSearchResult[], snippetLength: number): FileSearchResult[] {
        if (snippetLength <= 0) {
            return results.map(result => ({ ...result, preview: "" }));
        }
        return results.map(result => {
            if (!result.preview || result.preview.length <= snippetLength) {
                return result;
            }
            const sliceLength = Math.max(1, snippetLength - 1);
            return {
                ...result,
                preview: `${result.preview.slice(0, sliceLength)}…`
            };
        });
    }

    private deduplicateByContent(results: FileSearchResult[]): FileSearchResult[] {
        const seen = new Set<string>();
        const deduped: FileSearchResult[] = [];
        for (const result of results) {
            const fallback = `${result.filePath}:${result.lineNumber}`;
            const key = result.preview?.length ? result.preview : fallback;
            if (seen.has(key)) {
                continue;
            }
            seen.add(key);
            deduped.push(result);
        }
        return deduped;
    }

    private groupResultsByFile(results: FileSearchResult[]): FileSearchResult[] {
        const grouped = new Map<string, FileSearchResult[]>();
        const order: string[] = [];
        for (const result of results) {
            if (!grouped.has(result.filePath)) {
                grouped.set(result.filePath, []);
                order.push(result.filePath);
            }
            grouped.get(result.filePath)!.push(result);
        }

        return order.map(filePath => {
            const matches = grouped.get(filePath)!;
            const sorted = matches.slice().sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
            const primary = { ...sorted[0] };
            primary.groupedMatches = sorted.map(match => ({
                lineNumber: match.lineNumber,
                preview: match.preview,
                score: match.score,
                scoreDetails: match.scoreDetails
            }));
            primary.matchCount = sorted.length;
            return primary;
        });
    }

    private async collectHybridCandidates(keywords: string[]): Promise<Set<string>> {
        const candidates = new Set<string>();

        // Source 1: Trigram index (existing)
        const trigramQuery = keywords.join(' ');
        const trigramResults = await this.trigramIndex.search(trigramQuery, MAX_CANDIDATE_FILES * 2);
        for (const result of trigramResults) {
            candidates.add(result.filePath);
        }
        console.log(`[Search] Trigram candidates: ${trigramResults.length}`);

        // Source 2: Filename matching
        const filenameMatches = this.findByFilename(keywords);
        for (const path of filenameMatches) {
            candidates.add(path);
        }
        console.log(`[Search] Filename matches: ${filenameMatches.length}`);

        // Source 3: Symbol index
        if (this.symbolIndex) {
            const symbolMatches = await this.findBySymbolName(keywords);
            for (const path of symbolMatches) {
                candidates.add(path);
            }
            console.log(`[Search] Symbol matches: ${symbolMatches.length}`);
        }

        // Source 4: Fallback
        if (candidates.size < 20) {
            const allFiles = this.trigramIndex.listFiles();
            const fallback = allFiles.slice(0, MAX_CANDIDATE_FILES * 3);
            for (const file of fallback) {
                candidates.add(file);
            }
            console.log(`[Search] Added ${fallback.length} fallback candidates, total: ${candidates.size}`);
        }

        return candidates;
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

    private async matchesKeywordConstraints(
        filePath: string,
        relativePath: string,
        keywords: KeywordConstraint[],
        options: { wordBoundary: boolean },
        cache: Map<string, string>
    ): Promise<boolean> {
        if (keywords.length === 0) {
            return true;
        }

        const relativeSegment = relativePath && relativePath.length > 0
            ? relativePath
            : path.relative(this.rootPath, filePath) || path.basename(filePath);
        const canonicalPath = relativeSegment.replace(/\\/g, '/');
        const canonicalLowerPath = canonicalPath.toLowerCase();

        let content = cache.get(filePath);

        for (const keyword of keywords) {
            const needle = keyword.requiresCaseSensitive ? keyword.raw : keyword.normalized;
            if (!needle) {
                continue;
            }

            const pathHaystack = keyword.requiresCaseSensitive ? canonicalPath : canonicalLowerPath;
            if (pathHaystack.includes(needle)) {
                return true;
            }

            if (!content) {
                try {
                    content = await this.fileSystem.readFile(filePath);
                    cache.set(filePath, content);
                } catch {
                    return false;
                }
            }

            const pattern = this.escapeRegExp(needle, { wordBoundary: options.wordBoundary });
            const flags = keyword.requiresCaseSensitive ? '' : 'i';
            const regex = new RegExp(pattern, flags);
            if (regex.test(content)) {
                return true;
            }
        }

        return false;
    }

    private async calculateHybridScore(
        filePath: string,
        keywords: string[],
        normalizedQuery: string,
        patterns?: string[]
    ): Promise<{
        total: number;
        signals: string[];
        breakdown: {
            content: number;
            filename: number;
            symbol: number;
            comment: number;
            pattern: number;
            filenameMatchType: "exact" | "partial" | "none";
        }
    }> {
        let totalScore = 0;
        const signals: string[] = [];
        const breakdown = {
            content: 0,
            filename: 0,
            symbol: 0,
            comment: 0,
            pattern: 0,
            filenameMatchType: "none" as "exact" | "partial" | "none"
        };

        // Signal 1: Trigram content similarity
        if (normalizedQuery) {
            const trigramScore = await this.getTrigramScore(filePath, normalizedQuery);
            if (trigramScore > 0) {
                totalScore += trigramScore * 0.5;
                breakdown.content = trigramScore * 0.5;
                signals.push('content');
            }
        }

        // Signal 2: Filename matching
        if (keywords.length > 0) {
            const matchType = this.scoreFilename(filePath, keywords);
            if (matchType !== "none") {
                const filenameWeight = matchType === "exact" ? 2 : 1;
                const filenameScore = filenameWeight * 10;
                totalScore += filenameScore;
                breakdown.filename = filenameScore;
                breakdown.filenameMatchType = matchType;
                signals.push('filename');
            }
        }

        // Signal 3: Symbol name matching
        if (this.symbolIndex && keywords.length > 0) {
            const symbolScore = await this.scoreSymbols(filePath, keywords);
            if (symbolScore > 0) {
                totalScore += symbolScore * 8;
                breakdown.symbol = symbolScore * 8;
                signals.push('symbol');
            }
        }

        // Signal 4: Comment matching
        if (keywords.length > 0) {
            const commentScore = await this.scoreComments(filePath, keywords);
            if (commentScore > 0) {
                totalScore += commentScore * 3;
                breakdown.comment = commentScore * 3;
                signals.push('comment');
            }
        }
        
        // Signal 5: Patterns
        if (patterns && patterns.length > 0) {
            const patternScore = await this.scorePatterns(filePath, patterns);
            if (patternScore > 0) {
                totalScore += patternScore;
                breakdown.pattern = patternScore;
                signals.push('pattern');
            }
        }

        // Signal 6: Path depth penalty
        const depthPenalty = this.calculateDepthPenalty(filePath);
        totalScore -= depthPenalty;

        return { total: totalScore, signals, breakdown };
    }

    private async scorePatterns(filePath: string, patterns: string[]): Promise<number> {
        try {
            let total = 0;
            for (const pattern of patterns) {
                const matches = await this.runFileGrep(pattern, filePath);
                if (matches.length > 0) {
                    total += 100 * matches.length;
                }
            }
            return total;
        } catch {
            return 0;
        }
    }

    private findByFilename(keywords: string[]): string[] {
        const allFiles = this.trigramIndex.listFiles();
        const matches: string[] = [];

        for (const filePath of allFiles) {
            const basename = path.basename(filePath).toLowerCase();
            const dirname = path.dirname(filePath).toLowerCase();
            const fullPath = filePath.toLowerCase();

            const allMatch = keywords.every(kw => {
                const lowerKw = kw.toLowerCase();
                return basename.includes(lowerKw) ||
                    dirname.includes(lowerKw) ||
                    fullPath.includes(lowerKw);
            });

            if (allMatch) {
                matches.push(filePath);
            }
        }

        return matches;
    }

    private async findBySymbolName(keywords: string[]): Promise<string[]> {
        const matches = new Set<string>();
        if (!this.symbolIndex) {
            return [];
        }

        const allSymbols = await this.symbolIndex.getAllSymbols();
        for (const [filePath, symbols] of allSymbols.entries()) {
            for (const symbol of symbols) {
                const lowerSymbol = symbol.name.toLowerCase();
                for (const keyword of keywords) {
                    if (lowerSymbol.includes(keyword.toLowerCase())) {
                        matches.add(filePath);
                        break;
                    }
                }
            }
        }

        return Array.from(matches);
    }

    private scoreFilename(filePath: string, keywords: string[]): "exact" | "partial" | "none" {
        const baseName = path.basename(filePath).toLowerCase();
        const stem = path.basename(filePath, path.extname(filePath)).toLowerCase();
        let matchType: "exact" | "partial" | "none" = "none";

        for (const keyword of keywords) {
            const normalized = keyword.toLowerCase().trim();
            if (!normalized) {
                continue;
            }
            if (baseName === normalized || stem === normalized) {
                return "exact";
            }
            if (baseName.includes(normalized) || stem.includes(normalized)) {
                matchType = "partial";
            }
        }

        return matchType;
    }

    private async scoreSymbols(filePath: string, keywords: string[]): Promise<number> {
        if (!this.symbolIndex) {
            return 0;
        }
        try {
            const symbols = await this.symbolIndex.getSymbolsForFile(filePath);
            let score = 0;

            for (const symbol of symbols) {
                const lowerSymbol = symbol.name.toLowerCase();
                for (const keyword of keywords) {
                    const lowerKw = keyword.toLowerCase();
                    if (lowerSymbol === lowerKw) {
                        score += 8;
                    } else if (lowerSymbol.includes(lowerKw)) {
                        score += 4;
                    }
                }
            }

            return score;
        } catch (error) {
            return 0;
        }
    }

    private async scoreComments(filePath: string, keywords: string[]): Promise<number> {
        try {
            const content = await this.fileSystem.readFile(filePath);
            const comments = this.extractComments(content, filePath);

            let score = 0;
            for (const comment of comments) {
                const lowerComment = comment.toLowerCase();
                for (const keyword of keywords) {
                    if (lowerComment.includes(keyword.toLowerCase())) {
                        score += 3;
                    }
                }
            }

            return score;
        } catch (error) {
            return 0;
        }
    }

    private extractComments(content: string, filePath: string): string[] {
        const comments: string[] = [];
        const ext = path.extname(filePath);

        if (['.ts', '.tsx', '.js', '.jsx'].includes(ext)) {
            const singleLineRegex = /\/\/(.+)$/gm;
            let match;
            while ((match = singleLineRegex.exec(content)) !== null) {
                comments.push(match[1].trim());
            }

            const multiLineRegex = /\/\*([\s\S]*?)\*\//g;
            while ((match = multiLineRegex.exec(content)) !== null) {
                comments.push(match[1].trim());
            }
        }

        return comments;
    }

    private calculateDepthPenalty(filePath: string): number {
        const relativePath = path.relative(this.rootPath, filePath);
        const depth = relativePath.split(path.sep).length;
        return Math.max(0, (depth - 3) * 0.5);
    }

    private async getTrigramScore(filePath: string, query: string): Promise<number> {
        const content = await this.fileSystem.readFile(filePath);
        const document: Document = {
            id: filePath,
            text: content,
            filePath: filePath,
            score: 0
        };
        const ranked = this.bm25Ranking.rank([document], query);
        return ranked[0]?.score || 0;
    }

    private async generatePreview(filePath: string, keywords: string[]): Promise<string> {
        try {
            const content = await this.fileSystem.readFile(filePath);
            const lines = content.split('\n');

            let bestLine = '';
            let bestScore = -1;

            for (let i = 0; i < lines.length; i++) {
                const line = lines[i];
                const lowerLine = line.toLowerCase();
                let score = 0;
                for (const keyword of keywords) {
                    if (lowerLine.includes(keyword.toLowerCase())) {
                        score++;
                    }
                }
                if (score > bestScore) {
                    bestScore = score;
                    bestLine = line.trim();
                }
            }
            if (bestScore === -1) {
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i].trim();
                    if (line.length > 0) {
                        bestLine = line;
                        break;
                    }
                }
            }

            return bestLine.substring(0, this.maxPreviewLength);
        } catch (error) {
            return '';
        }
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
                score: this.calculateFilenameScore(
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

    private calculateFilenameScore(
        filepath: string,
        query: string,
        options: { fuzzy: boolean; basenameOnly: boolean }
    ): number {
        const target = options.basenameOnly
            ? path.basename(filepath)
            : filepath;

        const lowerTarget = target.toLowerCase();
        const lowerQuery = query.toLowerCase();

        // Exact match: highest score
        if (lowerTarget === lowerQuery) return 100;

        // Basename exact match
        if (path.basename(filepath).toLowerCase() === lowerQuery) return 90;

        // Starts with query
        if (lowerTarget.startsWith(lowerQuery)) return 80;

        // Contains query
        if (lowerTarget.includes(lowerQuery)) return 60;

        // Fuzzy matching (if enabled)
        if (options.fuzzy) {
            const distance = this.levenshteinDistance(lowerQuery, path.basename(filepath).toLowerCase());
            const maxLength = Math.max(lowerQuery.length, path.basename(filepath).length);
            const similarity = 1 - (distance / maxLength);

            if (similarity > 0.7) return similarity * 50;
        }

        return 0;
    }

    private levenshteinDistance(a: string, b: string): number {
        const matrix: number[][] = [];

        for (let i = 0; i <= b.length; i++) {
            matrix[i] = [i];
        }

        for (let j = 0; j <= a.length; j++) {
            matrix[0][j] = j;
        }

        for (let i = 1; i <= b.length; i++) {
            for (let j = 1; j <= a.length; j++) {
                if (b.charAt(i - 1) === a.charAt(j - 1)) {
                    matrix[i][j] = matrix[i - 1][j - 1];
                } else {
                    matrix[i][j] = Math.min(
                        matrix[i - 1][j - 1] + 1, // substitution
                        matrix[i][j - 1] + 1,     // insertion
                        matrix[i - 1][j] + 1      // deletion
                    );
                }
            }
        }

        return matrix[b.length][a.length];
    }
}
