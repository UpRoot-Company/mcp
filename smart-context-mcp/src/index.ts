
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import * as fs from "fs";
import { promisify } from "util";
import * as path from "path";
import * as ignore from "ignore";
import * as url from "url";
import * as crypto from "crypto";

// Engine Imports
import { SearchEngine } from "./engine/Search.js";
import { ContextEngine } from "./engine/Context.js";
import { EditorEngine, AmbiguousMatchError } from "./engine/Editor.js";
import { HistoryEngine } from "./engine/History.js";
import { EditCoordinator } from "./engine/EditCoordinator.js";
import { SkeletonGenerator } from "./ast/SkeletonGenerator.js";
import { AstManager } from "./ast/AstManager.js";
import { SymbolIndex } from "./ast/SymbolIndex.js";
import { ModuleResolver } from "./ast/ModuleResolver.js";
import { DependencyGraph } from "./ast/DependencyGraph.js";
import { ReferenceFinder } from "./ast/ReferenceFinder.js";
import { CallGraphBuilder, CallGraphDirection } from "./ast/CallGraphBuilder.js";
import { TypeDependencyTracker, TypeDependencyDirection } from "./ast/TypeDependencyTracker.js";
import { DataFlowTracer } from "./ast/DataFlowTracer.js";
import { FileProfiler, FileMetadataAnalysis } from "./engine/FileProfiler.js";
import { AgentWorkflowGuidance } from "./engine/AgentPlaybook.js";
import { ClusterSearchEngine, ClusterSearchOptions, ClusterExpansionOptions } from "./engine/ClusterSearch/index.js";
import { BuildClusterOptions, ExpandableRelationship } from "./engine/ClusterSearch/ClusterBuilder.js";
import { FileSearchResult, ReadFragmentResult, EditResult, DirectoryTree, Edit, EngineConfig, SmartFileProfile, SymbolInfo, ToolSuggestion, ImpactPreview, BatchEditGuidance, ReadCodeResult, ReadCodeArgs, SearchProjectResult, SearchProjectArgs, AnalyzeRelationshipResult, EditCodeArgs, EditCodeResult, EditCodeEdit, ManageProjectResult, ManageProjectArgs, AnalyzeRelationshipArgs, ReadCodeView, SearchProjectType, ResolvedRelationshipTarget, AnalyzeRelationshipDirection, AnalyzeRelationshipNode, AnalyzeRelationshipEdge, LineRange } from "./types.js";

const readFileAsync = promisify(fs.readFile);
const writeFileAsync = promisify(fs.writeFile);
const statAsync = promisify(fs.stat);
const mkdirAsync = promisify(fs.mkdir);
const unlinkAsync = promisify(fs.unlink);
const accessAsync = promisify(fs.access);
const ENABLE_DEBUG_LOGS = process.env.SMART_CONTEXT_DEBUG === 'true';

export class SmartContextServer {
    private server: Server;
    private rootPath: string;
    private ig: any;
    private ignoreGlobs: string[];
    private searchEngine: SearchEngine;
    private contextEngine: ContextEngine;
    private editorEngine: EditorEngine;
    private historyEngine: HistoryEngine;
    private editCoordinator: EditCoordinator;
    private skeletonGenerator: SkeletonGenerator;
    private astManager: AstManager;
    private symbolIndex: SymbolIndex;
    private moduleResolver: ModuleResolver;
    private dependencyGraph: DependencyGraph;
    private referenceFinder: ReferenceFinder;
    private callGraphBuilder: CallGraphBuilder;
    private typeDependencyTracker: TypeDependencyTracker;
    private dataFlowTracer: DataFlowTracer;
    private clusterSearchEngine: ClusterSearchEngine;
    private sigintListener?: () => Promise<void>;
    private static readonly READ_CODE_MAX_BYTES = 1_000_000;

        constructor(rootPath: string) {
        if (ENABLE_DEBUG_LOGS) {
            console.error("DEBUG: SmartContextServer constructor started");
        }
        this.server = new Server({
            name: "smart-context-mcp",
            version: "2.2.0", // Version updated for ADR-008 (v2)
        }, {
            capabilities: {
                tools: {},
            },
        });

        this.rootPath = path.resolve(rootPath);
                this.ig = (ignore.default as any)();
        this.ignoreGlobs = this._loadIgnoreFiles();

        this.searchEngine = new SearchEngine(this.ignoreGlobs);
        this.contextEngine = new ContextEngine(this.ig);
        this.editorEngine = new EditorEngine(this.rootPath); // Pass rootPath to EditorEngine
        this.historyEngine = new HistoryEngine(this.rootPath);
        this.editCoordinator = new EditCoordinator(this.editorEngine, this.historyEngine, this.rootPath);
        this.skeletonGenerator = new SkeletonGenerator();
        this.astManager = AstManager.getInstance();
        this.symbolIndex = new SymbolIndex(this.rootPath, this.skeletonGenerator, this.ignoreGlobs);
        this.moduleResolver = new ModuleResolver(this.rootPath);
        this.dependencyGraph = new DependencyGraph(this.rootPath, this.symbolIndex, this.moduleResolver);
        this.referenceFinder = new ReferenceFinder(this.rootPath, this.dependencyGraph, this.symbolIndex, this.skeletonGenerator, this.moduleResolver);
        this.callGraphBuilder = new CallGraphBuilder(this.rootPath, this.symbolIndex, this.moduleResolver);
        this.typeDependencyTracker = new TypeDependencyTracker(this.rootPath, this.symbolIndex);
        this.dataFlowTracer = new DataFlowTracer(this.rootPath, this.symbolIndex);
        const precomputeEnabled = process.env.SMART_CONTEXT_DISABLE_PRECOMPUTE === 'true' ? false : true;
        this.clusterSearchEngine = new ClusterSearchEngine({
            rootPath: this.rootPath,
            symbolIndex: this.symbolIndex,
            callGraphBuilder: this.callGraphBuilder,
            typeDependencyTracker: this.typeDependencyTracker,
            dependencyGraph: this.dependencyGraph
        }, {
            precomputation: { enabled: precomputeEnabled }
        });

        const engineConfig: EngineConfig = {
            rootPath: this.rootPath,
            mode: (process.env.SMART_CONTEXT_ENGINE_MODE as EngineConfig['mode']) || 'prod',
            parserBackend: (process.env.SMART_CONTEXT_PARSER_BACKEND as EngineConfig['parserBackend']) || 'auto',
            snapshotDir: process.env.SMART_CONTEXT_SNAPSHOT_DIR
        };

        this.astManager.init(engineConfig)
            .then(() => {
                if (ENABLE_DEBUG_LOGS) {
                    console.error(`[AST] Active backend: ${this.astManager.getActiveBackend() ?? 'unknown'}`);
                }
                return this.astManager.warmup();
            })
            .then(() => {
                this.clusterSearchEngine.startBackgroundTasks();
            })
            .catch(error => {
                if (ENABLE_DEBUG_LOGS) {
                    console.error("AstManager initialization failed:", error);
                }
            });

        this.setupHandlers();
        this.server.onerror = (error) => console.error("[MCP Error]", error);

        this.sigintListener = async () => {
            this.clusterSearchEngine.stopBackgroundTasks();
            await this.server.close();
            process.exit(0);
        };
        process.on("SIGINT", this.sigintListener);

        if (ENABLE_DEBUG_LOGS) {
            console.error("DEBUG: SmartContextServer constructor finished");
        }
    }

    private _loadIgnoreFiles(): string[] {
        const patterns: string[] = [];
        const collectPatterns = (filePath: string) => {
            if (!fs.existsSync(filePath)) {
                return;
            }
            const content = fs.readFileSync(filePath, 'utf-8');
            this.ig.add(content);
            const parsed = content
                .split(/\r?\n/)
                .map(line => line.trim())
                .filter(line => line.length > 0 && !line.startsWith('#'));
            patterns.push(...parsed);
        };
        const gitignorePath = path.join(this.rootPath, '.gitignore');
        collectPatterns(gitignorePath);
        const mcpignorePath = path.join(this.rootPath, '.mcpignore');
        collectPatterns(mcpignorePath);
        return patterns;
    }

    private _getAbsPathAndVerify(filePath: string): string {
        const absPath = path.isAbsolute(filePath)
            ? path.normalize(filePath)
            : path.join(this.rootPath, filePath);

        if (!absPath.startsWith(this.rootPath + path.sep) && absPath !== this.rootPath) {
            throw new McpError(ErrorCode.InvalidParams,
                `SecurityViolation: File path is outside the allowed root directory.`);
        }
        return absPath;
    }

    private normalizeRelativePath(absPath: string): string {
        const relative = path.relative(this.rootPath, absPath) || path.basename(absPath);
        return relative.replace(/\\/g, '/');
    }

    private async buildSmartFileProfile(absPath: string, content: string, stats: fs.Stats): Promise<SmartFileProfile> {
        const relativePath = path.relative(this.rootPath, absPath) || path.basename(absPath);
        const [outgoingDeps, incomingRefs] = await Promise.all([
            this.dependencyGraph.getDependencies(absPath, 'outgoing'),
            this.dependencyGraph.getDependencies(absPath, 'incoming')
        ]);

        let skeleton = '// Skeleton generation failed or not applicable for this file type.';
        try {
            skeleton = await this.skeletonGenerator.generateSkeleton(absPath, content);
        } catch (error: any) {
            if (content.length < 5000) {
                skeleton = `// Skeleton generation failed: ${error?.message || 'unknown error'}.\n${content}`;
            } else {
                skeleton = `// Skeleton generation failed: ${error?.message || 'unknown error'}.`;
            }
        }

        let symbols: SymbolInfo[] = [];
        try {
            symbols = await this.skeletonGenerator.generateStructureJson(absPath, content);
        } catch (error) {
            console.error(`Structure extraction failed for ${absPath}:`, error);
        }

        const metaAnalysis = FileProfiler.analyzeMetadata(content, absPath);
        const lineCount = content.length === 0 ? 0 : content.split(/\r?\n/).length;
        const metadata: SmartFileProfile['metadata'] = {
            filePath: absPath,
            relativePath,
            sizeBytes: stats.size,
            lineCount,
            language: path.extname(absPath).replace('.', '') || null,
            lastModified: stats.mtime.toISOString(),
            newlineStyle: metaAnalysis.newlineStyle,
            encoding: 'utf-8',
            hasBOM: metaAnalysis.hasBOM,
            usesTabs: metaAnalysis.usesTabs,
            indentSize: metaAnalysis.indentSize,
            isConfigFile: metaAnalysis.isConfigFile,
            configType: metaAnalysis.configType,
            configScope: metaAnalysis.configScope
        };

        const complexity = this.computeComplexity(content, symbols, metaAnalysis.indentSize, metaAnalysis.usesTabs);
        const usage: SmartFileProfile['usage'] = {
            incomingCount: incomingRefs.length,
            incomingFiles: incomingRefs.slice(0, 10),
            outgoingCount: outgoingDeps.length,
            outgoingFiles: outgoingDeps.slice(0, 10)
        };
        const testFiles = this.detectTestFiles(incomingRefs);
        if (testFiles.length > 0) {
            usage.testFiles = testFiles;
        }

        const guidance = this.buildGuidance(metadata, usage, metaAnalysis);

        return {
            metadata,
            structure: {
                skeleton,
                symbols,
                complexity
            },
            usage,
            guidance
        };
    }

    private computeComplexity(content: string, symbols: SymbolInfo[], indentSize?: number | null, usesTabs?: boolean): SmartFileProfile['structure']['complexity'] {
        const linesOfCode = content.split(/\r?\n/).filter(line => line.trim().length > 0).length;
        const functionCount = symbols.filter(symbol => symbol.type === 'function' || symbol.type === 'method').length;
        const maxNestingDepth = this.estimateNestingDepth(content, indentSize, usesTabs);
        return {
            functionCount,
            linesOfCode,
            maxNestingDepth
        };
    }

    private estimateNestingDepth(content: string, indentSize?: number | null, usesTabs?: boolean): number {
        let braceDepth = 0;
        let braceMax = 0;
        for (const char of content) {
            if (char === '{' || char === '(' || char === '[') {
                braceDepth++;
                if (braceDepth > braceMax) braceMax = braceDepth;
            } else if (char === '}' || char === ')' || char === ']') {
                braceDepth = Math.max(0, braceDepth - 1);
            }
        }

        const lines = content.split(/\r?\n/);
        const effectiveIndent = usesTabs ? 1 : (indentSize && indentSize > 0 ? indentSize : 2);
        let indentMax = 0;
        for (const line of lines) {
            if (!line.trim()) continue;
            const leading = line.length - line.trimStart().length;
            if (leading <= 0) continue;
            const depth = Math.floor(leading / effectiveIndent);
            if (depth > indentMax) indentMax = depth;
        }

        return Math.max(braceMax, indentMax);
    }

    private detectTestFiles(files: string[]): string[] {
        const patterns = [/\.test\./i, /\.spec\./i, /__tests?__/i, /^tests?\//i];
        const seen = new Set<string>();
        const matches: string[] = [];
        for (const file of files) {
            if (seen.has(file)) continue;
            if (patterns.some(pattern => pattern.test(file))) {
                seen.add(file);
                matches.push(file);
            }
            if (matches.length >= 5) break;
        }
        return matches;
    }

    private buildGuidance(metadata: SmartFileProfile['metadata'], usage: SmartFileProfile['usage'], meta: FileMetadataAnalysis): SmartFileProfile['guidance'] {
        const isLarge = metadata.lineCount > 400 || metadata.sizeBytes > 64 * 1024;
        const readFullHint = metadata.isConfigFile
            ? '이 파일은 구성 역할을 하므로 전체 맥락을 확인한 뒤 필요한 부분만 수정하세요. full=true는 검증 용도로만 사용하세요.'
            : isLarge
                ? '파일이 커서 기본 프로필과 read_code(view="fragment", lineRange)를 조합해 필요한 구간만 읽는 것이 안전합니다.'
                : '기본 프로필에 주요 정보가 담겨 있으니 정말 필요할 때만 full=true를 사용하세요.';
        const styleHint = `${(meta.newlineStyle || 'lf').toUpperCase()} newline / ${meta.usesTabs ? 'TAB' : `${meta.indentSize || 2}-space`} indent`;
        const readFragmentHint = `스켈레톤 라인 번호를 기준으로 read_code(view="fragment")와 edit_code(lineRange + expectedHash)을 함께 사용하세요. (Style: ${styleHint})`;
        return {
            bodyHidden: true,
            readFullHint,
            readFragmentHint
        };
    }

    private async previewEditImpact(absPath: string, editCount: number): Promise<ImpactPreview | null> {
        try {
            const relativePath = this.normalizeRelativePath(absPath);
            const [incoming, outgoing] = await Promise.all([
                this.dependencyGraph.getTransitiveDependencies(absPath, 'incoming', 4),
                this.dependencyGraph.getTransitiveDependencies(absPath, 'outgoing', 3)
            ]);
            const impactedFiles = Array.from(new Set([...incoming, ...outgoing])).slice(0, 25);
            const suggestedTests = this.detectTestFiles(incoming);
            const riskMetric = incoming.length * 2 + outgoing.length + editCount;
            let riskLevel: ImpactPreview['riskLevel'] = 'low';
            if (riskMetric >= 25) {
                riskLevel = 'high';
            } else if (riskMetric >= 8) {
                riskLevel = 'medium';
            }

            const notes: string[] = [];
            if (riskLevel === 'high') {
                notes.push('High downstream or upstream reach detected. Consider splitting the edit or expanding tests.');
            } else if (riskLevel === 'medium') {
                notes.push('Multiple files depend on this target; double-check callers before applying edits.');
            }
            if (!suggestedTests.length) {
                notes.push('No related test files detected for the impacted set.');
            }

            return {
                filePath: relativePath,
                riskLevel,
                summary: {
                    incomingCount: incoming.length,
                    outgoingCount: outgoing.length,
                    impactedFiles
                },
                editCount,
                suggestedTests,
                notes
            };
        } catch (error) {
            if (ENABLE_DEBUG_LOGS) {
                console.error('[ImpactPreview] Failed to compute impact preview', error);
            }
            return null;
        }
    }

    private async buildBatchEditGuidance(fileEdits: { filePath: string }[]): Promise<BatchEditGuidance | null> {
        if (!fileEdits || fileEdits.length <= 1) {
            return null;
        }

        const normalized = fileEdits.map(entry => ({
            abs: entry.filePath,
            rel: this.normalizeRelativePath(entry.filePath)
        }));
        const editSet = new Set(normalized.map(entry => entry.rel));
        const adjacency = new Map<string, Set<string>>();
        const dependencyCache = new Map<string, { incoming: string[]; outgoing: string[] }>();

        await Promise.all(normalized.map(async ({ abs, rel }) => {
            const [incoming, outgoing] = await Promise.all([
                this.dependencyGraph.getDependencies(abs, 'incoming'),
                this.dependencyGraph.getDependencies(abs, 'outgoing')
            ]);
            dependencyCache.set(rel, { incoming, outgoing });
            const neighborSet = new Set<string>();
            for (const candidate of [...incoming, ...outgoing]) {
                if (editSet.has(candidate)) {
                    neighborSet.add(candidate);
                }
            }
            adjacency.set(rel, neighborSet);
        }));

        const clusters: BatchEditGuidance['clusters'] = [];
        const visited = new Set<string>();
        for (const rel of editSet) {
            if (visited.has(rel)) continue;
            const queue = [rel];
            const group: string[] = [];
            while (queue.length > 0) {
                const current = queue.shift()!;
                if (visited.has(current)) continue;
                visited.add(current);
                group.push(current);
                const neighbors = adjacency.get(current);
                if (!neighbors) continue;
                for (const neighbor of neighbors) {
                    if (!visited.has(neighbor)) {
                        queue.push(neighbor);
                    }
                }
            }
            if (group.length > 1) {
                clusters.push({ files: group, reason: 'These files share direct import/export relationships.' });
            }
        }

        const companionSuggestions: BatchEditGuidance['companionSuggestions'] = [];
        const seenSuggestions = new Set<string>();
        outer: for (const [rel, deps] of dependencyCache) {
            for (const candidate of deps.incoming) {
                if (editSet.has(candidate) || seenSuggestions.has(candidate)) continue;
                seenSuggestions.add(candidate);
                companionSuggestions.push({
                    filePath: candidate,
                    reason: `${candidate} imports or references ${rel}`
                });
                if (companionSuggestions.length >= 8) break outer;
            }
            for (const candidate of deps.outgoing) {
                if (editSet.has(candidate) || seenSuggestions.has(candidate)) continue;
                seenSuggestions.add(candidate);
                companionSuggestions.push({
                    filePath: candidate,
                    reason: `${rel} depends on ${candidate}`
                });
                if (companionSuggestions.length >= 8) break outer;
            }
        }

        if (clusters.length === 0 && companionSuggestions.length === 0) {
            return null;
        }

        return { clusters, companionSuggestions };
    }

    private _createErrorResponse(code: string, message: string, suggestion?: string | ToolSuggestion | ToolSuggestion[], details?: any): { isError: true; content: { type: "text"; text: string; }[] } {
        return {
            isError: true,
            content: [{ type: "text", text: JSON.stringify({ errorCode: code, message, suggestion, details }) }]
        };
    }

    private buildClusterSearchOptions(args: any): ClusterSearchOptions {
        const options: ClusterSearchOptions = {};
        if (typeof args?.maxClusters === "number" && Number.isFinite(args.maxClusters) && args.maxClusters > 0) {
            options.maxClusters = Math.max(1, Math.floor(args.maxClusters));
        }
        if (typeof args?.tokenBudget === "number" && Number.isFinite(args.tokenBudget) && args.tokenBudget > 0) {
            options.tokenBudget = Math.floor(args.tokenBudget);
        }
        if (typeof args?.expansionDepth === "number" && Number.isFinite(args.expansionDepth) && args.expansionDepth > 0) {
            options.expansionDepth = Math.floor(args.expansionDepth);
        }
        if (typeof args?.includePreview === "boolean") {
            options.includePreview = args.includePreview;
        }
        const expandRelationships = this.parseExpandRelationshipsInput(args?.expandRelationships);
        if (expandRelationships) {
            options.expandRelationships = expandRelationships;
        }
        return options;
    }

    private buildClusterExpansionOptions(args: any): ClusterExpansionOptions {
        const options: ClusterExpansionOptions = {};
        if (typeof args?.expansionDepth === "number" && Number.isFinite(args.expansionDepth) && args.expansionDepth > 0) {
            options.depth = Math.floor(args.expansionDepth);
        }
        if (typeof args?.limit === "number" && Number.isFinite(args.limit) && args.limit > 0) {
            options.limit = Math.floor(args.limit);
        }
        if (typeof args?.includePreview === "boolean") {
            options.includePreview = args.includePreview;
        }
        return options;
    }

    private parseLineRangeSpec(rangeSpec?: string): LineRange {
        if (typeof rangeSpec !== "string" || !rangeSpec.trim()) {
            throw new McpError(ErrorCode.InvalidParams, "lineRange is required when view=\"fragment\".");
        }
        const match = rangeSpec.trim().match(/^(\d+)\s*-\s*(\d+)$/);
        if (!match) {
            throw new McpError(ErrorCode.InvalidParams, `Invalid lineRange '${rangeSpec}'. Use 'start-end'.`);
        }
        const start = Number(match[1]);
        const end = Number(match[2]);
        if (!Number.isFinite(start) || !Number.isFinite(end) || start < 1 || end < start) {
            throw new McpError(ErrorCode.InvalidParams, `Invalid lineRange '${rangeSpec}'. Ensure start >= 1 and end >= start.`);
        }
        return { start, end };
    }

    private extractFragmentContent(content: string, range: LineRange): string {
        const lines = content.split(/\r?\n/);
        if (range.end > lines.length) {
            throw new McpError(ErrorCode.InvalidParams, `lineRange exceeds file length (${lines.length}).`);
        }
        return lines.slice(range.start - 1, range.end).join('\n');
    }

    private inferSearchProjectType(query?: string): "symbol" | "file" | "directory" {
        const trimmed = (query || "").trim();
        if (!trimmed || trimmed === ".") {
            return "directory";
        }
        if (/\/$/.test(trimmed)) {
            return "directory";
        }
        if (/[\\/]/.test(trimmed) || /[*?]/.test(trimmed)) {
            return "file";
        }
        if (/^(function:|class:|symbol:|method:)/i.test(trimmed)) {
            return "symbol";
        }
        if (trimmed.includes("(")) {
            return "symbol";
        }
        return "symbol";
    }

    private normalizeMaxResults(value: any, fallback = 20): number {
        if (typeof value !== "number" || !Number.isFinite(value)) {
            return fallback;
        }
        const coerced = Math.max(1, Math.floor(value));
        return Math.min(100, coerced);
    }

    private clampScore(value: number): number {
        if (!Number.isFinite(value)) {
            return 0;
        }
        return Math.max(0, Math.min(1, value));
    }

    private async pathExists(absPath: string): Promise<boolean> {
        try {
            await accessAsync(absPath, fs.constants.F_OK);
            return true;
        } catch {
            return false;
        }
    }

    private async executeReadCode(args: ReadCodeArgs): Promise<ReadCodeResult> {
        if (!args || typeof args.filePath !== "string" || !args.filePath.trim()) {
            throw new McpError(ErrorCode.InvalidParams, "Provide 'filePath' to read_code.");
        }
        const absPath = this._getAbsPathAndVerify(args.filePath);
        const view = (args.view ?? "full") as ReadCodeView;
        if (!["full", "skeleton", "fragment"].includes(view)) {
            throw new McpError(ErrorCode.InvalidParams, `Invalid view '${args.view}'. Use full|skeleton|fragment.`);
        }

        const [content, stats] = await Promise.all([
            readFileAsync(absPath, "utf-8"),
            statAsync(absPath)
        ]);

        const metadata: ReadCodeResult["metadata"] = {
            lines: content.length === 0 ? 0 : content.split(/\r?\n/).length,
            language: path.extname(absPath).replace('.', '') || null,
            path: this.normalizeRelativePath(absPath)
        };

        let truncated = false;
        let payload: string;

        switch (view) {
            case "full": {
                truncated = stats.size > SmartContextServer.READ_CODE_MAX_BYTES;
                payload = truncated
                    ? content.slice(0, SmartContextServer.READ_CODE_MAX_BYTES)
                    : content;
                break;
            }
            case "skeleton": {
                payload = await this.skeletonGenerator.generateSkeleton(absPath, content);
                break;
            }
            case "fragment": {
                const lineRange = this.parseLineRangeSpec(args.lineRange);
                payload = this.extractFragmentContent(content, lineRange);
                break;
            }
            default:
                throw new McpError(ErrorCode.InvalidParams, `Unsupported view '${view}'.`);
        }

        return {
            content: payload,
            metadata,
            truncated
        };
    }

    private async executeSearchProject(args: SearchProjectArgs): Promise<SearchProjectResult> {
        if (!args || typeof args.query !== "string" || !args.query.trim()) {
            throw new McpError(ErrorCode.InvalidParams, "Provide 'query' to search_project.");
        }
        const requestedType = (args.type ?? "auto") as SearchProjectType;
        const maxResults = this.normalizeMaxResults(args.maxResults);

        if (requestedType === "directory") {
            return { results: await this.runDirectorySearchResults(args.query, maxResults) };
        }
        if (requestedType === "symbol") {
            return { results: await this.runSymbolSearchResults(args.query, maxResults) };
        }
        if (requestedType === "file") {
            return { results: await this.runFileSearchResults(args.query, maxResults) };
        }

        const inferred = this.inferSearchProjectType(args.query);
        if (inferred === "directory") {
            return { results: await this.runDirectorySearchResults(args.query, maxResults), inferredType: inferred };
        }
        if (inferred === "file") {
            return { results: await this.runFileSearchResults(args.query, maxResults), inferredType: inferred };
        }

        let symbolResults = await this.runClusterSearchResults(args.query, maxResults);
        if (symbolResults.length === 0) {
            symbolResults = await this.runSymbolSearchResults(args.query, maxResults);
        }
        return { results: symbolResults, inferredType: "symbol" };
    }

    private async runClusterSearchResults(query: string, maxResults: number): Promise<SearchProjectResult["results"]> {
        const response = await this.clusterSearchEngine.search(query, {
            includePreview: true,
            maxClusters: Math.min(maxResults, 5)
        });

        const entries: SearchProjectResult["results"] = [];
        for (const cluster of response.clusters) {
            for (const seed of cluster.seeds) {
                const absSeedPath = path.isAbsolute(seed.filePath)
                    ? seed.filePath
                    : path.join(this.rootPath, seed.filePath);
                const normalizedPath = this.normalizeRelativePath(absSeedPath);
                const symbolSignature = (seed.symbol as any)?.signature as string | undefined;
                const symbolContent = (seed.symbol as any)?.content as string | undefined;
                entries.push({
                    type: "symbol",
                    path: normalizedPath,
                    score: this.clampScore(seed.matchScore ?? cluster.metadata.relevanceScore ?? 0),
                    context: seed.fullPreview || symbolSignature || symbolContent,
                    line: typeof seed.symbol.range?.startLine === "number"
                        ? seed.symbol.range.startLine + 1
                        : undefined
                });
                if (entries.length >= maxResults) {
                    return entries;
                }
            }
        }
        return entries;
    }

    private async runSymbolSearchResults(query: string, maxResults: number): Promise<SearchProjectResult["results"]> {
        const matches = await this.symbolIndex.search(query);
        return matches.slice(0, maxResults).map((match, index) => {
            const symbolSignature = (match.symbol as any)?.signature as string | undefined;
            const symbolContent = (match.symbol as any)?.content as string | undefined;
            return {
                type: "symbol",
                path: match.filePath,
                score: this.clampScore(1 - index / Math.max(1, maxResults)),
                context: symbolSignature || symbolContent,
                line: typeof match.symbol.range?.startLine === "number"
                    ? match.symbol.range.startLine + 1
                    : undefined
            };
        });
    }

    private async runFileSearchResults(query: string, maxResults: number): Promise<SearchProjectResult["results"]> {
        const matches = await this.searchEngine.scout({
            keywords: [query],
            basePath: this.rootPath
        });
        return matches.slice(0, maxResults).map(match => ({
            type: "file",
            path: match.filePath,
            score: this.clampScore(match.score ?? 0),
            context: match.preview,
            line: match.lineNumber
        }));
    }

    private async runDirectorySearchResults(query: string, _maxResults: number): Promise<SearchProjectResult["results"]> {
        const target = query.trim() || ".";
        const absPath = this._getAbsPathAndVerify(target);
        const tree = await this.contextEngine.listDirectoryTree(absPath, 2, this.rootPath);
        return [{
            type: "directory",
            path: this.normalizeRelativePath(absPath),
            score: 1,
            context: tree
        }];
    }

    private makeNodeId(prefix: string, identifier: string): string {
        return `${prefix}:${identifier}`;
    }

    private async executeAnalyzeRelationship(args: AnalyzeRelationshipArgs): Promise<AnalyzeRelationshipResult> {
        if (!args || typeof args.target !== "string" || !args.target.trim()) {
            throw new McpError(ErrorCode.InvalidParams, "Provide 'target' to analyze_relationship.");
        }
        const mode = args.mode as "impact" | "dependencies" | "calls" | "data_flow" | "types";
        if (!mode) {
            throw new McpError(ErrorCode.InvalidParams, "Provide 'mode' to analyze_relationship.");
        }
        const direction = (args.direction ?? "both") as AnalyzeRelationshipDirection;
        const maxDepth = typeof args.maxDepth === "number" && Number.isFinite(args.maxDepth)
            ? Math.max(1, Math.floor(args.maxDepth))
            : (mode === "impact" ? 20 : mode === "calls" ? 3 : mode === "types" ? 2 : mode === "data_flow" ? 10 : 1);

        const resolved = await this.resolveRelationshipTarget(args, mode);
        const nodes = new Map<string, AnalyzeRelationshipNode>();
        const edges: AnalyzeRelationshipEdge[] = [];
        const addNode = (node: AnalyzeRelationshipNode) => {
            if (!nodes.has(node.id)) {
                nodes.set(node.id, node);
            }
        };
        const addFileNode = (relativePath: string) => {
            const id = this.makeNodeId("file", relativePath);
            addNode({ id, type: "file", path: relativePath });
            return id;
        };

        if ((mode === "dependencies" || mode === "impact") && resolved.type !== "file") {
            throw new McpError(ErrorCode.InvalidParams, `${mode} mode requires a file target.`);
        }
        if ((mode === "calls" || mode === "types") && resolved.type !== "symbol") {
            throw new McpError(ErrorCode.InvalidParams, `${mode} mode requires a symbol target.`);
        }
        if (mode === "data_flow" && resolved.type !== "variable") {
            throw new McpError(ErrorCode.InvalidParams, "data_flow mode requires 'contextPath' to point to a file.");
        }

        if (mode === "dependencies") {
            const absTarget = this._getAbsPathAndVerify(resolved.path);
            const baseId = addFileNode(this.normalizeRelativePath(absTarget));
            if (direction === "downstream" || direction === "both") {
                const downstream = await this.dependencyGraph.getDependencies(absTarget, 'outgoing');
                for (const dep of downstream) {
                    const depId = addFileNode(dep);
                    edges.push({ source: baseId, target: depId, relation: "imports" });
                }
            }
            if (direction === "upstream" || direction === "both") {
                const upstream = await this.dependencyGraph.getDependencies(absTarget, 'incoming');
                for (const parent of upstream) {
                    const parentId = addFileNode(parent);
                    edges.push({ source: parentId, target: baseId, relation: "imported_by" });
                }
            }
        } else if (mode === "impact") {
            const absTarget = this._getAbsPathAndVerify(resolved.path);
            const baseId = addFileNode(this.normalizeRelativePath(absTarget));
            const directions: Array<{ dir: 'incoming' | 'outgoing'; relation: string }> = [];
            if (direction === "downstream" || direction === "both") {
                directions.push({ dir: 'outgoing', relation: 'impact' });
            }
            if (direction === "upstream" || direction === "both") {
                directions.push({ dir: 'incoming', relation: 'impact' });
            }
            for (const entry of directions) {
                const impacted = await this.dependencyGraph.getTransitiveDependencies(absTarget, entry.dir, maxDepth);
                for (const relPath of impacted) {
                    const impactedId = addFileNode(relPath);
                    if (entry.dir === 'outgoing') {
                        edges.push({ source: baseId, target: impactedId, relation: entry.relation });
                    } else {
                        edges.push({ source: impactedId, target: baseId, relation: entry.relation });
                    }
                }
            }
        } else if (mode === "calls") {
            const absPath = this._getAbsPathAndVerify(resolved.path);
            const callDirection = direction as CallGraphDirection;
            const callGraph = await this.callGraphBuilder.analyzeSymbol(resolved.symbolName!, absPath, callDirection, maxDepth);
            if (!callGraph) {
                throw new McpError(ErrorCode.InvalidParams, `Symbol '${resolved.symbolName}' not found in ${resolved.path}.`);
            }
            for (const node of Object.values(callGraph.visitedNodes)) {
                addNode({
                    id: node.symbolId,
                    type: node.symbolType,
                    path: node.filePath,
                    label: node.symbolName
                });
                for (const callee of node.callees) {
                    edges.push({ source: node.symbolId, target: callee.toSymbolId, relation: "calls" });
                }
            }
        } else if (mode === "types") {
            const absPath = this._getAbsPathAndVerify(resolved.path);
            const typeGraph = await this.typeDependencyTracker.analyzeType(resolved.symbolName!, absPath, direction === "upstream" ? "incoming" : direction === "downstream" ? "outgoing" : "both", maxDepth);
            if (!typeGraph) {
                throw new McpError(ErrorCode.InvalidParams, `Type symbol '${resolved.symbolName}' not found in ${resolved.path}.`);
            }
            for (const node of Object.values(typeGraph.visitedNodes)) {
                addNode({
                    id: node.symbolId,
                    type: node.symbolType,
                    path: node.filePath,
                    label: node.symbolName
                });
                for (const edge of node.dependencies) {
                    edges.push({ source: edge.fromSymbolId, target: edge.toSymbolId, relation: edge.relationKind });
                }
            }
        } else if (mode === "data_flow") {
            const absPath = this._getAbsPathAndVerify(resolved.path);
            const flow = await this.dataFlowTracer.traceVariable(resolved.symbolName!, absPath, args.fromLine, maxDepth);
            if (!flow) {
                throw new McpError(ErrorCode.InvalidParams, `Unable to trace variable '${resolved.symbolName}' in ${resolved.path}.`);
            }
            for (const stepId of flow.orderedStepIds) {
                const step = flow.steps[stepId];
                addNode({
                    id: step.id,
                    type: step.stepType,
                    path: step.filePath,
                    label: step.textSnippet
                });
            }
            for (const edge of flow.edges) {
                edges.push({ source: edge.fromStepId, target: edge.toStepId, relation: edge.relation });
            }
        }

        return {
            nodes: Array.from(nodes.values()),
            edges,
            resolvedTarget: resolved
        };
    }

    private async resolveRelationshipTarget(args: AnalyzeRelationshipArgs, mode: AnalyzeRelationshipArgs["mode"]): Promise<ResolvedRelationshipTarget> {
        const targetType = (args.targetType ?? "auto");
        if (mode === "data_flow") {
            if (!args.contextPath) {
                throw new McpError(ErrorCode.InvalidParams, "data_flow mode requires 'contextPath'.");
            }
            const absCtx = this._getAbsPathAndVerify(args.contextPath);
            return {
                type: "variable",
                path: this.normalizeRelativePath(absCtx),
                symbolName: args.target
            };
        }

        if (targetType === "file" || targetType === "auto") {
            try {
                const absPath = this._getAbsPathAndVerify(args.target);
                if (await this.pathExists(absPath)) {
                    return {
                        type: "file",
                        path: this.normalizeRelativePath(absPath)
                    };
                }
            } catch (error) {
                if (targetType === "file") {
                    throw new McpError(ErrorCode.InvalidParams, (error as Error).message);
                }
            }
        }

        const contextPath = args.contextPath ? this._getAbsPathAndVerify(args.contextPath) : undefined;
        if (contextPath) {
            const symbols = await this.symbolIndex.getSymbolsForFile(contextPath);
            const match = symbols.find(symbol => symbol.name === args.target);
            if (match) {
                return {
                    type: "symbol",
                    path: this.normalizeRelativePath(contextPath),
                    symbolName: match.name
                };
            }
        }

        const matches = await this.symbolIndex.search(args.target);
        if (!matches.length) {
            throw new McpError(ErrorCode.InvalidParams, `Unable to resolve symbol '${args.target}'. Provide 'contextPath' to disambiguate.`);
        }
        const first = matches[0];
        const absPath = this._getAbsPathAndVerify(first.filePath);
        return {
            type: "symbol",
            path: this.normalizeRelativePath(absPath),
            symbolName: first.symbol.name
        };
    }

    private async executeEditCode(args: EditCodeArgs): Promise<EditCodeResult> {
        if (!args || !Array.isArray(args.edits) || args.edits.length === 0) {
            throw new McpError(ErrorCode.InvalidParams, "Provide at least one edit in 'edits'.");
        }
        const dryRun = Boolean(args.dryRun);
        const createDirs = Boolean(args.createMissingDirectories);
        const ignoreMistakes = Boolean(args.ignoreMistakes);
        const transactionId = dryRun
            ? undefined
            : (typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
        const results: EditCodeResult["results"] = [];
        const rollbackActions: Array<() => Promise<void>> = [];
        const touchedFiles = new Set<string>();

        try {
            await this.handleCreateOperations(args.edits, dryRun, createDirs, results, rollbackActions, touchedFiles);
            await this.handleDeleteOperations(args.edits, dryRun, results, rollbackActions, touchedFiles);
            await this.handleReplaceOperations(args.edits, dryRun, ignoreMistakes, results, touchedFiles);
        } catch (error: any) {
            await this.rollbackActions(rollbackActions);
            const message = error instanceof McpError ? error.message : (error?.message ?? "edit_code failed");
            results.push({ filePath: error?.filePath ?? args.edits[0]?.filePath ?? "", applied: false, error: message });
            return { success: false, results, transactionId };
        }

        if (!dryRun && touchedFiles.size > 0) {
            await this.invalidateTouchedFiles(touchedFiles);
        }

        return { success: true, results, transactionId };
    }

    private async handleCreateOperations(
        edits: EditCodeEdit[],
        dryRun: boolean,
        createDirs: boolean,
        results: EditCodeResult["results"],
        rollback: Array<() => Promise<void>>,
        touchedFiles: Set<string>
    ): Promise<void> {
        for (const edit of edits) {
            if (edit.operation !== "create") continue;
            if (typeof edit.replacementString !== "string") {
                throw new McpError(ErrorCode.InvalidParams, "create operation requires 'replacementString'.");
            }
            const absPath = this._getAbsPathAndVerify(edit.filePath);
            if (await this.pathExists(absPath)) {
                throw new McpError(ErrorCode.InvalidParams, `File '${edit.filePath}' already exists.`);
            }
            const parentDir = path.dirname(absPath);
            const parentExists = await this.pathExists(parentDir);
            if (!parentExists && !createDirs) {
                throw new McpError(ErrorCode.InvalidParams, `Missing directory '${this.normalizeRelativePath(parentDir)}'. Set createMissingDirectories=true.`);
            }
            if (!dryRun) {
                if (!parentExists && createDirs) {
                    await mkdirAsync(parentDir, { recursive: true });
                }
                await writeFileAsync(absPath, edit.replacementString);
                touchedFiles.add(absPath);
                rollback.push(async () => {
                    if (await this.pathExists(absPath)) {
                        await unlinkAsync(absPath);
                    }
                });
            }
            results.push({
                filePath: this.normalizeRelativePath(absPath),
                applied: !dryRun,
                diff: dryRun ? "Dry run: would create file." : "Created file."
            });
        }
    }

    private async handleDeleteOperations(
        edits: EditCodeEdit[],
        dryRun: boolean,
        results: EditCodeResult["results"],
        rollback: Array<() => Promise<void>>,
        touchedFiles: Set<string>
    ): Promise<void> {
        for (const edit of edits) {
            if (edit.operation !== "delete") continue;
            const absPath = this._getAbsPathAndVerify(edit.filePath);
            if (!await this.pathExists(absPath)) {
                throw new McpError(ErrorCode.InvalidParams, `File '${edit.filePath}' does not exist.`);
            }
            let previousContent = "";
            if (!dryRun) {
                previousContent = await readFileAsync(absPath, 'utf-8');
                await unlinkAsync(absPath);
                touchedFiles.add(absPath);
                const backup = previousContent;
                rollback.push(async () => {
                    await writeFileAsync(absPath, backup);
                });
            }
            results.push({
                filePath: this.normalizeRelativePath(absPath),
                applied: !dryRun,
                diff: dryRun ? "Dry run: would delete file." : "Deleted file."
            });
        }
    }

    private async handleReplaceOperations(
        edits: EditCodeEdit[],
        dryRun: boolean,
        ignoreMistakes: boolean,
        results: EditCodeResult["results"],
        touchedFiles: Set<string>
    ): Promise<void> {
        const fileMap = new Map<string, Edit[]>();
        const fileOrder: string[] = [];
        for (const edit of edits) {
            if (edit.operation !== "replace") continue;
            if (typeof edit.targetString !== "string") {
                throw new McpError(ErrorCode.InvalidParams, "replace operation requires 'targetString'.");
            }
            const absPath = this._getAbsPathAndVerify(edit.filePath);
            if (!fileMap.has(absPath)) {
                fileMap.set(absPath, []);
                fileOrder.push(absPath);
            }
            const normalizedEdit: Edit = {
                targetString: edit.targetString,
                replacementString: edit.replacementString ?? "",
                lineRange: edit.lineRange,
                beforeContext: edit.beforeContext,
                afterContext: edit.afterContext,
                fuzzyMode: edit.fuzzyMode ?? (ignoreMistakes ? "whitespace" : undefined),
                anchorSearchRange: edit.anchorSearchRange,
                indexRange: edit.indexRange,
                normalization: edit.normalization,
                expectedHash: edit.expectedHash
            };
            fileMap.get(absPath)!.push(normalizedEdit);
        }

        if (fileMap.size === 0) {
            return;
        }

        const fileEdits = fileOrder.map(filePath => ({ filePath, edits: fileMap.get(filePath)! }));
        const result = await this.editCoordinator.applyBatchEdits(fileEdits, dryRun);
        if (!result.success) {
            throw new McpError(ErrorCode.InternalError, result.message ?? "Failed to apply edits.");
        }

        if (!dryRun) {
            for (const { filePath } of fileEdits) {
                touchedFiles.add(filePath);
            }
        }

        for (const { filePath } of fileEdits) {
            results.push({
                filePath: this.normalizeRelativePath(filePath),
                applied: !dryRun,
                diff: result.message ?? (dryRun ? "Dry run: edits validated." : "Edits applied.")
            });
        }
    }

    private async rollbackActions(actions: Array<() => Promise<void>>): Promise<void> {
        for (let i = actions.length - 1; i >= 0; i--) {
            try {
                await actions[i]();
            } catch (error) {
                if (ENABLE_DEBUG_LOGS) {
                    console.error("[edit_code] rollback failed", error);
                }
            }
        }
    }

    private async invalidateTouchedFiles(touchedFiles: Set<string>): Promise<void> {
        for (const absPath of touchedFiles) {
            this.callGraphBuilder.invalidateFile(absPath);
            this.typeDependencyTracker.invalidateFile(absPath);
            this.clusterSearchEngine.invalidateFile(absPath);
        }
    }

    private async executeManageProject(args: ManageProjectArgs): Promise<ManageProjectResult> {
        if (!args || typeof args.command !== "string") {
            throw new McpError(ErrorCode.InvalidParams, "Provide 'command' to manage_project.");
        }
        switch (args.command) {
            case "undo": {
                const result = await this.editCoordinator.undo();
                if (!result.success) {
                    throw new McpError(ErrorCode.InternalError, result.message ?? "Undo failed");
                }
                this.callGraphBuilder.clearCaches();
                this.typeDependencyTracker.clearCaches();
                return { output: result.message ?? "Undid last edit.", data: result };
            }
            case "redo": {
                const result = await this.editCoordinator.redo();
                if (!result.success) {
                    throw new McpError(ErrorCode.InternalError, result.message ?? "Redo failed");
                }
                this.callGraphBuilder.clearCaches();
                return { output: result.message ?? "Redid last edit.", data: result };
            }
            case "guidance": {
                const playbookPath = path.join(this.rootPath, 'docs', 'agent-playbook.md');
                let markdown: string | undefined;
                try {
                    markdown = await readFileAsync(playbookPath, 'utf-8');
                } catch {
                    markdown = undefined;
                }
                return {
                    output: "Returned workflow guidance.",
                    data: {
                        structured: AgentWorkflowGuidance,
                        markdown: markdown ?? 'docs/agent-playbook.md not found.'
                    }
                };
            }
            case "status": {
                const status = await this.dependencyGraph.getIndexStatus();
                return { output: "Index status retrieved.", data: status };
            }
            default:
                throw new McpError(ErrorCode.InvalidParams, `Unknown manage_project command '${args.command}'.`);
        }
    }

    private parseExpandRelationshipsInput(input: any): BuildClusterOptions["expandRelationships"] | undefined {
        if (!input || typeof input !== "object") {
            return undefined;
        }
        const keys: Array<keyof NonNullable<BuildClusterOptions["expandRelationships"]>> = [
            "callers",
            "callees",
            "typeFamily",
            "colocated",
            "siblings",
            "all"
        ];
        const result: BuildClusterOptions["expandRelationships"] = {};
        let hasValue = false;
        for (const key of keys) {
            if (typeof input[key] === "boolean") {
                result[key] = input[key];
                hasValue = true;
            }
        }
        return hasValue ? result : undefined;
    }

    private setupHandlers(): void {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            return {
                tools: this.listIntentTools(),
            };
        });

        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            return this.handleCallTool(request.params.name, request.params.arguments);
        });
    }

    private listIntentTools() {
        return [
            {
                name: "read_code",
                description: "Reads code with full, skeleton, or fragment views and standardized metadata.",
                inputSchema: {
                    type: "object",
                    properties: {
                        filePath: { type: "string" },
                        view: { type: "string", enum: ["full", "skeleton", "fragment"], default: "full" },
                        lineRange: { type: "string", description: "Required when view=\"fragment\". Format: start-end." }
                    },
                    required: ["filePath"]
                }
            },
            {
                name: "search_project",
                description: "Unified search across files, symbols, directories, and cluster-based insights.",
                inputSchema: {
                    type: "object",
                    properties: {
                        query: { type: "string" },
                        type: { type: "string", enum: ["auto", "file", "symbol", "directory"], default: "auto" },
                        maxResults: { type: "number", default: 20 }
                    },
                    required: ["query"]
                }
            },
            {
                name: "analyze_relationship",
                description: "Explores dependencies, impact, call graphs, type graphs, or data flow for a target.",
                inputSchema: {
                    type: "object",
                    properties: {
                        target: { type: "string" },
                        targetType: { type: "string", enum: ["auto", "file", "symbol"], default: "auto" },
                        contextPath: { type: "string" },
                        mode: { type: "string", enum: ["impact", "dependencies", "calls", "data_flow", "types"] },
                        direction: { type: "string", enum: ["upstream", "downstream", "both"], default: "both" },
                        maxDepth: { type: "number" },
                        fromLine: { type: "number", description: "Optional line hint for data_flow." }
                    },
                    required: ["target", "mode"]
                }
            },
            {
                name: "edit_code",
                description: "Atomic editor for creating, deleting, or replacing code across files.",
                inputSchema: {
                    type: "object",
                    properties: {
                        edits: {
                            type: "array",
                            items: {
                                type: "object",
                                properties: {
                                    filePath: { type: "string" },
                                    operation: { type: "string", enum: ["replace", "create", "delete"] },
                                    targetString: { type: "string" },
                                    replacementString: { type: "string" },
                                    lineRange: { type: "object", properties: { start: { type: "number" }, end: { type: "number" } } },
                                    beforeContext: { type: "string" },
                                    afterContext: { type: "string" },
                                    fuzzyMode: { type: "string", enum: ["whitespace", "levenshtein"] },
                                    anchorSearchRange: { type: "object", properties: { lines: { type: "number" }, chars: { type: "number" } } },
                                    normalization: { type: "string", enum: ["exact", "whitespace", "structural"] }
                                },
                                required: ["filePath", "operation"]
                            }
                        },
                        dryRun: { type: "boolean", default: false },
                        createMissingDirectories: { type: "boolean", default: false },
                        ignoreMistakes: { type: "boolean", default: false }
                    },
                    required: ["edits"]
                }
            },
            {
                name: "manage_project",
                description: "Runs project-level commands like undo, redo, workflow guidance, and index status.",
                inputSchema: {
                    type: "object",
                    properties: {
                        command: { type: "string", enum: ["undo", "redo", "guidance", "status"] }
                    },
                    required: ["command"]
                }
            }
        ];
    }

    private async handleCallTool(toolName: string, args: any): Promise<any> {
        try {
            switch (toolName) {
                case "read_code": {
                    const result = await this.executeReadCode(args as ReadCodeArgs);
                    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
                }
                case "search_project": {
                    const result = await this.executeSearchProject(args as SearchProjectArgs);
                    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
                }
                case "analyze_relationship": {
                    const result = await this.executeAnalyzeRelationship(args as AnalyzeRelationshipArgs);
                    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
                }
                case "edit_code": {
                    const result = await this.executeEditCode(args as EditCodeArgs);
                    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
                }
                case "manage_project": {
                    const result = await this.executeManageProject(args as ManageProjectArgs);
                    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
                }
                case "read_file": {
                    const absPath = this._getAbsPathAndVerify(args.filePath);
                    const content = await readFileAsync(absPath, 'utf-8');

                    if (args?.full) {
                        return { content: [{ type: "text", text: content }] };
                    }

                    try {
                        const stats = await statAsync(absPath);
                        const profile = await this.buildSmartFileProfile(absPath, content, stats);
                        return { content: [{ type: "text", text: JSON.stringify(profile, null, 2) }] };
                    } catch (error: any) {
                        console.error(`Failed to build Smart File Profile for ${absPath}:`, error);
                        return this._createErrorResponse("ProfileBuildFailed", `Failed to build Smart File Profile: ${error.message}`);
                    }
                }
                case "read_file_skeleton": {
                    const absPath = this._getAbsPathAndVerify(args.filePath);
                    const content = await readFileAsync(absPath, 'utf-8');
                    const format = args.format || 'text'; // Default to text

                    if (format === 'json') {
                        const structure = await this.skeletonGenerator.generateStructureJson(absPath, content); 
                        return { content: [{ type: "text", text: JSON.stringify(structure, null, 2) }] };
                    } else {
                        const skeleton = await this.skeletonGenerator.generateSkeleton(absPath, content);
                        return { content: [{ type: "text", text: skeleton }] };
                    }
                }
                case "search_symbol_definitions": {
                    const query = args.query;
                    const results = await this.symbolIndex.search(query);
                    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
                }
                case "get_file_dependencies": {
                    const absPath = this._getAbsPathAndVerify(args.filePath);
                    const direction = args.direction || 'outgoing';
                    const deps = await this.dependencyGraph.getDependencies(absPath, direction);
                    return { content: [{ type: "text", text: JSON.stringify(deps, null, 2) }] };
                }
                case "analyze_impact": {
                    const absPath = this._getAbsPathAndVerify(args.filePath);
                    const direction = args.direction || 'incoming';
                    const maxDepth = args.maxDepth || 20;
                    const result = await this.dependencyGraph.getTransitiveDependencies(absPath, direction, maxDepth);
                    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
                }
                case "analyze_symbol_impact": {
                    if (!args?.symbolName) {
                        return this._createErrorResponse("MissingParameter", "Provide 'symbolName' to analyze_symbol_impact.");
                    }
                    if (!args?.filePath) {
                        return this._createErrorResponse("MissingParameter", "Provide 'filePath' to analyze_symbol_impact.");
                    }

                    const absPath = this._getAbsPathAndVerify(args.filePath);
                    const requestedDirection = typeof args.direction === "string" ? args.direction : "both";
                    const direction: CallGraphDirection = ["upstream", "downstream", "both"].includes(requestedDirection)
                        ? requestedDirection as CallGraphDirection
                        : "both";
                    const maxDepth = typeof args.maxDepth === "number" ? args.maxDepth : 3;

                    const result = await this.callGraphBuilder.analyzeSymbol(args.symbolName, absPath, direction, maxDepth);
                    if (!result) {
                        return this._createErrorResponse(
                            "SymbolNotFound",
                            `Could not locate symbol '${args.symbolName}' in ${args.filePath}. Ensure the definition exists and has been indexed.`
                        );
                    }

                    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
                }
                case "analyze_type_dependencies": {
                    if (!args?.symbolName) {
                        return this._createErrorResponse("MissingParameter", "Provide 'symbolName' to analyze_type_dependencies.");
                    }
                    if (!args?.filePath) {
                        return this._createErrorResponse("MissingParameter", "Provide 'filePath' to analyze_type_dependencies.");
                    }

                    const absPath = this._getAbsPathAndVerify(args.filePath);
                    const requestedDirection = typeof args.direction === "string" ? args.direction : "both";
                    const direction: TypeDependencyDirection = ["incoming", "outgoing", "both"].includes(requestedDirection)
                        ? requestedDirection as TypeDependencyDirection
                        : "both";
                    const maxDepth = typeof args.maxDepth === "number" ? args.maxDepth : 2;

                    const result = await this.typeDependencyTracker.analyzeType(args.symbolName, absPath, direction, maxDepth);
                    if (!result) {
                        return this._createErrorResponse(
                            "SymbolNotFound",
                            `Could not locate type symbol '${args.symbolName}' in ${args.filePath}. Ensure the declaration exists and has been indexed.`
                        );
                    }

                    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
                }
                case "trace_data_flow": {
                    if (!args?.variableName) {
                        return this._createErrorResponse("MissingParameter", "Provide 'variableName' to trace_data_flow.");
                    }
                    if (!args?.fromFile) {
                        return this._createErrorResponse("MissingParameter", "Provide 'fromFile' to trace_data_flow.");
                    }

                    const absPath = this._getAbsPathAndVerify(args.fromFile);
                    const fromLine = typeof args.fromLine === "number" ? args.fromLine : undefined;
                    const maxSteps = typeof args.maxSteps === "number" ? args.maxSteps : 10;

                    const result = await this.dataFlowTracer.traceVariable(args.variableName, absPath, fromLine, maxSteps);
                    if (!result) {
                        return this._createErrorResponse(
                            "DataFlowUnavailable",
                            `Could not trace data flow for '${args.variableName}' in ${args.fromFile}. Ensure the variable exists in the provided context.`
                        );
                    }

                    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
                }
                case "find_symbol_references": {
                    const absPath = this._getAbsPathAndVerify(args.contextFile);
                    const results = await this.referenceFinder.findReferences(args.symbolName, absPath);
                    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
                }
                case "preview_rename": {
                    const defPath = this._getAbsPathAndVerify(args.definitionFilePath);
                    const refs = await this.referenceFinder.findReferences(args.symbolName, defPath);
                    
                    const editsByFile = new Map<string, Edit[]>();
                    for (const ref of refs) {
                        const refAbsPath = path.resolve(this.rootPath, ref.filePath);
                        if (!editsByFile.has(refAbsPath)) editsByFile.set(refAbsPath, []);
                        editsByFile.get(refAbsPath)!.push({
                            targetString: ref.text,
                            replacementString: args.newName,
                            lineRange: { start: ref.range.startLine + 1, end: ref.range.endLine + 1 }
                        });
                    }

                    const fileEdits = Array.from(editsByFile.entries()).map(([fp, edits]) => ({ filePath: fp, edits }));
                    // Use batch_edit logic but forcing dryRun=true via EditCoordinator directly?
                    // handleCallTool calls EditCoordinator.applyBatchEdits.
                    // We can call it directly.
                    
                                        const result = await this.editCoordinator.applyBatchEdits(fileEdits, true);
                    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
                }
                case "get_index_status": {
                    const status = await this.dependencyGraph.getIndexStatus();
                    return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
                }
                case "rebuild_index": {
                    this.moduleResolver.clearCache();
                    await this.dependencyGraph.build();
                    this.callGraphBuilder.clearCaches();
                    this.typeDependencyTracker.clearCaches();
                    this.typeDependencyTracker.clearCaches();
                    this.clusterSearchEngine.clearCache();
                    const status = await this.dependencyGraph.getIndexStatus();
                    return { content: [{ type: "text", text: JSON.stringify({ message: "Index rebuilt successfully", status }, null, 2) }] };
                }
                case "invalidate_index_file": {
                    const absPath = this._getAbsPathAndVerify(args.filePath);
                    await this.dependencyGraph.invalidateFile(absPath);
                    this.callGraphBuilder.invalidateFile(absPath);
                    this.typeDependencyTracker.invalidateFile(absPath);
                    this.clusterSearchEngine.invalidateFile(absPath);
                    const status = await this.dependencyGraph.getIndexStatus();
                    return { content: [{ type: "text", text: JSON.stringify({ message: `Invalidated ${args.filePath}`, status }, null, 2) }] };
                }
                case "invalidate_index_directory": {
                    const dirArg = args.directoryPath || args.path;
                    if (!dirArg) {
                        return this._createErrorResponse("MissingParameter", "Provide 'directoryPath' to invalidate_index_directory.");
                    }
                    const absDir = this._getAbsPathAndVerify(dirArg);
                    await this.dependencyGraph.invalidateDirectory(absDir);
                    this.callGraphBuilder.invalidateDirectory(absDir);
                    this.typeDependencyTracker.invalidateDirectory(absDir);
                     this.clusterSearchEngine.invalidateDirectory(absDir);
                    const status = await this.dependencyGraph.getIndexStatus();
                    return { content: [{ type: "text", text: JSON.stringify({ message: `Invalidated directory ${dirArg}`, status }, null, 2) }] };
                }
                case "read_fragment": {
                    const absPath = this._getAbsPathAndVerify(args.filePath);
                    let ranges = args.lineRanges || [];

                    if (args.keywords || args.patterns) {
                        const searchConfigs = [
                            ...(args.keywords || []).map((k: string) => ({ pattern: this.searchEngine.escapeRegExp(k) })),
                            ...(args.patterns || []).map((p: string) => ({ pattern: p }))
                        ];

                        for (const config of searchConfigs) {
                            try {
                                const lineNumbers = await this.searchEngine.runFileGrep(config.pattern, absPath);
                                lineNumbers.forEach(num => ranges.push({ start: num, end: num }));
                            } catch (e) {
                                // Ignore
                            }
                        }
                    }

                    const result: ReadFragmentResult = await this.contextEngine.readFragment(absPath, ranges, args.contextLines);
                    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
                }
                case "write_file": {
                    const absPath = this._getAbsPathAndVerify(args.filePath);
                    await writeFileAsync(absPath, args.content);
                    this.callGraphBuilder.invalidateFile(absPath);
                    this.typeDependencyTracker.invalidateFile(absPath);
                    this.clusterSearchEngine.invalidateFile(absPath);
                    return { content: [{ type: "text", text: `Successfully wrote to ${args.filePath}` }] };
                }
                case "edit_file": {
                    const absPath = this._getAbsPathAndVerify(args.filePath);
                    // Adapt old fuzzyMatch boolean to new fuzzyMode
                    const adaptedEdits = args.edits.map((edit: any) => {
                        if (edit.fuzzyMatch === true) {
                            edit.fuzzyMode = "whitespace";
                        }
                        delete edit.fuzzyMatch;
                        return edit;
                    });

                    const impactPreview = await this.previewEditImpact(absPath, adaptedEdits.length);
                    
                    const result: EditResult = await this.editCoordinator.applyEdits(absPath, adaptedEdits as Edit[], args.dryRun);
                    
                    if (!result.success) {
                        const errorCode = result.errorCode || "EditFailed";
                        const details = {
                            ...result.details,
                            impactPreview
                        };
                        return this._createErrorResponse(errorCode as string, result.message || "Unknown error", result.suggestion, details);
                    }
                    if (!args.dryRun) {
                        this.callGraphBuilder.invalidateFile(absPath);
                        this.typeDependencyTracker.invalidateFile(absPath);
                        this.clusterSearchEngine.invalidateFile(absPath);
                    }

                    if (impactPreview) {
                        result.impactPreview = impactPreview;
                        if (impactPreview.riskLevel !== 'low') {
                            const warningText = `Impact preview: ${impactPreview.summary.incomingCount} upstream and ${impactPreview.summary.outgoingCount} downstream files linked.`;
                            result.warnings = [...(result.warnings ?? []), warningText];
                            if (impactPreview.riskLevel === 'high') {
                                result.warnings.push('High risk edit detected. Run analyze_symbol_impact before committing.');
                                if (!result.suggestion) {
                                    result.suggestion = {
                                        toolName: "analyze_symbol_impact",
                                        rationale: "Inspect symbol-level callers/callees for this file before finalizing a risky edit.",
                                        exampleArgs: {
                                            symbolName: path.basename(absPath).split('.')[0],
                                            filePath: args.filePath,
                                            direction: "both",
                                            maxDepth: 3
                                        }
                                    };
                                }
                            }
                        }
                    }
                    // History is now handled by EditCoordinator
                    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
                }
                case "batch_edit": {
                    const fileEdits: { filePath: string; edits: Edit[] }[] = args.fileEdits.map((fileEdit: any) => {
                         const absPath = this._getAbsPathAndVerify(fileEdit.filePath);
                         const adaptedEdits = fileEdit.edits.map((edit: any) => {
                            if (edit.fuzzyMatch === true) {
                                edit.fuzzyMode = "whitespace";
                            }
                            delete edit.fuzzyMatch;
                            return edit;
                        });
                        return { filePath: absPath, edits: adaptedEdits };
                    });

                    const [impactPreviews, batchGuidance] = await Promise.all([
                        Promise.all(fileEdits.map(entry => this.previewEditImpact(entry.filePath, entry.edits.length))),
                        this.buildBatchEditGuidance(fileEdits)
                    ]);
                    
                    const result: EditResult = await this.editCoordinator.applyBatchEdits(fileEdits, args.dryRun);

                     if (!result.success) {
                        const errorCode = result.errorCode || "BatchEditFailed";
                        const details = {
                            ...result.details,
                            impactPreviews: impactPreviews.filter((preview): preview is ImpactPreview => Boolean(preview)),
                            batchGuidance
                        };
                        return this._createErrorResponse(errorCode as string, result.message || "Unknown error", result.suggestion, details);
                    }
                    if (!args.dryRun) {
                        for (const fileEdit of fileEdits) {
                            this.callGraphBuilder.invalidateFile(fileEdit.filePath);
                            this.typeDependencyTracker.invalidateFile(fileEdit.filePath);
                            this.clusterSearchEngine.invalidateFile(fileEdit.filePath);
                        }
                    }

                    const realizedPreviews = impactPreviews.filter((preview): preview is ImpactPreview => Boolean(preview));
                    if (realizedPreviews.length > 0) {
                        result.impactPreviews = realizedPreviews;
                        const maxRisk = realizedPreviews.reduce((acc, preview) => {
                            const score = preview.riskLevel === 'high' ? 2 : preview.riskLevel === 'medium' ? 1 : 0;
                            return Math.max(acc, score);
                        }, 0);
                        if (maxRisk > 0) {
                            const warning = maxRisk === 2
                                ? 'High risk batch edit: multiple files have far-reaching dependencies.'
                                : 'Medium risk batch edit: affected files share several dependencies.';
                            result.warnings = [...(result.warnings ?? []), warning];
                            if (!result.suggestion) {
                                result.suggestion = {
                                    toolName: maxRisk === 2 ? 'analyze_symbol_impact' : 'analyze_impact',
                                    rationale: maxRisk === 2
                                        ? 'Inspect symbol-level callers/callees before finalizing this batch edit.'
                                        : 'Review file-level dependencies before applying all edits.',
                                    exampleArgs: maxRisk === 2
                                        ? {
                                            symbolName: path.basename(fileEdits[0].filePath).split('.')[0],
                                            filePath: path.relative(this.rootPath, fileEdits[0].filePath),
                                            direction: 'both',
                                            maxDepth: 3
                                        }
                                        : {
                                            filePath: path.relative(this.rootPath, fileEdits[0].filePath),
                                            direction: 'incoming',
                                            maxDepth: 5
                                        }
                                };
                            }
                        }
                    }

                    if (batchGuidance) {
                        result.batchGuidance = batchGuidance;
                    }
                    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
                }
                case "search_with_context": {
                    if (!args?.query || typeof args.query !== "string" || !args.query.trim()) {
                        return this._createErrorResponse("MissingParameter", "Provide 'query' to search_with_context.");
                    }
                    const options = this.buildClusterSearchOptions(args);
                    const result = await this.clusterSearchEngine.search(args.query, options);
                    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
                }
                case "expand_cluster_relationship": {
                    if (!args?.clusterId || typeof args.clusterId !== "string") {
                        return this._createErrorResponse("MissingParameter", "Provide 'clusterId' to expand_cluster_relationship.");
                    }
                    if (typeof args.relationshipType !== "string") {
                        return this._createErrorResponse("MissingParameter", "Provide 'relationshipType' to expand_cluster_relationship.");
                    }
                    const relationship = args.relationshipType;
                    if (!["callers", "callees", "typeFamily"].includes(relationship)) {
                        return this._createErrorResponse("InvalidRelationship", "relationshipType must be one of callers, callees, typeFamily.");
                    }
                    const expansionOptions = this.buildClusterExpansionOptions(args);
                    const cluster = await this.clusterSearchEngine.expandClusterRelationship(args.clusterId, relationship as ExpandableRelationship, expansionOptions);
                    if (!cluster) {
                        return this._createErrorResponse("ClusterNotFound", `Cluster '${args.clusterId}' not found or expired. Run search_with_context again.`);
                    }
                    return { content: [{ type: "text", text: JSON.stringify(cluster, null, 2) }] };
                }
                case "search_files": {
                    const searchArgs = args || {};
                    const excludeGlobs = [...this.ignoreGlobs, ...(searchArgs.excludeGlobs || [])];
                    const scoutArgs = { ...searchArgs, excludeGlobs, basePath: this.rootPath };
                    const results: FileSearchResult[] = await this.searchEngine.scout(scoutArgs);
                    return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
                }
                case "get_workflow_guidance": {
                    const playbookPath = path.join(this.rootPath, 'docs', 'agent-playbook.md');
                    let markdown: string | undefined;
                    try {
                        markdown = await readFileAsync(playbookPath, 'utf-8');
                    } catch (error) {
                        console.warn(`Agent playbook markdown missing:`, error);
                    }
                    const structured = JSON.stringify(AgentWorkflowGuidance, null, 2);
                    const content = [{ type: "text", text: structured }];
                    content.push({ type: "text", text: markdown ?? 'docs/agent-playbook.md not found. Structured workflow payload returned above.' });
                    return { content };
                }
                case "list_directory": {
                    const absPath = this._getAbsPathAndVerify(args.path);
                    const tree: string = await this.contextEngine.listDirectoryTree(absPath, args.depth, this.rootPath);
                    return { content: [{ type: "text", text: tree }] };
                }
                case "debug_edit_match": {
                    const absPath = this._getAbsPathAndVerify(args.filePath);
                    const content = await readFileAsync(absPath, 'utf-8');
                    const edit: Edit = {
                        targetString: args.targetString,
                        replacementString: "", // Not used for diagnostics
                        lineRange: args.lineRange,
                        normalization: args.normalization
                    };
                    const diagnostics = this.editorEngine.getDiagnostics(content, edit);
                    return { content: [{ type: "text", text: JSON.stringify(diagnostics, null, 2) }] };
                }
                case "undo_last_edit": {
                    const result: EditResult = await this.editCoordinator.undo();

                    if (!result.success) {
                        const errorCode = result.errorCode || "UndoFailed";
                        const details = result.details;
                        return this._createErrorResponse(errorCode as string, result.message || "Unknown error during undo operation", result.suggestion, details);
                    }

                    this.callGraphBuilder.clearCaches();
                    this.typeDependencyTracker.clearCaches();

                    return {
                        content: [
                            {
                                type: "text",
                                text: "Undid edit...",
                            },
                        ],
                    };
                }
                case "redo_last_edit": {
                    const result: EditResult = await this.editCoordinator.redo();

                    if (!result.success) {
                        const errorCode = result.errorCode || "RedoFailed";
                        const details = result.details;
                        return this._createErrorResponse(errorCode as string, result.message || "Unknown error during redo operation", result.suggestion, details);
                    }

                    this.callGraphBuilder.clearCaches();

                    return {
                        content: [
                            {
                                type: "text",
                                text: "Redid edit...",
                            },
                        ],
                    };
                }
                default:
                    return this._createErrorResponse("UnknownTool", `Tool '${toolName}' not found.`);
            }
        } catch (error: any) {
            if (error instanceof McpError) {
                return this._createErrorResponse(error.code.toString(), error.message);
            }
            // --- ADR-008 (v2) Change: Handle AmbiguousMatchError from EditorEngine ---
            if (error.name === 'AmbiguousMatchError') {
                const ambiguousError = error as AmbiguousMatchError;
                return this._createErrorResponse(
                    "AmbiguousMatch",
                    ambiguousError.message,
                    `Ambiguity detected. Refine your request by adding a 'lineRange' parameter to specify which occurrence to target. Conflicting lines are: ${ambiguousError.conflictingLines.join(', ')}.`,{
                        conflictingLines: ambiguousError.conflictingLines
                    }
                );
            }
            return this._createErrorResponse("InternalError", error.message, "Check server logs for details.");
        }
    }

    public async shutdown(): Promise<void> {
        if (this.sigintListener) {
            process.removeListener("SIGINT", this.sigintListener);
            this.sigintListener = undefined;
        }
        await this.server.close();
    }

    public async run() {
        if (ENABLE_DEBUG_LOGS) {
            console.error("DEBUG: SmartContextServer run method started");
        }
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        if (ENABLE_DEBUG_LOGS) {
            console.error("DEBUG: MCP Server connected to transport");
            console.error("Smart Context MCP Server running on stdio");
        }
    }
}

if (import.meta.url === url.pathToFileURL(process.argv[1]).href) {
    const server = new SmartContextServer(process.cwd());
    server.run().catch(console.error);
}
