
import "./utils/StdoutGuard.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import * as fs from "fs";
import * as path from "path";
import ignore from "ignore";
import * as url from "url";
import * as crypto from "crypto";

// Engine Imports
import { SearchEngine } from "./engine/Search.js";
import { ContextEngine } from "./engine/Context.js";
import { EditorEngine } from "./engine/Editor.js";
import { HistoryEngine } from "./engine/History.js";
import { EditCoordinator } from "./engine/EditCoordinator.js";
import { ImpactAnalyzer } from "./engine/ImpactAnalyzer.js";
import { FileProfiler } from "./engine/FileProfiler.js";
import { SkeletonGenerator } from "./ast/SkeletonGenerator.js";
import { SkeletonCache } from "./ast/SkeletonCache.js";
import { AstManager } from "./ast/AstManager.js";
import { SymbolIndex } from "./ast/SymbolIndex.js";
import { ModuleResolver } from "./ast/ModuleResolver.js";
import { DependencyGraph } from "./ast/DependencyGraph.js";
import { CallGraphBuilder } from "./ast/CallGraphBuilder.js";
import { TypeDependencyTracker } from "./ast/TypeDependencyTracker.js";
import { DataFlowTracer } from "./ast/DataFlowTracer.js";
import { ClusterSearchEngine } from "./engine/ClusterSearch/index.js";
import { IndexDatabase } from "./indexing/IndexDatabase.js";
import { IncrementalIndexer } from "./indexing/IncrementalIndexer.js";
import { TransactionLog } from "./engine/TransactionLog.js";
import { ConfigurationManager } from "./config/ConfigurationManager.js";
import { PathManager } from "./utils/PathManager.js";
import { FileVersionManager } from "./engine/FileVersionManager.js";
import { PathNormalizer } from "./utils/PathNormalizer.js";
import { AstAwareDiff } from "./engine/AstAwareDiff.js";
import { NodeFileSystem } from "./platform/FileSystem.js";
import { ErrorEnhancer } from "./errors/ErrorEnhancer.js";
import { GhostInterfaceBuilder } from "./resolution/GhostInterfaceBuilder.js";
import { FallbackResolver } from "./resolution/FallbackResolver.js";
import { CallSiteAnalyzer } from "./ast/analysis/CallSiteAnalyzer.js";
import { HotSpotDetector } from "./engine/ClusterSearch/HotSpotDetector.js";

// Orchestration Imports
import { OrchestrationEngine } from "./orchestration/OrchestrationEngine.js";
import { IntentRouter } from "./orchestration/IntentRouter.js";
import { WorkflowPlanner } from "./orchestration/WorkflowPlanner.js";
import { InternalToolRegistry } from "./orchestration/InternalToolRegistry.js";
import { LegacyToolAdapter } from "./orchestration/LegacyToolAdapter.js";

export class SmartContextServer {
    private server: Server;
    private rootPath: string;
    private fileSystem: NodeFileSystem;
    private orchestrationEngine: OrchestrationEngine;
    private internalRegistry: InternalToolRegistry;
    private legacyAdapter: LegacyToolAdapter;
    private incrementalIndexer?: IncrementalIndexer;
    private searchEngine: SearchEngine;
    private editCoordinator: EditCoordinator;
    private configurationManager: ConfigurationManager;
    private astManager: AstManager;
    private skeletonGenerator: SkeletonGenerator;
    private skeletonCache: SkeletonCache;
    private symbolIndex: SymbolIndex;
    private dependencyGraph: DependencyGraph;
    private callGraphBuilder: CallGraphBuilder;
    private typeDependencyTracker: TypeDependencyTracker;
    private dataFlowTracer: DataFlowTracer;
    private contextEngine: ContextEngine;
    private fileVersionManager: FileVersionManager;
    private pathNormalizer: PathNormalizer;
    private hotSpotDetector: HotSpotDetector;
    private ghostInterfaceBuilder: GhostInterfaceBuilder;
    private fallbackResolver: FallbackResolver;
    private clusterSearchEngine: ClusterSearchEngine;
    private impactAnalyzer: ImpactAnalyzer;

    constructor(rootPath: string) {
        this.server = new Server({
            name: "smart-context-mcp",
            version: "4.0.0",
        }, {
            capabilities: { tools: {} },
        });

        this.rootPath = path.resolve(rootPath);
        PathManager.setRoot(this.rootPath);
        this.fileSystem = new NodeFileSystem(this.rootPath);
        this.astManager = AstManager.getInstance();
        this.pathNormalizer = new PathNormalizer(this.rootPath);
        const ignoreFilter = (ignore as unknown as () => any)();
        this.contextEngine = new ContextEngine(ignoreFilter, this.fileSystem);
        
        // Initialize Core Engines
        this.skeletonGenerator = new SkeletonGenerator();
        this.skeletonCache = new SkeletonCache(this.rootPath);
        const indexDatabase = new IndexDatabase(this.rootPath);
        this.symbolIndex = new SymbolIndex(this.rootPath, this.skeletonGenerator, [], indexDatabase);
        const moduleResolver = new ModuleResolver(this.rootPath);
        this.dependencyGraph = new DependencyGraph(this.rootPath, this.symbolIndex, moduleResolver, indexDatabase);
        this.callGraphBuilder = new CallGraphBuilder(this.rootPath, this.symbolIndex, moduleResolver);
        this.typeDependencyTracker = new TypeDependencyTracker(this.rootPath, this.symbolIndex);
        this.dataFlowTracer = new DataFlowTracer(this.rootPath, this.symbolIndex, this.fileSystem);
        this.impactAnalyzer = new ImpactAnalyzer(this.dependencyGraph, this.callGraphBuilder, this.symbolIndex);
        this.hotSpotDetector = new HotSpotDetector(this.symbolIndex, this.dependencyGraph);
        
        this.searchEngine = new SearchEngine(this.rootPath, this.fileSystem, [], {
            symbolIndex: this.symbolIndex,
            callGraphBuilder: this.callGraphBuilder,
            dependencyGraph: this.dependencyGraph
        });
        this.clusterSearchEngine = new ClusterSearchEngine({
            rootPath: this.rootPath,
            symbolIndex: this.symbolIndex,
            callGraphBuilder: this.callGraphBuilder,
            typeDependencyTracker: this.typeDependencyTracker,
            dependencyGraph: this.dependencyGraph,
            fileSystem: this.fileSystem
        });

        const historyEngine = new HistoryEngine(this.rootPath, this.fileSystem);
        const editorEngine = new EditorEngine(this.rootPath, this.fileSystem, new AstAwareDiff(this.skeletonGenerator));
        const transactionLog = new TransactionLog(indexDatabase.getHandle());

        this.editCoordinator = new EditCoordinator(editorEngine, historyEngine, {
            rootPath: this.rootPath,
            transactionLog,
            fileSystem: this.fileSystem,
            impactAnalyzer: this.impactAnalyzer
        });

        this.fileVersionManager = new FileVersionManager(this.fileSystem);
        this.configurationManager = new ConfigurationManager(this.rootPath);
        this.ghostInterfaceBuilder = new GhostInterfaceBuilder(
            this.searchEngine,
            new CallSiteAnalyzer(),
            this.astManager,
            this.fileSystem,
            this.rootPath
        );
        this.fallbackResolver = new FallbackResolver(this.symbolIndex, this.skeletonGenerator, this.ghostInterfaceBuilder);

        // Orchestration Layer
        this.internalRegistry = new InternalToolRegistry();
        this.orchestrationEngine = new OrchestrationEngine(
            new IntentRouter(),
            new WorkflowPlanner(),
            this.internalRegistry
        );
        this.legacyAdapter = new LegacyToolAdapter();

        this.registerInternalTools();
        this.setupHandlers();
    }

    private registerInternalTools(): void {
        this.internalRegistry.register('read_code', (args) => this.readCodeRaw(args));
        this.internalRegistry.register('search_project', (args) => this.searchProjectRaw(args));
        this.internalRegistry.register('analyze_relationship', (args) => this.analyzeRelationshipRaw(args));
        this.internalRegistry.register('edit_code', (args) => this.editCodeRaw(args));
        this.internalRegistry.register('manage_project', (args) => this.manageProjectRaw(args));
        this.internalRegistry.register('file_profiler', (args) => this.readFileProfileRaw(args));
        this.internalRegistry.register('impact_analyzer', (args) => this.executeImpactAnalyzer(args));
        this.internalRegistry.register('edit_coordinator', (args) => this.executeEditCoordinator(args));
        this.internalRegistry.register('hotspot_detector', () => this.hotSpotDetector.detectHotSpots());
    }

    private setupHandlers(): void {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: this.listIntentTools(),
        }));

        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            return this.handleCallTool(request.params.name, request.params.arguments);
        });
    }

    private listIntentTools(): any[] {
        const legacyTools = [
            {
                name: 'read_code',
                description: 'Read file content in full, skeleton, or fragment modes.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        filePath: { type: 'string' },
                        view: { type: 'string', enum: ['full', 'skeleton', 'fragment'] },
                        lineRange: { type: 'string' }
                    },
                    required: ['filePath']
                }
            },
            {
                name: 'search_project',
                description: 'Search for symbols, files, or content across the project.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        query: { type: 'string' },
                        type: { type: 'string', enum: ['auto', 'file', 'symbol', 'directory', 'filename'] },
                        maxResults: { type: 'number' }
                    },
                    required: ['query']
                }
            },
            {
                name: 'analyze_relationship',
                description: 'Analyze dependencies, call graphs, data flow, or impact.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        target: { type: 'string' },
                        mode: { type: 'string', enum: ['impact', 'dependencies', 'calls', 'data_flow', 'types'] },
                        direction: { type: 'string', enum: ['upstream', 'downstream', 'both'] },
                        contextPath: { type: 'string' },
                        maxDepth: { type: 'number' },
                        fromLine: { type: 'number' }
                    },
                    required: ['target', 'mode']
                }
            },
            {
                name: 'edit_code',
                description: 'Apply structured edits to files with optional dry-run.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        edits: { type: 'array' },
                        dryRun: { type: 'boolean' },
                        diffMode: { type: 'string', enum: ['myers', 'semantic'] }
                    },
                    required: ['edits']
                }
            },
            {
                name: 'get_batch_guidance',
                description: 'Suggests batch edit groupings and companion changes.',
                inputSchema: {
                    type: 'object',
                    properties: { filePaths: { type: 'array' }, pattern: { type: 'string' } },
                    required: ['filePaths']
                }
            },
            {
                name: 'manage_project',
                description: 'Manage project state (status, undo, redo, reindex).',
                inputSchema: {
                    type: 'object',
                    properties: { command: { type: 'string', enum: ['status', 'undo', 'redo', 'reindex'] } },
                    required: ['command']
                }
            },
            {
                name: 'reconstruct_interface',
                description: 'Reconstruct a ghost interface based on observed call sites.',
                inputSchema: {
                    type: 'object',
                    properties: { symbolName: { type: 'string' } },
                    required: ['symbolName']
                }
            }
        ];

        const pillarTools = [
            {
                name: 'understand',
                description: 'Deeply analyzes code structure and architecture.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        goal: { type: 'string' },
                        depth: { type: 'string', enum: ['shallow', 'standard', 'deep'] }
                    },
                    required: ['goal']
                }
            },
            {
                name: 'change',
                description: 'Safely modifies code with impact analysis.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        intent: { type: 'string' },
                        target: { type: 'string' },
                        edits: { type: 'array' },
                        options: { type: 'object' }
                    },
                    required: ['intent']
                }
            },
            {
                name: 'navigate',
                description: 'Locates symbols and files across the project.',
                inputSchema: {
                    type: 'object',
                    properties: { target: { type: 'string' } },
                    required: ['target']
                }
            },
            {
                name: 'read',
                description: 'Reads file content efficiently.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        target: { type: 'string' },
                        view: { type: 'string', enum: ['full', 'skeleton', 'fragment'] },
                        lineRange: { type: 'string' }
                    },
                    required: ['target']
                }
            },
            {
                name: 'write',
                description: 'Creates new files or scaffolds content.',
                inputSchema: {
                    type: 'object',
                    properties: { intent: { type: 'string' } },
                    required: ['intent']
                }
            },
            {
                name: 'manage',
                description: 'Manages project state and transactions.',
                inputSchema: {
                    type: 'object',
                    properties: { command: { type: 'string', enum: ['status', 'undo', 'redo', 'reindex'] } },
                    required: ['command']
                }
            }
        ];

        const compatTools: any[] = [];
        if (process.env.SMART_CONTEXT_EXPOSE_COMPAT_TOOLS === "true") {
            compatTools.push(
                {
                    name: 'read_file',
                    description: 'Returns Smart File Profile or raw file content.',
                    inputSchema: {
                        type: 'object',
                        properties: { filePath: { type: 'string' }, full: { type: 'boolean' } },
                        required: ['filePath']
                    }
                },
                {
                    name: 'write_file',
                    description: 'Writes or creates a file with provided content.',
                    inputSchema: {
                        type: 'object',
                        properties: { filePath: { type: 'string' }, content: { type: 'string' } },
                        required: ['filePath', 'content']
                    }
                },
                {
                    name: 'analyze_file',
                    description: 'Analyze a single file and return summary metadata.',
                    inputSchema: {
                        type: 'object',
                        properties: { filePath: { type: 'string' } },
                        required: ['filePath']
                    }
                }
            );
        }

        return [...legacyTools, ...pillarTools, ...compatTools];
    }

    private async handleCallTool(name: string, args: any): Promise<any> {
        try {
            const pillarTools = new Set(['understand', 'change', 'navigate', 'read', 'write', 'manage']);
            const legacyTools = new Set([
                'read_code',
                'search_project',
                'search_files',
                'read_file',
                'read_fragment',
                'analyze_relationship',
                'edit_code',
                'edit_file',
                'get_batch_guidance',
                'manage_project',
                'reconstruct_interface'
            ]);
            const compatTools = new Set(['read_file', 'write_file', 'analyze_file']);

            if (pillarTools.has(name)) {
                const missing = this.validateRequiredArgs(name, args);
                if (missing.length > 0) {
                    return this.errorResponse("MissingParameter", `Missing required parameter(s): ${missing.join(', ')}`);
                }
                const result = await this.orchestrationEngine.executePillar(name, args);
                return this.jsonResponse(result);
            }

            if (legacyTools.has(name) || (compatTools.has(name) && process.env.SMART_CONTEXT_EXPOSE_COMPAT_TOOLS === "true")) {
                const missing = this.validateRequiredArgs(name, args);
                if (missing.length > 0) {
                    return this.errorResponse("MissingParameter", `Missing required parameter(s): ${missing.join(', ')}`);
                }
                this.warnLegacyTool(name);
                switch (name) {
                    case 'read_code':
                        return this.textResponse(await this.readCodeRaw(args));
                    case 'search_project':
                        return this.jsonResponse(await this.searchProjectRaw(args));
                    case 'search_files':
                        return this.jsonResponse(await this.searchFilesRaw(args));
                    case 'read_file':
                        return this.jsonResponse(await this.readFileRaw(args));
                    case 'read_fragment':
                        return this.jsonResponse(await this.readFragmentRaw(args));
                    case 'analyze_relationship':
                        return this.jsonResponse(await this.analyzeRelationshipRaw(args));
                    case 'edit_code':
                        return this.jsonResponse(await this.editCodeRaw(args));
                    case 'edit_file': {
                        const result = await this.editFileRaw(args);
                        return {
                            isError: !result.success,
                            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
                        };
                    }
                    case 'get_batch_guidance':
                        return this.jsonResponse(await this.executeGetBatchGuidance(args));
                    case 'manage_project':
                        return this.jsonResponse(await this.manageProjectRaw(args));
                    case 'reconstruct_interface':
                        return this.jsonResponse(await this.executeReconstructInterface(args));
                    case 'read_file':
                        return this.jsonResponse(await this.readFileRaw(args));
                    case 'write_file':
                        return this.jsonResponse(await this.executeWriteFile(args));
                    case 'analyze_file':
                        return this.jsonResponse(await this.executeAnalyzeFile(args));
                    default:
                        break;
                }
            }

            if (process.env.SMART_CONTEXT_LEGACY_AUTOMAP === "true") {
                const adapted = this.legacyAdapter.adapt(name, args);
                if (adapted) {
                    const result = await this.orchestrationEngine.executePillar(adapted.category, adapted.args);
                    return this.jsonResponse(result);
                }
            }

            throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        } catch (error: any) {
            if (error instanceof McpError) {
                throw error;
            }
            return this.errorResponse(error?.code ?? "InternalError", error?.message ?? "Unknown error", error?.details);
        }
    }

    private warnLegacyTool(toolName: string): void {
        console.warn(JSON.stringify({
            code: "TOOL_DEPRECATED",
            tool: toolName,
            message: `${toolName} is deprecated. Prefer Six Pillars tools.`,
        }));
    }

    private validateRequiredArgs(toolName: string, args: any): string[] {
        const requiredMap: Record<string, string[]> = {
            read_code: ['filePath'],
            search_project: ['query'],
            search_files: [],
            read_file: ['filePath'],
            read_fragment: ['filePath'],
            analyze_relationship: ['target', 'mode'],
            edit_code: ['edits'],
            edit_file: ['filePath', 'edits'],
            get_batch_guidance: ['filePaths'],
            manage_project: ['command'],
            reconstruct_interface: ['symbolName'],
            write_file: ['filePath', 'content'],
            analyze_file: ['filePath'],
            understand: ['goal'],
            change: ['intent'],
            navigate: ['target'],
            read: ['target'],
            write: ['intent'],
            manage: ['command']
        };
        const required = requiredMap[toolName] || [];
        const missing: string[] = [];
        for (const key of required) {
            if (args?.[key] === undefined || args?.[key] === null) {
                missing.push(key);
            }
        }
        return missing;
    }

    private jsonResponse(payload: any): any {
        return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
    }

    private textResponse(text: string): any {
        return { content: [{ type: 'text', text }] };
    }

    private errorResponse(errorCode: string, message: string, details?: any): any {
        return {
            isError: true,
            content: [{ type: 'text', text: JSON.stringify({ errorCode, message, details }) }]
        };
    }

    private resolveRelativePath(inputPath: string): string {
        return this.pathNormalizer.normalize(inputPath);
    }

    private resolveAbsolutePath(inputPath: string): string {
        return this.pathNormalizer.toAbsolute(this.resolveRelativePath(inputPath));
    }

    private parseLineRanges(raw?: string): Array<{ start: number; end: number }> {
        if (!raw || typeof raw !== 'string') return [];
        const ranges: Array<{ start: number; end: number }> = [];
        for (const part of raw.split(',')) {
            const trimmed = part.trim();
            if (!trimmed) continue;
            const match = trimmed.match(/^(\d+)(?:\s*[-:]\s*(\d+))?$/);
            if (!match) continue;
            const start = parseInt(match[1], 10);
            const end = match[2] ? parseInt(match[2], 10) : start;
            if (Number.isFinite(start) && Number.isFinite(end)) {
                ranges.push({ start: Math.min(start, end), end: Math.max(start, end) });
            }
        }
        return ranges;
    }

    private async readCodeRaw(args: any): Promise<string> {
        const view = (args?.view ?? 'skeleton') as string;
        const filePath = this.resolveRelativePath(args.filePath);
        const absPath = this.resolveAbsolutePath(args.filePath);

        if (view === 'fragment') {
            const ranges = this.parseLineRanges(args.lineRange);
            const fragment = await this.contextEngine.readFragment(absPath, ranges);
            return fragment.content;
        }

        if (view === 'full') {
            return this.fileSystem.readFile(filePath);
        }

        const skeletonOptions = args?.skeletonOptions ?? {};
        return this.skeletonCache.getSkeleton(
            absPath,
            skeletonOptions,
            async (targetPath, options) => {
                const content = await this.fileSystem.readFile(filePath);
                return this.skeletonGenerator.generateSkeleton(targetPath, content, options);
            }
        );
    }

    private async searchProjectRaw(args: any) {
        const query = args?.query ?? args?.keywords?.join?.(' ') ?? args?.patterns?.join?.(' ');
        if (!query) {
            throw new Error("Missing required parameter: query");
        }
        const maxResults = typeof args.maxResults === "number"
            ? args.maxResults
            : (typeof args.limit === "number" ? args.limit : 20);
        const declaredType = (args.type ?? 'auto') as string;
        const inferredType = this.inferSearchType(query, declaredType);
        let results: any[] = [];

        if (inferredType === 'filename') {
            results = await this.searchEngine.searchFilenames(query, { maxResults });
        } else if (inferredType === 'symbol') {
            const matches = await this.symbolIndex.search(query);
            results = matches.slice(0, maxResults).map(match => ({
                type: 'symbol',
                path: match.filePath,
                score: 1,
                context: `${match.symbol.type} ${match.symbol.name}`
            }));
        } else if (inferredType === 'directory') {
            const files = await this.fileSystem.listFiles(this.rootPath);
            const dirs = new Set<string>();
            for (const file of files) {
                dirs.add(path.dirname(path.relative(this.rootPath, file)).replace(/\\/g, '/'));
            }
            results = Array.from(dirs)
                .filter(dir => dir.toLowerCase().includes(String(query).toLowerCase()))
                .slice(0, maxResults)
                .map(dir => ({
                    type: 'directory',
                    path: dir,
                    score: 1,
                    context: `Directory: ${dir}`
                }));
        } else {
            const scoutResults = await this.searchEngine.scout({
                query,
                includeGlobs: args.includeGlobs,
                excludeGlobs: args.excludeGlobs,
                fileTypes: args.fileTypes,
                snippetLength: args.snippetLength,
                matchesPerFile: args.matchesPerFile,
                groupByFile: args.groupByFile,
                deduplicateByContent: args.deduplicateByContent,
                basePath: args.basePath,
                maxResults
            });

            results = scoutResults.slice(0, maxResults).map(result => ({
                type: 'file',
                path: result.filePath,
                score: result.score ?? 0,
                context: result.preview,
                line: result.lineNumber,
                groupedMatches: result.groupedMatches,
                matchCount: result.matchCount
            }));
        }

        if (results.length === 0) {
            const enhanced = ErrorEnhancer.enhanceSearchNotFound(query);
            return {
                results: [],
                inferredType,
                message: `No results found for "${query}".`,
                suggestions: enhanced.toolSuggestions,
                nextActionHint: enhanced.nextActionHint
            };
        }

        return {
            results,
            inferredType
        };
    }

    private async searchFilesRaw(args: any) {
        const results = await this.searchEngine.scout({
            query: args?.query,
            keywords: args?.keywords,
            patterns: args?.patterns,
            includeGlobs: args?.includeGlobs,
            excludeGlobs: args?.excludeGlobs,
            fileTypes: args?.fileTypes,
            snippetLength: args?.snippetLength,
            matchesPerFile: args?.matchesPerFile,
            groupByFile: args?.groupByFile,
            deduplicateByContent: args?.deduplicateByContent,
            basePath: args?.basePath,
            smartCase: args?.smartCase,
            caseSensitive: args?.caseSensitive,
            wordBoundary: args?.wordBoundary,
            maxResults: args?.maxResults
        });
        return results;
    }

    private inferSearchType(query: string, declared: string): "file" | "symbol" | "directory" | "filename" {
        if (declared && declared !== "auto") {
            return declared as any;
        }
        if (/[\\/]/.test(query) || /\.[a-z0-9]+$/i.test(query)) {
            return "filename";
        }
        if (query.endsWith('/')) {
            return "directory";
        }
        return "file";
    }

    private async analyzeRelationshipRaw(args: any) {
        const target = args?.target;
        const mode = args?.mode as string;
        const direction = (args?.direction ?? 'both') as string;
        const maxDepth = typeof args?.maxDepth === "number" ? args.maxDepth : 2;
        const contextPath = args?.contextPath;

        const resolved = await this.resolveRelationshipTarget(target, args?.targetType ?? 'auto', contextPath);
        if (resolved.isError) {
            const error = new Error(resolved.message ?? "Unable to resolve target.");
            (error as any).code = resolved.errorCode ?? "InternalError";
            (error as any).details = resolved.details;
            throw error;
        }

        const { filePath, symbolName, resolvedType } = resolved;
        if (!filePath) {
            throw new Error("Unable to resolve target file.");
        }

        if (mode === 'impact') {
            const impact = await this.executeImpactAnalyzer({ target: filePath });
            const nodes = [{ id: filePath, type: 'file', path: filePath, label: filePath }];
            const edges = (impact?.summary?.impactedFiles ?? []).map((pathValue: string) => {
                nodes.push({ id: pathValue, type: 'file', path: pathValue, label: pathValue });
                return { source: filePath, target: pathValue, relation: 'impact' };
            });
            return {
                nodes,
                edges,
                resolvedTarget: { type: resolvedType, path: filePath, symbolName }
            };
        }

        if (mode === 'dependencies') {
            await this.dependencyGraph.ensureBuilt();
            const deps = await this.dependencyGraph.getDependencies(filePath, direction as any);
            const nodes = new Map<string, any>();
            const edges = deps.map(dep => {
                nodes.set(dep.from, { id: dep.from, type: 'file', path: dep.from });
                nodes.set(dep.to, { id: dep.to, type: 'file', path: dep.to });
                return { source: dep.from, target: dep.to, relation: dep.type };
            });
            nodes.set(filePath, { id: filePath, type: 'file', path: filePath });
            return {
                nodes: Array.from(nodes.values()),
                edges,
                resolvedTarget: { type: resolvedType, path: filePath, symbolName }
            };
        }

        if ((mode === 'calls' || mode === 'data_flow' || mode === 'types') && !symbolName) {
            throw new Error("Symbol name required for this analysis mode.");
        }

        if (mode === 'calls') {
            const graph = await this.callGraphBuilder.analyzeSymbol(symbolName!, filePath, direction as any, maxDepth);
            if (!graph) {
                const enhanced = ErrorEnhancer.enhanceSymbolNotFound(symbolName!, this.symbolIndex);
                const error = new Error(`Symbol '${symbolName}' not found.`);
                (error as any).code = "SymbolNotFound";
                (error as any).details = enhanced;
                throw error;
            }
            const nodes = Object.values(graph.visitedNodes).map(node => ({
                id: node.symbolId,
                type: node.symbolType,
                path: node.filePath,
                label: node.symbolName
            }));
            const edges = Object.values(graph.visitedNodes).flatMap(node =>
                node.callees.map(edge => ({ source: edge.fromSymbolId, target: edge.toSymbolId, relation: edge.callType }))
                    .concat(node.callers.map(edge => ({ source: edge.fromSymbolId, target: edge.toSymbolId, relation: edge.callType })))
            );
            return {
                nodes,
                edges,
                resolvedTarget: { type: 'symbol', path: filePath, symbolName }
            };
        }

        if (mode === 'data_flow') {
            const flow = await this.dataFlowTracer.traceVariable(symbolName!, filePath, args?.fromLine, args?.maxSteps ?? 10);
            if (!flow) {
                throw new Error("No data flow information available.");
            }
            const nodes = Object.values(flow.steps).map(step => ({
                id: step.id,
                type: step.stepType,
                path: step.filePath,
                label: step.textSnippet
            }));
            const edges = flow.edges.map(edge => ({
                source: edge.fromStepId,
                target: edge.toStepId,
                relation: edge.relation
            }));
            return {
                nodes,
                edges,
                resolvedTarget: { type: 'variable', path: filePath, symbolName }
            };
        }

        if (mode === 'types') {
            const graph = await this.typeDependencyTracker.analyzeType(symbolName!, filePath, direction as any, maxDepth);
            if (!graph) {
                throw new Error("Type dependency graph unavailable.");
            }
            const nodes = Object.values(graph.visitedNodes).map(node => ({
                id: node.symbolId,
                type: node.symbolType,
                path: node.filePath,
                label: node.symbolName
            }));
            const edges = Object.values(graph.visitedNodes).flatMap(node =>
                node.dependencies.map(edge => ({ source: edge.fromSymbolId, target: edge.toSymbolId, relation: edge.relationKind }))
                    .concat(node.parents.map(edge => ({ source: edge.fromSymbolId, target: edge.toSymbolId, relation: edge.relationKind })))
            );
            return {
                nodes,
                edges,
                resolvedTarget: { type: 'symbol', path: filePath, symbolName }
            };
        }

        const error = new Error(`Unknown analyze_relationship mode: ${mode}`);
        (error as any).code = "InvalidMode";
        throw error;
    }

    private async editFileRaw(args: any) {
        const filePath = this.resolveRelativePath(args.filePath);
        const absPath = this.resolveAbsolutePath(args.filePath);
        const edits = Array.isArray(args?.edits) ? args.edits : [];
        const mapped = edits.map((edit: any) => ({
            targetString: edit.targetString ?? "",
            replacementString: edit.replacementString ?? "",
            lineRange: edit.lineRange,
            beforeContext: edit.beforeContext,
            afterContext: edit.afterContext,
            fuzzyMode: edit.fuzzyMode,
            anchorSearchRange: edit.anchorSearchRange,
            indexRange: edit.indexRange,
            normalization: edit.normalization,
            normalizationConfig: edit.normalizationConfig,
            expectedHash: edit.expectedHash,
            contextFuzziness: edit.contextFuzziness,
            insertMode: edit.insertMode,
            insertLineRange: edit.insertLineRange,
            escapeMode: edit.escapeMode
        }));
        const result = await this.editCoordinator.applyEdits(
            absPath,
            mapped,
            Boolean(args?.dryRun)
        );
        if (result.success) {
            return result;
        }
        return {
            ...result,
            filePath,
            details: result.details
        };
    }

    private async resolveRelationshipTarget(target: string, targetType: string, contextPath?: string): Promise<{ isError?: boolean; errorCode?: string; message?: string; details?: any; filePath?: string; symbolName?: string; resolvedType: 'file' | 'symbol' | 'variable' }> {
        if (!target) {
            return { isError: true, errorCode: "MissingParameter", message: "Missing required parameter: target", resolvedType: 'file' };
        }
        const inferredType = targetType === 'auto' ? (/[\\/]/.test(target) || /\.[a-z0-9]+$/i.test(target) ? 'file' : 'symbol') : targetType;

        if (inferredType === 'file') {
            const filePath = this.resolveRelativePath(target);
            return { filePath, resolvedType: 'file' };
        }

        const symbolName = target;
        let filePath: string | undefined;
        if (contextPath) {
            filePath = this.resolveRelativePath(contextPath);
        } else {
            const matches = await this.symbolIndex.search(symbolName);
            if (matches.length > 0) {
                filePath = matches[0].filePath;
            }
        }
        if (!filePath) {
            const enhanced = ErrorEnhancer.enhanceSymbolNotFound(symbolName, this.symbolIndex);
            return { isError: true, errorCode: "SymbolNotFound", message: `Symbol '${symbolName}' not found.`, details: enhanced, resolvedType: 'symbol' };
        }
        return { filePath, symbolName, resolvedType: 'symbol' };
    }

    private async executeImpactAnalyzer(args: any) {
        const target = args?.target;
        if (!target) {
            return null;
        }
        const absPath = this.resolveAbsolutePath(target);
        return this.impactAnalyzer.analyzeImpact(absPath, args?.edits ?? []);
    }

    private async executeEditCoordinator(args: any) {
        const filePath = args?.filePath ? this.resolveRelativePath(args.filePath) : undefined;
        const edits = Array.isArray(args?.edits) ? args.edits : [];
        const dryRun = Boolean(args?.dryRun);
        if (!filePath) {
            return { success: false, message: 'Missing filePath for edit_coordinator.' };
        }
        if (edits.length === 0) {
            return { success: false, message: 'No edits provided for edit_coordinator.' };
        }
        return this.editCoordinator.applyEdits(this.resolveAbsolutePath(filePath), edits, dryRun);
    }

    private async editCodeRaw(args: any) {
        const edits = Array.isArray(args?.edits) ? args.edits : [];
        if (edits.length === 0) {
            return { success: false, results: [], message: "No edits provided." };
        }

        const dryRun = Boolean(args?.dryRun);
        const diffMode = args?.diffMode;
        const createMissingDirectories = Boolean(args?.createMissingDirectories);
        const results: any[] = [];

        const editsByFile = new Map<string, any[]>();
        const createOps: any[] = [];
        const deleteOps: any[] = [];

        for (const edit of edits) {
            if (!edit?.filePath) {
                continue;
            }
            if (edit.operation === 'create') {
                createOps.push(edit);
                continue;
            }
            if (edit.operation === 'delete') {
                deleteOps.push(edit);
                continue;
            }
            const filePath = this.resolveRelativePath(edit.filePath);
            const fileEdits = editsByFile.get(filePath) ?? [];
            fileEdits.push({
                targetString: edit.targetString ?? "",
                replacementString: edit.replacementString ?? "",
                lineRange: edit.lineRange,
                beforeContext: edit.beforeContext,
                afterContext: edit.afterContext,
                fuzzyMode: edit.fuzzyMode,
                anchorSearchRange: edit.anchorSearchRange,
                indexRange: edit.indexRange,
                normalization: edit.normalization,
                normalizationConfig: edit.normalizationConfig,
                expectedHash: edit.expectedHash,
                contextFuzziness: edit.contextFuzziness,
                insertMode: edit.insertMode,
                insertLineRange: edit.insertLineRange,
                escapeMode: edit.escapeMode
            });
            editsByFile.set(filePath, fileEdits);
        }

        for (const create of createOps) {
            const relPath = this.resolveRelativePath(create.filePath);
            const absPath = this.resolveAbsolutePath(relPath);
            if (!dryRun) {
                const dir = path.dirname(absPath);
                if (createMissingDirectories) {
                    await this.fileSystem.createDir(dir);
                }
                await this.fileSystem.writeFile(absPath, create.replacementString ?? "");
            }
            results.push({ filePath: relPath, applied: !dryRun, diff: undefined });
        }

        for (const del of deleteOps) {
            const relPath = this.resolveRelativePath(del.filePath);
            const absPath = this.resolveAbsolutePath(relPath);
            const stats = await this.fileSystem.stat(relPath).catch(() => undefined);
            const sizeBytes = stats?.size ?? 0;
            const confirmationHash = del.confirmationHash;
            const safetyLevel = del.safetyLevel ?? 'normal';

            if (sizeBytes > 10_000 && !confirmationHash && safetyLevel !== 'force') {
                results.push({
                    filePath: relPath,
                    applied: false,
                    requiresConfirmation: true,
                    error: 'Deletion requires confirmation for large files.',
                    fileSize: sizeBytes
                });
                continue;
            }

            if (confirmationHash) {
                const content = await this.fileSystem.readFile(relPath);
                const expected = typeof confirmationHash === 'string' ? confirmationHash : confirmationHash.value;
                const algo = typeof confirmationHash === 'string' ? 'sha256' : (confirmationHash.algorithm ?? 'sha256');
                const hash = this.computeHash(content, algo);
                if (hash !== expected) {
                    results.push({
                        filePath: relPath,
                        applied: false,
                        hashMismatch: true,
                        error: 'Hash mismatch detected; deletion blocked.',
                        fileSize: sizeBytes
                    });
                    continue;
                }
            }

            if (!dryRun) {
                await this.fileSystem.deleteFile(absPath);
            }
            results.push({ filePath: relPath, applied: !dryRun });
        }

        const fileEntries = Array.from(editsByFile.entries());
        if (fileEntries.length === 1) {
            const [filePath, fileEdits] = fileEntries[0];
            const result = await this.editCoordinator.applyEdits(
                this.resolveAbsolutePath(filePath),
                fileEdits,
                dryRun,
                diffMode ? { diffMode } : undefined
            );
            if (result.success) {
                results.push({
                    filePath,
                    applied: !dryRun,
                    diff: result.diff,
                    fileSize: result.operation?.filePath ? undefined : undefined
                });
            } else {
                results.push({
                    filePath,
                    applied: false,
                    error: result.message ?? "Edit failed."
                });
            }
            return {
                success: result.success,
                results,
                message: result.message
            };
        }

        if (fileEntries.length > 1) {
            const batch = fileEntries.map(([filePath, fileEdits]) => ({
                filePath: this.resolveAbsolutePath(filePath),
                edits: fileEdits
            }));
            const result = await this.editCoordinator.applyBatchEdits(batch, dryRun, diffMode ? { diffMode } : undefined);
            for (const [filePath] of fileEntries) {
                results.push({ filePath, applied: result.success && !dryRun });
            }
            return {
                success: result.success,
                results,
                message: result.message
            };
        }

        return { success: results.length > 0, results };
    }

    private async manageProjectRaw(args: any) {
        const command = args?.command;
        switch (command) {
            case 'undo':
                {
                    const result = await this.editCoordinator.undo();
                    return { success: result.success, output: result.message ?? "Undo complete.", result };
                }
            case 'redo':
                {
                    const result = await this.editCoordinator.redo();
                    return { success: result.success, output: result.message ?? "Redo complete.", result };
                }
            case 'status':
                await this.dependencyGraph.ensureBuilt();
                return { success: true, output: "Index status", status: await this.dependencyGraph.getIndexStatus() };
            case 'reindex':
                await this.skeletonCache.clearAll();
                await this.searchEngine.rebuild();
                await this.dependencyGraph.build();
                return { success: true, output: "Reindex completed." };
            default:
                return { success: false, output: `Unknown manage_project command: ${command}` };
        }
    }

    private async readFileRaw(args: any) {
        const filePath = this.resolveRelativePath(args.filePath);
        const absPath = this.resolveAbsolutePath(args.filePath);

        try {
            if (args?.full) {
                const content = await this.fileSystem.readFile(filePath);
                const maxBytes = parseInt(process.env.SMART_CONTEXT_READ_FILE_MAX_BYTES || "", 10);
                const effectiveMax = Number.isFinite(maxBytes) ? maxBytes : content.length;
                const buffer = Buffer.from(content, 'utf-8');
                const truncated = buffer.length > effectiveMax;
                const slice = truncated ? buffer.slice(0, effectiveMax).toString('utf-8') : content;
                const stats = await this.fileSystem.stat(filePath);
                return {
                    content: slice,
                    meta: {
                        truncated,
                        bytesReturned: Buffer.byteLength(slice, 'utf-8'),
                        maxBytes: effectiveMax,
                        fileSizeBytes: stats.size,
                        nextAction: { tool: 'read_code', args: { filePath, view: 'skeleton' } }
                    }
                };
            }

            return await this.readFileProfileRaw({ filePath });
        } catch (error: any) {
            const wrapped = new Error(error?.message ?? 'Failed to read file.');
            (wrapped as any).code = 'InternalError';
            throw wrapped;
        }
    }

    private async readFragmentRaw(args: any) {
        const filePath = this.resolveRelativePath(args.filePath);
        const absPath = this.resolveAbsolutePath(args.filePath);
        try {
            const content = await this.fileSystem.readFile(filePath);
            const lines = content.split(/\r?\n/);
            const contextLines = typeof args?.contextLines === 'number' ? args.contextLines : 0;
            const ranges: Array<{ start: number; end: number }> = [];

            if (Array.isArray(args?.lineRanges) && args.lineRanges.length > 0) {
                for (const range of args.lineRanges) {
                    if (range?.start && range?.end) {
                        ranges.push({ start: range.start, end: range.end });
                    }
                }
            } else if (Array.isArray(args?.keywords) && args.keywords.length > 0) {
                for (let i = 0; i < lines.length; i++) {
                    const line = lines[i];
                    if (args.keywords.some((kw: string) => line.includes(kw))) {
                        const lineNumber = i + 1;
                        ranges.push({ start: lineNumber, end: lineNumber });
                    }
                }
            }

            const fragment = await this.contextEngine.readFragment(absPath, ranges, contextLines);
            return fragment;
        } catch (error: any) {
            throw new Error(`File not found: ${filePath}`);
        }
    }

    private async readFileProfileRaw(args: any) {
        const filePath = this.resolveRelativePath(args.filePath);
        const absPath = this.resolveAbsolutePath(args.filePath);
        const content = await this.fileSystem.readFile(filePath);
        const stats = await this.fileSystem.stat(filePath);
        const metadata = FileProfiler.analyzeMetadata(content, absPath);
        await this.dependencyGraph.ensureBuilt();
        const outgoing = await this.dependencyGraph.getDependencies(filePath, 'downstream');
        const incoming = await this.dependencyGraph.getDependencies(filePath, 'upstream');
        let skeleton = '';
        let symbols: any[] = [];
        try {
            skeleton = await this.skeletonGenerator.generateSkeleton(absPath, content);
            symbols = await this.symbolIndex.getSymbolsForFile(absPath);
        } catch (error: any) {
            const fallback = this.buildSkeletonFallback(content, error?.message);
            skeleton = fallback;
            symbols = [];
        }

        return {
            metadata: {
                filePath: absPath,
                relativePath: filePath,
                sizeBytes: stats.size,
                lineCount: content.length === 0 ? 0 : content.split(/\r?\n/).length,
                language: path.extname(filePath).replace('.', '') || null,
                lastModified: new Date(stats.mtime).toISOString(),
                newlineStyle: metadata.newlineStyle,
                encoding: 'utf-8',
                hasBOM: metadata.hasBOM,
                usesTabs: metadata.usesTabs,
                indentSize: metadata.indentSize,
                isConfigFile: metadata.isConfigFile,
                configType: metadata.configType,
                configScope: metadata.configScope
            },
            structure: {
                skeleton,
                symbols
            },
            usage: {
                incomingCount: incoming.length,
                incomingFiles: Array.from(new Set(incoming.map(edge => edge.from))),
                outgoingCount: outgoing.length,
                outgoingFiles: Array.from(new Set(outgoing.map(edge => edge.to)))
            },
            guidance: {
                bodyHidden: true,
                readFullHint: `Use read_code with view="full" to see full content of ${filePath}.`,
                readFragmentHint: `Use read_code with view="fragment" and lineRange to zoom into specific sections.`
            }
        };
    }

    private buildSkeletonFallback(content: string, message?: string): string {
        const header = `Skeleton generation failed: ${message ?? "Unknown error"}`;
        if (content.length <= 5000) {
            return `${header}\n${content}`;
        }
        const head = content.slice(0, 400);
        const tail = content.slice(-400);
        return `${header}\n--- Preview (start) ---\n${head}\n--- Preview (end) ---\n${tail}`;
    }

    private computeHash(content: string, algorithm: 'sha256' | 'xxhash' = 'sha256'): string {
        if (algorithm === 'sha256') {
            return crypto.createHash('sha256').update(content).digest('hex');
        }
        // Fallback to sha256 if xxhash is unavailable.
        return crypto.createHash('sha256').update(content).digest('hex');
    }

    private async executeWriteFile(args: any) {
        const filePath = this.resolveRelativePath(args.filePath);
        const absPath = this.resolveAbsolutePath(args.filePath);
        const content = args?.content ?? "";
        await this.fileSystem.writeFile(absPath, content);
        this.fileVersionManager.incrementVersion(absPath, content);
        return { success: true, filePath };
    }

    private async executeAnalyzeFile(args: any) {
        const filePath = this.resolveRelativePath(args.filePath);
        const content = await this.fileSystem.readFile(filePath);
        const stats = await this.fileSystem.stat(filePath);
        return {
            filePath,
            sizeBytes: stats.size,
            lineCount: content.length === 0 ? 0 : content.split(/\r?\n/).length,
            language: path.extname(filePath).replace('.', '') || null
        };
    }

    private async executeGetBatchGuidance(args: any) {
        const filePaths = Array.isArray(args?.filePaths) ? args.filePaths : [];
        return {
            clusters: [],
            companionSuggestions: filePaths.map((filePath: string) => ({
                filePath,
                reason: "Review adjacent modules for cross-file edits."
            })),
            opportunities: []
        };
    }

    private async executeReconstructInterface(args: any) {
        const symbolName = args?.symbolName;
        if (!symbolName) {
            return { success: false, message: "symbolName is required." };
        }
        const ghostInterface = await this.fallbackResolver.reconstructGhostInterface(symbolName);
        if (!ghostInterface) {
            return { success: false, message: "Ghost interface reconstruction failed." };
        }
        return { success: true, ghostInterface };
    }

        public async shutdown() {
        await this.server.close();
    }

    public async waitForInitialScan() {
        // Simple delay or bridge to incremental indexer
        return new Promise(resolve => setTimeout(resolve, 100));
    }

    public async run() {

        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.error("Smart Context MCP Server running on stdio");
    }
}

const server = new SmartContextServer(process.cwd());
server.run().catch(console.error);
