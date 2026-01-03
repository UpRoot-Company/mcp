import path from "path";
import { exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs/promises';
import { QueryTokenizer } from "./QueryTokenizer.js";
import { BM25FRanking, BM25FConfig } from "./Ranking.js";
import { FileSearchResult, Document, ResourceBudget, ResourceUsage, SearchOptions, SearchProjectResultEntry, SymbolIndex } from "../types.js";
import { TrigramIndex, TrigramIndexOptions } from "./TrigramIndex.js";
import { IFileSystem } from "../platform/FileSystem.js";
import { CallGraphMetricsBuilder, CallGraphSignals } from "./CallGraphMetricsBuilder.js";
import { CallGraphBuilder } from "../ast/CallGraphBuilder.js";
import { HybridScorer } from './scoring/HybridScorer.js';
import { CandidateCollector } from './search/CandidateCollector.js';
import { ResultProcessor } from './search/ResultProcessor.js';
import { FilenameScorer } from './scoring/FilenameScorer.js';
import { CommentParser } from '../utils/CommentParser.js';
import { DependencyGraph } from "../ast/DependencyGraph.js";
import { QueryIntentDetector } from './search/QueryIntent.js';
import { createLogger } from "../utils/StructuredLogger.js";
import { metrics } from "../utils/MetricsCollector.js";
import { SymbolEmbeddingIndex } from '../indexing/SymbolEmbeddingIndex.js';
import { IntentToSymbolMapper } from './IntentToSymbolMapper.js';

const execAsync = promisify(exec);

const BUILTIN_EXCLUDE_GLOBS = [
    "**/node_modules/**",
    "**/.git/**",
    "**/.mcp/**",
    "**/.smart-context/**",
    ".smart-context/**",
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
    budget?: ResourceBudget;
    usage?: ResourceUsage;
}

export interface SearchEngineOptions {
    maxPreviewLength?: number;
    maxMatchesPerFile?: number;
    trigram?: TrigramIndexOptions;
    symbolIndex?: SymbolIndex;
    symbolEmbeddingIndex?: SymbolEmbeddingIndex;
    fieldWeights?: BM25FConfig["fieldWeights"];
    callGraphBuilder?: CallGraphBuilder;
    dependencyGraph?: DependencyGraph;
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
    private readonly dependencyGraph?: DependencyGraph;
    private readonly queryTokenizer: QueryTokenizer;
    private readonly callGraphMetricsBuilder?: CallGraphMetricsBuilder;
    private callGraphSignals?: Map<string, CallGraphSignals>;
    private readonly logger = createLogger("Search");

    private hybridScorer: HybridScorer;
    private candidateCollector: CandidateCollector;
    private resultProcessor: ResultProcessor;
    private filenameScorer: FilenameScorer;
    private commentParser: CommentParser;
    private queryIntentDetector: QueryIntentDetector;
    private readonly symbolEmbeddingIndex?: SymbolEmbeddingIndex;
    private readonly intentToSymbolMapper?: IntentToSymbolMapper;

    constructor(rootPath: string, fileSystem: IFileSystem, initialExcludeGlobs: string[] = [], options: SearchEngineOptions = {}) {
        this.rootPath = path.resolve(rootPath);
        this.fileSystem = fileSystem;
        this.bm25Ranking = new BM25FRanking({ fieldWeights: options.fieldWeights });
        const combined = [...BUILTIN_EXCLUDE_GLOBS, ...initialExcludeGlobs];
        this.defaultExcludeGlobs = Array.from(new Set(combined));
        this.maxPreviewLength = options.maxPreviewLength ?? DEFAULT_PREVIEW_LENGTH;
        this.maxMatchesPerFile = options.maxMatchesPerFile ?? DEFAULT_MATCHES_PER_FILE;
        this.symbolIndex = options.symbolIndex;
        this.dependencyGraph = options.dependencyGraph;
        this.callGraphMetricsBuilder = options.callGraphBuilder
            ? new CallGraphMetricsBuilder(options.callGraphBuilder)
            : undefined;
        this.queryTokenizer = new QueryTokenizer();

        const trigramEnabledEnv = (process.env.SMART_CONTEXT_TRIGRAM_ENABLED ?? '').trim().toLowerCase();
        const trigramModeEnv = (process.env.SMART_CONTEXT_TRIGRAM_INDEX ?? '').trim().toLowerCase();
        const trigramEnabled = trigramModeEnv === 'disabled'
            ? false
            : (trigramEnabledEnv === 'false' ? false : true);

        const trigramMaxFileBytesRaw = (process.env.SMART_CONTEXT_TRIGRAM_MAX_FILE_BYTES ?? '').trim();
        const trigramMaxFileBytes = trigramMaxFileBytesRaw.length > 0
            ? Number.parseInt(trigramMaxFileBytesRaw, 10)
            : undefined;

        const trigramExtensionsRaw = (process.env.SMART_CONTEXT_TRIGRAM_INCLUDE_EXTENSIONS ?? '').trim();
        const trigramIncludeExtensions = trigramExtensionsRaw.length > 0
            ? trigramExtensionsRaw.split(',').map(s => s.trim()).filter(Boolean)
            : undefined;

        const trigramMaxDocFreqRaw = (process.env.SMART_CONTEXT_TRIGRAM_MAX_DOC_FREQ ?? '').trim();
        const trigramMaxDocFreq = trigramMaxDocFreqRaw.length > 0
            ? Number.parseFloat(trigramMaxDocFreqRaw)
            : undefined;

        const trigramMaxTermsRaw = (process.env.SMART_CONTEXT_TRIGRAM_MAX_TERMS_PER_FILE ?? '').trim();
        const trigramMaxTermsPerFile = trigramMaxTermsRaw.length > 0
            ? Number.parseInt(trigramMaxTermsRaw, 10)
            : undefined;

        this.trigramIndex = new TrigramIndex(this.rootPath, this.fileSystem, {
            ignoreGlobs: this.defaultExcludeGlobs,
            enabled: trigramEnabled,
            ...(Number.isFinite(trigramMaxFileBytes as any) && (trigramMaxFileBytes as number) > 0
                ? { maxFileBytes: trigramMaxFileBytes as number }
                : {}),
            ...(Array.isArray(trigramIncludeExtensions) && trigramIncludeExtensions.length > 0
                ? { includeExtensions: trigramIncludeExtensions }
                : {}),
            ...(Number.isFinite(trigramMaxDocFreq as any) && (trigramMaxDocFreq as number) > 0
                ? { maxDocFreq: trigramMaxDocFreq as number }
                : {}),
            ...(Number.isFinite(trigramMaxTermsPerFile as any) && (trigramMaxTermsPerFile as number) > 0
                ? { maxTermsPerFile: trigramMaxTermsPerFile as number }
                : {}),
            ...options.trigram
        });

        // Initialize extracted components
        this.filenameScorer = new FilenameScorer();
        this.commentParser = new CommentParser();
        this.queryIntentDetector = new QueryIntentDetector();
        
        // Initialize symbol embedding components for Phase 1 Smart Fuzzy Match
        this.symbolEmbeddingIndex = options.symbolEmbeddingIndex;
        if (this.symbolEmbeddingIndex) {
            this.intentToSymbolMapper = new IntentToSymbolMapper(this.symbolEmbeddingIndex);
            this.logger.info('[Search] Symbol embedding search enabled');
        }
        
        this.hybridScorer = new HybridScorer(
            this.rootPath,
            this.fileSystem,
            this.trigramIndex,
            this.bm25Ranking,
            this.symbolIndex,
            this.dependencyGraph
        );
        
        this.candidateCollector = new CandidateCollector(
            this.rootPath,
            this.trigramIndex,
            this.symbolIndex,
            this.fileSystem
        );
        
        this.resultProcessor = new ResultProcessor();
    }

    public async dispose(): Promise<void> {
        await this.trigramIndex.dispose();
    }

    public async updateExcludeGlobs(patterns: string[]): Promise<void> {
        const combined = [...BUILTIN_EXCLUDE_GLOBS, ...patterns];
        this.defaultExcludeGlobs = Array.from(new Set(combined));
        await this.trigramIndex.updateIgnoreGlobs(this.defaultExcludeGlobs);
    }

    public getExcludeGlobs(): string[] {
        return [...this.defaultExcludeGlobs];
    }

    public async warmup(): Promise<void> {
        await this.trigramIndex.ensureReady();
    }

    public async rebuild(options?: { logEvery?: number; logger?: (message: string) => void; logTotals?: boolean }): Promise<void> {
        await this.trigramIndex.rebuild(options);
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
        const escaped = value.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&");
        return options.wordBoundary ? `\\b${escaped}\\b` : escaped;
    }

    public async scout(args: ScoutArgs): Promise<FileSearchResult[]> {
        const stopTotal = metrics.startTimer("search.scout.total_ms");
        const { query, includeGlobs, excludeGlobs, basePath, patterns } = args;
        const budget = args.budget;
        const usage = args.usage ?? (budget ? { filesRead: 0, bytesRead: 0, parseTimeMs: 0 } : undefined);
        const startedAt = Date.now();

        try {
            if (!query && (!args.keywords || args.keywords.length === 0) && (!patterns || patterns.length === 0)) {
                throw new Error("A query string, keyword, or pattern is required.");
            }

        const smartCase = args.smartCase ?? true;
        const caseSensitive = Boolean(args.caseSensitive);
        let wordBoundary = Boolean(args.wordBoundary);

        const keywordSource = query && query.trim().length > 0
            ? this.queryTokenizer.tokenize(query)
            : (args.keywords ?? []).filter((kw): kw is string => typeof kw === "string" && kw.trim().length > 0);

        const keywordConstraints = this.buildKeywordConstraints(keywordSource, { caseSensitive, smartCase });
        const normalizedKeywords = keywordConstraints.map(keyword => keyword.normalized);
        const keywordLabels = keywordConstraints.map(keyword => keyword.raw);

        const effectiveQuery = query || keywordSource.join(' ');
        const normalizedQuery = effectiveQuery ? this.queryTokenizer.normalize(effectiveQuery) : '';
        const intent = this.queryIntentDetector.detect(effectiveQuery);
        if (intent === "symbol" && args.wordBoundary === undefined) {
            wordBoundary = true;
        }

        this.logger.debug(`[Search] Hybrid search for query: "${effectiveQuery}" (intent: ${intent}, keywords: ${keywordLabels.join(', ')})`);

        const combinedExcludeGlobs = [...this.defaultExcludeGlobs, ...(excludeGlobs || [])];
        const includeRegexes = includeGlobs && includeGlobs.length > 0
            ? includeGlobs.map(glob => this.globToRegExp(glob))
            : undefined;
        const excludeRegexes = combinedExcludeGlobs.map(glob => this.globToRegExp(glob));

        const previewLength = this.normalizeSnippetLength(args.snippetLength);
        const matchesPerFileLimit = args.matchesPerFile ?? this.maxMatchesPerFile;

        const stopCollectCandidates = metrics.startTimer("search.scout.collect_candidates_ms");
        let candidates = await this.candidateCollector.collectHybridCandidates(normalizedKeywords);

        // Phase 1 Smart Fuzzy Match: Symbol-based search for symbol queries
        if (intent === "symbol" && this.intentToSymbolMapper && this.symbolEmbeddingIndex) {
            try {
                const stopSymbolSearch = metrics.startTimer("search.scout.symbol_search_ms");
                const symbolResults = await this.intentToSymbolMapper.mapToSymbols(effectiveQuery, {
                    maxResults: args.maxResults ?? 20,
                    minConfidence: 0.3,
                });
                stopSymbolSearch();

                if (symbolResults.length > 0) {
                    this.logger.debug(`[Search] Symbol search found ${symbolResults.length} results, adding to candidates`);
                    
                    // Add symbol file locations to candidates
                    for (const result of symbolResults) {
                        const relativePath = path.relative(this.rootPath, result.symbol.filePath);
                        candidates.add(relativePath);
                    }
                    
                    // Log top symbol results for debugging
                    symbolResults.slice(0, 3).forEach(r => {
                        this.logger.debug(`  - ${r.symbol.name} (${r.symbol.type}) in ${r.symbol.filePath} [score: ${r.relevanceScore.toFixed(3)}]`);
                    });
                }
            } catch (error) {
                this.logger.warn(`[Search] Symbol search failed, falling back to text search`, { 
                    error: error instanceof Error ? error.message : String(error) 
                });
            }
        }

        if (candidates.size === 0) {
            const fallbackCandidates = await this.candidateCollector.collectFilesystemCandidates(
                basePath ? path.resolve(basePath) : this.rootPath,
                (relativePath) => this.shouldInclude(relativePath, includeRegexes, excludeRegexes)
            );
            if (fallbackCandidates.size > 0) {
                candidates = fallbackCandidates;
                this.logger.debug(`[Search] Added ${fallbackCandidates.size} fallback candidates via filesystem scan, total: ${candidates.size}`);
            }
        }
        stopCollectCandidates();

        if (patterns && patterns.length > 0 && candidates.size < 1000) {
            const allFiles = this.trigramIndex.listFiles();
            for (const file of allFiles) candidates.add(file);
        }

        this.logger.debug(`[Search] Collected ${candidates.size} candidates`);

        const documents: Document[] = [];
        const candidateEntries: Array<{ absPath: string, relativeToBase: string }> = [];

        // 1. Gather all document contents for collection-wide BM25 in parallel batches
        if (usage) {
            usage.candidates = candidates.size;
        }
        let candidateList = Array.from(candidates);
        if (budget && candidates.size > budget.maxCandidates) {
            if (usage) {
                usage.degraded = true;
                usage.reason = usage.reason ?? 'max_candidates';
            }
            candidateList = candidateList.slice(0, budget.maxCandidates);
        }
        const CHUNK_SIZE = 50;
        let stop = false;
        
        const stopReadFiles = metrics.startTimer("search.scout.read_files_ms");
        try {
            for (let i = 0; i < candidateList.length; i += CHUNK_SIZE) {
                if (budget && usage) {
                    const elapsed = Date.now() - startedAt;
                    if (usage.filesRead >= budget.maxFilesRead || usage.bytesRead >= budget.maxBytesRead || elapsed >= budget.maxParseTimeMs) {
                        usage.degraded = true;
                        usage.reason = usage.reason ?? 'budget_exceeded';
                        stop = true;
                    }
                }
                if (stop) break;
                const chunk = candidateList.slice(i, i + CHUNK_SIZE);
                const chunkResults = await Promise.all(chunk.map(async (candidatePath) => {
                    const absPath = path.isAbsolute(candidatePath)
                        ? candidatePath
                        : path.join(this.rootPath, candidatePath);

                    const relativeToBase = this.normalizeRelativePath(absPath, basePath ? path.resolve(basePath) : this.rootPath);
                    if (!relativeToBase || !this.shouldInclude(relativeToBase, includeRegexes, excludeRegexes)) {
                        return null;
                    }

                    try {
                        const content = await this.fileSystem.readFile(absPath);
                        if (usage) {
                            usage.filesRead += 1;
                            usage.bytesRead += Buffer.byteLength(content, 'utf8');
                        }
                        return { absPath, relativeToBase, content };
                    } catch {
                        return null;
                    }
                }));

                for (const res of chunkResults) {
                    if (res) {
                        documents.push({ id: res.absPath, text: res.content, filePath: res.relativeToBase, score: 0 });
                        candidateEntries.push({ absPath: res.absPath, relativeToBase: res.relativeToBase });
                    }
                }
            }
        } finally {
            stopReadFiles();
        }

        const stopRank = metrics.startTimer("search.scout.rank_bm25_ms");
        const bm25Results = this.bm25Ranking.rank(documents, effectiveQuery);
        stopRank();
        const bm25ScoreMap = new Map(bm25Results.map(d => [d.id, d.scoreDetails?.contentScore ?? 0]));
        const contentMap = new Map(documents.map(d => [d.id, d.text]));

        const fileSearchResults: FileSearchResult[] = [];

        // 3. Combine BM25 with other signals using HybridScorer in parallel batches
        const stopHybrid = metrics.startTimer("search.scout.hybrid_score_ms");
        try {
            for (let i = 0; i < candidateEntries.length; i += CHUNK_SIZE) {
                if (budget && usage) {
                    const elapsed = Date.now() - startedAt;
                    if (elapsed >= budget.maxParseTimeMs) {
                        usage.degraded = true;
                        usage.reason = usage.reason ?? 'budget_exceeded';
                        break;
                    }
                }
                const chunk = candidateEntries.slice(i, i + CHUNK_SIZE);
                const chunkScores = await Promise.all(chunk.map(async ({ absPath, relativeToBase }) => {
                    const content = contentMap.get(absPath) || "";
                    const contentScoreRaw = bm25ScoreMap.get(absPath) || 0;

                    try {
                        const hybridScore = await this.hybridScorer.scoreFile(
                            absPath,
                            content,
                            normalizedKeywords,
                            normalizedQuery,
                            contentScoreRaw,
                            intent,
                            patterns,
                            { wordBoundary, caseSensitive }
                        );
                        return { relativeToBase, hybridScore };
                    } catch {
                        return null;
                    }
                }));

                for (const res of chunkScores) {
                    if (!res) continue;
                    const { relativeToBase, hybridScore } = res;

                    const CORE_SIGNALS = ['content', 'filename', 'symbol', 'comment', 'pattern'];
                    const hasCoreSignal = hybridScore.signals.some(s => CORE_SIGNALS.includes(s));
                    const hasExplicitMatch = hybridScore.matches.length > 0 || 
                                           hybridScore.breakdown.filename > 0 || 
                                           hybridScore.breakdown.symbol > 0;

                    if (hybridScore.total > 0 && hasCoreSignal && hasExplicitMatch) {
                        if (hybridScore.matches.length > 0) {
                            const limitedMatches = hybridScore.matches.slice(0, matchesPerFileLimit);
                            for (const match of limitedMatches) {
                                fileSearchResults.push({
                                    filePath: relativeToBase,
                                    lineNumber: match.line,
                                    preview: match.content.trim().slice(0, previewLength),
                                    score: hybridScore.total,
                                    scoreDetails: {
                                        type: hybridScore.signals.join('+'),
                                        details: Object.entries(hybridScore.breakdown).map(([type, score]) => ({ type, score: score as number })),
                                        totalScore: hybridScore.total,
                                        contentScore: hybridScore.breakdown.content,
                                        filenameMultiplier: hybridScore.breakdown.filenameMatchType === 'exact' ? 10 : (hybridScore.breakdown.filenameMatchType === 'partial' ? 5 : 1),
                                        depthMultiplier: 1,
                                        fieldWeight: 1,
                                        filenameMatchType: hybridScore.breakdown.filenameMatchType
                                    }
                                });
                            }
                        } else {
                            fileSearchResults.push({
                                filePath: relativeToBase,
                                lineNumber: 0,
                                preview: "",
                                score: hybridScore.total,
                                scoreDetails: {
                                    type: hybridScore.signals.join('+'),
                                    details: Object.entries(hybridScore.breakdown).map(([type, score]) => ({ type, score: score as number })),
                                    totalScore: hybridScore.total,
                                    contentScore: hybridScore.breakdown.content,
                                    filenameMultiplier: hybridScore.breakdown.filenameMatchType === 'exact' ? 10 : (hybridScore.breakdown.filenameMatchType === 'partial' ? 5 : 1),
                                    depthMultiplier: 1,
                                    fieldWeight: 1,
                                    filenameMatchType: hybridScore.breakdown.filenameMatchType
                                }
                            });
                        }
                    }
                }
            }
        } finally {
            stopHybrid();
        }

        fileSearchResults.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
        this.logger.debug(`[Search] Returning ${fileSearchResults.length} results`);
        metrics.gauge("search.scout.results_count", fileSearchResults.length);
        if (usage) {
            usage.parseTimeMs = Date.now() - startedAt;
        }

        return this.resultProcessor.postProcessResults(fileSearchResults, {
            fileTypes: args.fileTypes,
            snippetLength: previewLength,
            groupByFile: args.groupByFile,
            deduplicateByContent: args.deduplicateByContent
        });
        } finally {
            stopTotal();
        }
    }

    private normalizeSnippetLength(requested?: number): number {
        if (typeof requested === "number" && Number.isFinite(requested)) {
            if (requested <= 0) return 0;
            return Math.min(2000, Math.max(16, Math.floor(requested)));
        }
        return this.maxPreviewLength;
    }

    private globToRegExp(glob: string): RegExp {
        const normalized = glob.replace(/\\/g, '/').replace(/^\.\//, '');
        if (!normalized.includes('/') && !/[?*]/.test(normalized)) {
            const escaped = normalized.replace(/[-/\\^$+?.()|[\\]{}]/g, "\\$&");
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
            .replace(/([.+^${}()|[\]\\])/g, "\\$1")
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
        const matchesExclude = excludeRegexes?.some(regex => regex.test(normalized)) ?? false;
        
        if (matchesExclude && !(hasIncludePatterns && matchesInclude)) {
            return false;
        }
        return true;
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
}
