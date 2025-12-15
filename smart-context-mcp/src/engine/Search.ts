import path from "path";
import { BM25FRanking, BM25FConfig } from "./Ranking.js";
import { FileSearchResult, Document, SearchOptions, SearchFieldType, SymbolInfo, SearchProjectResultEntry } from "../types.js";
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
    keywords?: string[];
    patterns?: string[];
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

export interface SymbolMetadataProvider {
    getSymbolsForFile(filePath: string): Promise<SymbolInfo[]>;
    getAllSymbols?(): Promise<Map<string, SymbolInfo[]>>;
}

export interface SearchEngineOptions {
    maxPreviewLength?: number;
    maxMatchesPerFile?: number;
    trigram?: TrigramIndexOptions;
    symbolMetadataProvider?: SymbolMetadataProvider;
    fieldWeights?: BM25FConfig["fieldWeights"];
    callGraphBuilder?: CallGraphBuilder;
}

export class SearchEngine {
    private readonly rootPath: string;
    private readonly fileSystem: IFileSystem;
    private readonly bm25Ranking: BM25FRanking;
    private defaultExcludeGlobs: string[];
    private readonly trigramIndex: TrigramIndex;
    private readonly maxPreviewLength: number;
    private readonly maxMatchesPerFile: number;
    private readonly symbolMetadataProvider?: SymbolMetadataProvider;
    private readonly symbolCache = new Map<string, SymbolInfo[]>();
    private readonly symbolLoaders = new Map<string, Promise<SymbolInfo[]>>();
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
        this.symbolMetadataProvider = options.symbolMetadataProvider;
        this.callGraphMetricsBuilder = options.callGraphBuilder
            ? new CallGraphMetricsBuilder(options.callGraphBuilder)
            : undefined;
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
        this.symbolCache.clear();
        this.symbolLoaders.clear();
        this.callGraphSignals = undefined;
    }

    public async invalidateFile(absPath: string): Promise<void> {
        await this.trigramIndex.refreshFile(absPath);
        this.dropSymbolMetadata(absPath);
        this.callGraphSignals = undefined;
    }

    public async invalidateDirectory(absDir: string): Promise<void> {
        await this.trigramIndex.refreshDirectory(absDir);
        this.dropSymbolMetadata(absDir, true);
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
        const { keywords, patterns, includeGlobs, excludeGlobs, gitDiffMode, basePath, wordBoundary, caseSensitive, smartCase } = args;

        if ((!keywords || keywords.length === 0) && (!patterns || patterns.length === 0)) {
            throw new Error("At least one keyword or pattern is required.");
        }

        if (gitDiffMode) {
            console.warn("gitDiffMode is not yet fully implemented.");
        }

        const queries = this.buildSearchQueries({ keywords, patterns, wordBoundary, caseSensitive, smartCase });
        const baseCwd = basePath ? path.resolve(basePath) : this.rootPath;
        const normalizedBase = baseCwd.startsWith(this.rootPath) ? baseCwd : this.rootPath;
        const combinedExcludeGlobs = [...this.defaultExcludeGlobs, ...(excludeGlobs || [])];
        const includeRegexes = includeGlobs && includeGlobs.length > 0
            ? includeGlobs.map(glob => this.globToRegExp(glob))
            : undefined;
        const excludeRegexes = combinedExcludeGlobs.map(glob => this.globToRegExp(glob));
        const previewLength = this.normalizeSnippetLength(args.snippetLength);
        const matchesPerFile = this.normalizeMatchesPerFile(args.matchesPerFile);

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
            const fileMatches = this.collectMatchesFromFile(normalizedRelative, content, queries, previewLength, matchesPerFile);
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
            const meta = fieldAssignments.get(docId);
            return {
                id: docId,
                text: match.preview,
                score: originScore,
                filePath: match.filePath,
                fieldType: meta?.fieldType,
                symbolId: meta?.symbolId
            };
        });
        const queryText = queries.map(q => q.raw).join(" ");
        const callGraphSignals = await this.getCallGraphSignals();
        const rankedDocuments = this.bm25Ranking.rank(documents, queryText, callGraphSignals);
        const rankedResults = rankedDocuments.map(doc => {
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
        return this.postProcessResults(rankedResults, {
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

    private buildSearchQueries(args: { keywords?: string[]; patterns?: string[]; wordBoundary?: boolean; caseSensitive?: boolean; smartCase?: boolean }): SearchQuery[] {
        const queries: SearchQuery[] = [];
        const useSmartCase = args.smartCase ?? true;
        for (const keyword of args.keywords ?? []) {
            const escaped = this.escapeRegExp(keyword, { wordBoundary: args.wordBoundary });
            const flags = this.getKeywordRegexFlags(keyword, args.caseSensitive, useSmartCase);
            queries.push({
                raw: keyword,
                regex: new RegExp(escaped, flags),
                literalHint: keyword.toLowerCase()
            });
        }
        for (const pattern of args.patterns ?? []) {
            let regex: RegExp;
            try {
                const flags = this.getPatternRegexFlags(args.caseSensitive, useSmartCase);
                regex = new RegExp(pattern, flags);
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

    private getKeywordRegexFlags(keyword: string, caseSensitive?: boolean, smartCase: boolean = true): string {
        const isCaseSensitive = this.shouldUseCaseSensitive(keyword, caseSensitive, smartCase);
        return isCaseSensitive ? "g" : "gi";
    }

    private getPatternRegexFlags(caseSensitive?: boolean, smartCase: boolean = true): string {
        if (typeof caseSensitive === "boolean") {
            return caseSensitive ? "g" : "gi";
        }
        if (smartCase === false) {
            return "gi";
        }
        return "g";
    }

    private shouldUseCaseSensitive(sample: string, caseSensitive?: boolean, smartCase: boolean = true): boolean {
        if (typeof caseSensitive === "boolean") {
            return caseSensitive;
        }
        if (!smartCase) {
            return false;
        }
        return /[A-Z]/.test(sample);
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

    private collectMatchesFromFile(
        relativePath: string,
        content: string,
        queries: SearchQuery[],
        previewLength: number,
        matchesPerFile: number
    ): FileSearchResult[] {
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
                        preview: this.formatPreview(line, previewLength)
                    });
                    break;
                }
            }
            if (matches.length >= matchesPerFile) {
                break;
            }
        }
        return matches;
    }

    private formatPreview(line: string, previewLength: number): string {
        if (previewLength <= 0) {
            return "";
        }
        const trimmed = line.trim();
        if (trimmed.length <= previewLength) {
            return trimmed;
        }
        const sliceLength = Math.max(1, previewLength - 1);
        return `${trimmed.slice(0, sliceLength)}…`;
    }

    private async assignFieldTypes(matches: Map<string, FileSearchResult>): Promise<Map<string, { fieldType: SearchFieldType; symbolId?: string }>> {
        const assignments = new Map<string, { fieldType: SearchFieldType; symbolId?: string }>();
        const tasks = Array.from(matches.entries()).map(async ([docId, match]) => {
            const meta = await this.classifyField(match.filePath, match.lineNumber, match.preview);
            assignments.set(docId, meta);
        });
        await Promise.all(tasks);
        return assignments;
    }

    private async classifyField(relativePath: string, lineNumber: number, preview: string): Promise<{ fieldType: SearchFieldType; symbolId?: string }> {
        if (this.isCommentLine(preview)) {
            return { fieldType: "comment" };
        }
        const symbol = await this.findSymbolForLine(relativePath, lineNumber);
        if (symbol && symbol.range) {
            const startLine = symbol.range.startLine + 1;
            const endLine = symbol.range.endLine + 1;
            const exportFlag = this.isExportedSymbol(symbol);
            const symbolId = this.makeSymbolId(relativePath, symbol.name);
            if (lineNumber === startLine) {
                return { fieldType: "symbol-definition", symbolId };
            }
            const signatureBoundary = Math.min(endLine, startLine + 2);
            if (lineNumber > startLine && lineNumber <= signatureBoundary) {
                return { fieldType: "signature", symbolId };
            }
            if (exportFlag) {
                return { fieldType: "exported-member", symbolId };
            }
        }
        if (/^\s*export\s+/i.test(preview)) {
            return { fieldType: "exported-member" };
        }
        return { fieldType: "code-body" };
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

    private makeSymbolId(relativePath: string, symbolName: string): string {
        const normalized = this.normalizeCacheKey(relativePath);
        return `${normalized}::${symbolName}`;
    }

    private async getCallGraphSignals(): Promise<Map<string, CallGraphSignals> | undefined> {
        if (!this.callGraphMetricsBuilder || !this.symbolMetadataProvider?.getAllSymbols) {
            return undefined;
        }
        if (this.callGraphSignals) {
            return this.callGraphSignals;
        }
        const entries = await this.collectEntrySymbols(25);
        if (entries.length === 0) {
            return undefined;
        }
        this.callGraphSignals = await this.callGraphMetricsBuilder.buildMetrics(entries);
        return this.callGraphSignals;
    }

    private async collectEntrySymbols(limit: number): Promise<Array<{ symbolName: string; filePath: string }>> {
        if (!this.symbolMetadataProvider?.getAllSymbols) {
            return [];
        }
        let symbolMap: Map<string, SymbolInfo[]> | undefined;
        try {
            symbolMap = await this.symbolMetadataProvider.getAllSymbols();
        } catch (error) {
            console.warn("[Search] Failed to load symbol metadata for call graph metrics:", error);
            return [];
        }

        const entries: Array<{ symbolName: string; filePath: string }> = [];
        for (const [filePath, symbols] of symbolMap.entries()) {
            for (const symbol of symbols) {
                if (!symbol.name || !this.isDefinitionSymbol(symbol)) {
                    continue;
                }
                if (!this.isExportedSymbol(symbol)) {
                    continue;
                }
                entries.push({ symbolName: symbol.name, filePath });
                if (entries.length >= limit) {
                    return entries;
                }
            }
        }
        return entries;
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

    private isDefinitionSymbol(symbol: SymbolInfo): boolean {
        const type = (symbol as any).type;
        return type !== "import" && type !== "export";
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
