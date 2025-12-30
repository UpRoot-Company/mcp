
import "./utils/StdoutGuard.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import * as fs from "fs";
import * as path from "path";
import ignore from "ignore";
import * as url from "url";
import * as crypto from "crypto";
import util from "util";

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
import { DocumentIndexer } from "./indexing/DocumentIndexer.js";
import { EmbeddingRepository } from "./indexing/EmbeddingRepository.js";
import { DocumentChunkRepository } from "./indexing/DocumentChunkRepository.js";
import { TransactionLog } from "./engine/TransactionLog.js";
import { ConfigurationManager } from "./config/ConfigurationManager.js";
import { PathManager } from "./utils/PathManager.js";
import { FileVersionManager } from "./engine/FileVersionManager.js";
import { PathNormalizer } from "./utils/PathNormalizer.js";
import { AstAwareDiff } from "./engine/AstAwareDiff.js";
import { NodeFileSystem } from "./platform/FileSystem.js";
import { ErrorEnhancer } from "./errors/ErrorEnhancer.js";
import { ResourceUsage } from "./types.js";
import { GhostInterfaceBuilder } from "./resolution/GhostInterfaceBuilder.js";
import { FallbackResolver } from "./resolution/FallbackResolver.js";
import { CallSiteAnalyzer } from "./ast/analysis/CallSiteAnalyzer.js";
import { HotSpotDetector } from "./engine/ClusterSearch/HotSpotDetector.js";
import { ReferenceFinder } from "./ast/ReferenceFinder.js";
import { DocumentProfiler } from "./documents/DocumentProfiler.js";
import { DocumentSearchEngine } from "./documents/search/DocumentSearchEngine.js";
import { EmbeddingProviderFactory } from "./embeddings/EmbeddingProviderFactory.js";
import { resolveEmbeddingConfigFromEnv } from "./embeddings/EmbeddingConfig.js";

// Orchestration Imports
import { OrchestrationEngine } from "./orchestration/OrchestrationEngine.js";
import { IntentRouter } from "./orchestration/IntentRouter.js";
import { WorkflowPlanner } from "./orchestration/WorkflowPlanner.js";
import { InternalToolRegistry } from "./orchestration/InternalToolRegistry.js";
import { LegacyToolAdapter } from "./orchestration/LegacyToolAdapter.js";
import { CachingStrategy } from "./orchestration/CachingStrategy.js";

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
    private historyEngine: HistoryEngine;
    private configurationManager: ConfigurationManager;
    private astManager: AstManager;
    private skeletonGenerator: SkeletonGenerator;
    private skeletonCache: SkeletonCache;
    private symbolIndex: SymbolIndex;
    private dependencyGraph: DependencyGraph;
    private callGraphBuilder: CallGraphBuilder;
    private typeDependencyTracker: TypeDependencyTracker;
    private dataFlowTracer: DataFlowTracer;
    private moduleResolver: ModuleResolver;
    private referenceFinder: ReferenceFinder;
    private contextEngine: ContextEngine;
    private fileVersionManager: FileVersionManager;
    private pathNormalizer: PathNormalizer;
    private hotSpotDetector: HotSpotDetector;
    private documentProfiler: DocumentProfiler;
    private documentIndexer?: DocumentIndexer;
    private embeddingRepository: EmbeddingRepository;
    private embeddingProviderFactory: EmbeddingProviderFactory;
    private documentSearchEngine: DocumentSearchEngine;
    private ghostInterfaceBuilder: GhostInterfaceBuilder;
    private fallbackResolver: FallbackResolver;
    private clusterSearchEngine: ClusterSearchEngine;
    private impactAnalyzer: ImpactAnalyzer;
    private indexDatabase: IndexDatabase;
    private logStream?: fs.WriteStream;
    private logStreams?: {
        console: fs.WriteStream;
        warn: fs.WriteStream;
        error: fs.WriteStream;
        stdout: fs.WriteStream;
        stderr: fs.WriteStream;
    };
    private diagnosticsInitialized = false;
    private reindexInProgress = false;
    private reindexLastResult?: { success: boolean; output: string; startedAt: string; finishedAt?: string };
    private heartbeatTimer?: NodeJS.Timeout;
    private shutdownRequested = false;
    private shutdownTimer?: NodeJS.Timeout;

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
        this.initFileLogger();
        this.initProcessDiagnostics();
        this.astManager = AstManager.getInstance();
        this.pathNormalizer = new PathNormalizer(this.rootPath);
        this.configurationManager = new ConfigurationManager(this.rootPath);
        const initialIgnorePatterns = this.configurationManager.getIgnoreGlobs();
        const ignoreFilter = this.createIgnoreFilter(initialIgnorePatterns);
        this.contextEngine = new ContextEngine(ignoreFilter, this.fileSystem);
        
        // Initialize Core Engines
        this.skeletonGenerator = new SkeletonGenerator();
        this.skeletonCache = new SkeletonCache(this.rootPath);
        this.indexDatabase = new IndexDatabase(this.rootPath);
        this.embeddingRepository = new EmbeddingRepository(this.indexDatabase);
        this.embeddingProviderFactory = new EmbeddingProviderFactory(resolveEmbeddingConfigFromEnv());
        this.documentProfiler = new DocumentProfiler(this.rootPath);
        this.documentIndexer = new DocumentIndexer(this.rootPath, this.fileSystem, this.indexDatabase, {
            embeddingRepository: this.embeddingRepository
        });
        this.symbolIndex = new SymbolIndex(this.rootPath, this.skeletonGenerator, initialIgnorePatterns, this.indexDatabase);
        this.moduleResolver = new ModuleResolver(this.rootPath);
        this.dependencyGraph = new DependencyGraph(this.rootPath, this.symbolIndex, this.moduleResolver, this.indexDatabase);
        this.callGraphBuilder = new CallGraphBuilder(this.rootPath, this.symbolIndex, this.moduleResolver);
        this.typeDependencyTracker = new TypeDependencyTracker(this.rootPath, this.symbolIndex);
        this.dataFlowTracer = new DataFlowTracer(this.rootPath, this.symbolIndex, this.fileSystem);
        this.impactAnalyzer = new ImpactAnalyzer(this.dependencyGraph, this.callGraphBuilder, this.symbolIndex);
        this.hotSpotDetector = new HotSpotDetector(this.symbolIndex, this.dependencyGraph);
        this.referenceFinder = new ReferenceFinder(
            this.rootPath,
            this.dependencyGraph,
            this.symbolIndex,
            this.skeletonGenerator,
            this.moduleResolver
        );
        
        this.searchEngine = new SearchEngine(this.rootPath, this.fileSystem, [], {
            symbolIndex: this.symbolIndex,
            callGraphBuilder: this.callGraphBuilder,
            dependencyGraph: this.dependencyGraph
        });
        this.documentSearchEngine = new DocumentSearchEngine(
            this.searchEngine,
            this.documentIndexer,
            new DocumentChunkRepository(this.indexDatabase),
            this.embeddingRepository,
            this.embeddingProviderFactory
        );
        this.clusterSearchEngine = new ClusterSearchEngine({
            rootPath: this.rootPath,
            symbolIndex: this.symbolIndex,
            callGraphBuilder: this.callGraphBuilder,
            typeDependencyTracker: this.typeDependencyTracker,
            dependencyGraph: this.dependencyGraph,
            fileSystem: this.fileSystem
        });

        const historyEngine = new HistoryEngine(this.rootPath, this.fileSystem);
        this.historyEngine = historyEngine;
        const editorEngine = new EditorEngine(this.rootPath, this.fileSystem, new AstAwareDiff(this.skeletonGenerator));
        const transactionLog = new TransactionLog(this.indexDatabase.getHandle());

        this.editCoordinator = new EditCoordinator(editorEngine, historyEngine, {
            rootPath: this.rootPath,
            transactionLog,
            fileSystem: this.fileSystem,
            impactAnalyzer: this.impactAnalyzer
        });

        this.fileVersionManager = new FileVersionManager(this.fileSystem);
        this.applyIgnorePatterns(initialIgnorePatterns);
        this.configurationManager.on("ignoreChanged", (payload) => {
            this.applyIgnorePatterns(payload?.patterns ?? []);
        });
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
            this.internalRegistry,
            new CachingStrategy(this.rootPath)
        );
        this.legacyAdapter = new LegacyToolAdapter();

        this.registerInternalTools();
        this.setupHandlers();
        this.setupShutdownHooks();
        this.startHeartbeat();
    }

    private isTestEnv(): boolean {
        return process.env.NODE_ENV === "test" || process.env.JEST_WORKER_ID != null;
    }

    private registerInternalTools(): void {
        this.internalRegistry.register('read_code', (args) => this.readCodeRaw(args));
        this.internalRegistry.register('search_project', (args) => this.searchProjectRaw(args));
        this.internalRegistry.register('analyze_relationship', (args) => this.analyzeRelationshipRaw(args));
        this.internalRegistry.register('edit_code', (args) => this.editCodeRaw(args));
        this.internalRegistry.register('manage_project', (args) => this.manageProjectRaw(args));
        this.internalRegistry.register('file_profiler', (args) => this.readFileProfileRaw(args));
        this.internalRegistry.register('write_file', (args) => this.executeWriteFile(args));
        this.internalRegistry.register('impact_analyzer', (args) => this.executeImpactAnalyzer(args));
        this.internalRegistry.register('edit_coordinator', (args) => this.executeEditCoordinator(args));
        this.internalRegistry.register('hotspot_detector', () => this.hotSpotDetector.detectHotSpots());
        this.internalRegistry.register('reference_finder', (args) => this.findReferencesRaw(args));
        this.internalRegistry.register('project_stats', () => this.projectStatsRaw());
        this.internalRegistry.register('doc_toc', (args) => this.docTocRaw(args));
        this.internalRegistry.register('doc_skeleton', (args) => this.docSkeletonRaw(args));
        this.internalRegistry.register('doc_section', (args) => this.docSectionRaw(args));
        this.internalRegistry.register('doc_analyze', (args) => this.docAnalyzeRaw(args));
        this.internalRegistry.register('doc_search', (args) => this.docSearchRaw(args));
    }

    private setupHandlers(): void {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
            tools: this.listIntentTools(),
        }));

        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            return this.handleCallTool(request.params.name, request.params.arguments);
        });
    }

    private initFileLogger(): void {
        if (this.logStream) return;
        const enabled = process.env.SMART_CONTEXT_LOG_TO_FILE === "true" || !!process.env.SMART_CONTEXT_LOG_FILE;
        if (!enabled) return;
        const singleFilePath = process.env.SMART_CONTEXT_LOG_FILE;
        const logDir = process.env.SMART_CONTEXT_LOG_DIR
            || path.join(this.rootPath, ".smart-context", "logs");
        try {
            if (singleFilePath) {
                fs.mkdirSync(path.dirname(singleFilePath), { recursive: true });
                this.logStream = fs.createWriteStream(singleFilePath, { flags: "a" });
            } else {
                fs.mkdirSync(logDir, { recursive: true });
                this.logStreams = {
                    console: fs.createWriteStream(path.join(logDir, "console.log"), { flags: "a" }),
                    warn: fs.createWriteStream(path.join(logDir, "console.warn.log"), { flags: "a" }),
                    error: fs.createWriteStream(path.join(logDir, "console.error.log"), { flags: "a" }),
                    stdout: fs.createWriteStream(path.join(logDir, "stdout.log"), { flags: "a" }),
                    stderr: fs.createWriteStream(path.join(logDir, "stderr.log"), { flags: "a" })
                };
            }
        } catch (error) {
            console.warn("[SmartContextServer] Failed to initialize file logger:", error);
            return;
        }

        const writeLine = (level: string, args: unknown[], stream?: fs.WriteStream) => {
            const target = stream ?? this.logStream;
            if (!target) return;
            const timestamp = new Date().toISOString();
            const message = util.format(...args);
            target.write(`[${timestamp}] [${level}] ${message}\n`);
        };

        const wrap = (level: string, original: (...args: unknown[]) => void, stream?: fs.WriteStream) => {
            return (...args: unknown[]) => {
                original(...args);
                writeLine(level, args, stream);
            };
        };

        console.log = wrap("log", console.log.bind(console), this.logStreams?.console);
        console.info = wrap("info", console.info.bind(console), this.logStreams?.console);
        console.debug = wrap("debug", console.debug.bind(console), this.logStreams?.console);
        console.warn = wrap("warn", console.warn.bind(console), this.logStreams?.warn);
        console.error = wrap("error", console.error.bind(console), this.logStreams?.error);

        const stdoutWrite = process.stdout.write.bind(process.stdout);
        const stderrWrite = process.stderr.write.bind(process.stderr);
        const teeStream = (level: string, original: typeof stdoutWrite, stream?: fs.WriteStream) => {
            return (chunk: any, encoding?: any, cb?: any) => {
                try {
                    const target = stream ?? this.logStream;
                    if (target) {
                        const timestamp = new Date().toISOString();
                        const text = typeof chunk === "string" ? chunk : chunk?.toString?.(encoding) ?? "";
                        if (text.length > 0) {
                            const lines = text.replace(/\r?\n$/, "").split(/\r?\n/);
                            for (const line of lines) {
                                if (line.length === 0) continue;
                                target.write(`[${timestamp}] [${level}] ${line}\n`);
                            }
                        }
                    }
                } catch {
                    // ignore
                }
                return original(chunk, encoding as any, cb as any);
            };
        };

        process.stdout.write = teeStream("stdout", stdoutWrite, this.logStreams?.stdout) as typeof process.stdout.write;
        process.stderr.write = teeStream("stderr", stderrWrite, this.logStreams?.stderr) as typeof process.stderr.write;

        process.on("exit", () => {
            try {
                this.logStream?.end();
                if (this.logStreams) {
                    this.logStreams.console.end();
                    this.logStreams.warn.end();
                    this.logStreams.error.end();
                    this.logStreams.stdout.end();
                    this.logStreams.stderr.end();
                }
            } catch {
                // ignore
            }
        });
    }

    private initProcessDiagnostics(): void {
        if (this.diagnosticsInitialized) return;
        this.diagnosticsInitialized = true;

        const logMemory = (label: string) => {
            try {
                const mem = process.memoryUsage();
                const mb = (value: number) => Math.round((value / (1024 * 1024)) * 100) / 100;
                console.warn(`[Process] ${label} rss=${mb(mem.rss)}MB heapUsed=${mb(mem.heapUsed)}MB heapTotal=${mb(mem.heapTotal)}MB ext=${mb(mem.external)}MB`);
            } catch {
                // ignore
            }
        };

        process.on("uncaughtException", (err) => {
            console.error("[Process] uncaughtException", err);
            logMemory("uncaughtException");
        });
        process.on("unhandledRejection", (reason) => {
            console.error("[Process] unhandledRejection", reason);
            logMemory("unhandledRejection");
        });
        process.on("warning", (warning) => {
            console.warn("[Process] warning", warning);
        });
        process.on("exit", (code) => {
            console.warn(`[Process] exit code=${code}`);
            logMemory("exit");
        });
        process.on("SIGTERM", () => {
            console.warn("[Process] SIGTERM received");
            logMemory("SIGTERM");
        });
        process.on("SIGINT", () => {
            console.warn("[Process] SIGINT received");
            logMemory("SIGINT");
        });
        process.on("SIGHUP", () => {
            console.warn("[Process] SIGHUP received");
            logMemory("SIGHUP");
        });
    }

    private startHeartbeat(): void {
        if (this.heartbeatTimer) return;
        const enabled = process.env.SMART_CONTEXT_HEARTBEAT !== "false" && !this.isTestEnv();
        if (!enabled) return;
        this.heartbeatTimer = setInterval(() => {
            try {
                console.warn("[Heartbeat] alive");
            } catch {
                // ignore
            }
        }, 5000);
    }

    private stopHeartbeat(): void {
        if (!this.heartbeatTimer) return;
        clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = undefined;
    }

    private setupShutdownHooks(): void {
        if (this.isTestEnv()) return;
        const handle = (reason: string, error?: unknown) => {
            if (this.shutdownRequested) return;
            this.shutdownRequested = true;
            const timeoutMs = Number(process.env.SMART_CONTEXT_SHUTDOWN_TIMEOUT_MS ?? 5000);
            if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
                this.shutdownTimer = setTimeout(() => {
                    console.warn(`[Process] shutdown timeout exceeded (${timeoutMs}ms); forcing exit`);
                    process.exit(1);
                }, timeoutMs);
                this.shutdownTimer.unref?.();
            }
            if (error) {
                console.warn(`[Process] shutdown requested (${reason})`, error);
            } else {
                console.warn(`[Process] shutdown requested (${reason})`);
            }
            void this.shutdown().finally(() => {
                if (this.shutdownTimer) {
                    clearTimeout(this.shutdownTimer);
                    this.shutdownTimer = undefined;
                }
                if (!this.isTestEnv()) {
                    process.exit(0);
                }
            });
        };

        process.on("SIGTERM", () => handle("SIGTERM"));
        process.on("SIGINT", () => handle("SIGINT"));
        process.on("SIGHUP", () => handle("SIGHUP"));

        process.stdin.on("end", () => handle("stdin_end"));
        process.stdin.on("close", () => handle("stdin_close"));
        process.stdin.on("error", (err) => handle("stdin_error", err));
        process.stdin.resume();
    }

    private createIgnoreFilter(patterns: string[]): any {
        const ig = (ignore as unknown as () => any)();
        if (Array.isArray(patterns) && patterns.length > 0) {
            ig.add(patterns);
        }
        return ig;
    }

    private applyIgnorePatterns(patterns: string[]): void {
        const normalized = Array.isArray(patterns) ? patterns : [];
        this.symbolIndex.updateIgnorePatterns(normalized);
        this.contextEngine.updateIgnoreFilter(this.createIgnoreFilter(normalized));
        void this.searchEngine.updateExcludeGlobs(normalized);
        this.documentIndexer?.updateIgnorePatterns(normalized);
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
                name: 'doc_search',
                description: 'Search markdown/MDX sections with hybrid ranking (BM25 + vector).',
                inputSchema: {
                    type: 'object',
                    properties: {
                        query: { type: 'string' },
                        maxResults: { type: 'number' },
                        maxCandidates: { type: 'number' },
                        maxChunkCandidates: { type: 'number' },
                        maxVectorCandidates: { type: 'number' },
                        maxEvidenceSections: { type: 'number' },
                        maxEvidenceChars: { type: 'number' },
                        includeEvidence: { type: 'boolean' },
                        snippetLength: { type: 'number' },
                        rrfK: { type: 'number' },
                        rrfDepth: { type: 'number' },
                        useMmr: { type: 'boolean' },
                        mmrLambda: { type: 'number' },
                        maxChunksEmbeddedPerRequest: { type: 'number' },
                        maxEmbeddingTimeMs: { type: 'number' },
                        embedding: {
                            type: 'object',
                            properties: {
                                provider: { type: 'string', enum: ['auto', 'openai', 'local', 'disabled'] },
                                normalize: { type: 'boolean' },
                                batchSize: { type: 'number' },
                                openai: {
                                    type: 'object',
                                    properties: {
                                        apiKeyEnv: { type: 'string' },
                                        model: { type: 'string' }
                                    }
                                },
                                local: {
                                    type: 'object',
                                    properties: {
                                        model: { type: 'string' },
                                        dims: { type: 'number' }
                                    }
                                }
                            }
                        }
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
                        edits: { type: 'array', items: { type: 'object' } },
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
                    properties: { filePaths: { type: 'array', items: { type: 'string' } }, pattern: { type: 'string' } },
                    required: ['filePaths']
                }
            },
            {
                name: 'manage_project',
                description: 'Manage project state (status, undo, redo, reindex).',
                inputSchema: {
                    type: 'object',
                    properties: {
                        command: { type: 'string', enum: ['status', 'undo', 'redo', 'reindex', 'history', 'test'] },
                        target: { type: 'string' }
                    },
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
                        depth: { type: 'string', enum: ['shallow', 'standard', 'deep'] },
                        scope: { type: 'string', enum: ['symbol', 'file', 'module', 'project'] },
                        include: {
                            type: 'object',
                            properties: {
                                callGraph: { type: 'boolean' },
                                hotSpots: { type: 'boolean' },
                                pageRank: { type: 'boolean' },
                                dependencies: { type: 'boolean' }
                            }
                        }
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
                        targetFiles: { type: 'array', items: { type: 'string' } },
                        edits: { type: 'array', items: { type: 'object' } },
                        options: {
                            type: 'object',
                            properties: {
                                dryRun: { type: 'boolean' },
                                includeImpact: { type: 'boolean' },
                                autoRollback: { type: 'boolean' },
                                batchMode: { type: 'boolean' }
                            }
                        }
                    },
                    required: ['intent']
                }
            },
            {
                name: 'navigate',
                description: 'Locates symbols and files across the project.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        target: { type: 'string' },
                        context: { type: 'string', enum: ['definitions', 'usages', 'tests', 'docs', 'all'] },
                        limit: { type: 'number' },
                        include: {
                            type: 'object',
                            properties: {
                                hotSpots: { type: 'boolean' },
                                pageRank: { type: 'boolean' },
                                relatedSymbols: { type: 'boolean' }
                            }
                        }
                    },
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
                        lineRange: {
                            oneOf: [
                                { type: 'string' },
                                {
                                    type: 'array',
                                    items: { type: 'number' },
                                    minItems: 2,
                                    maxItems: 2
                                }
                            ]
                        },
                        sectionId: { type: 'string' },
                        headingPath: { type: 'array', items: { type: 'string' } },
                        includeSubsections: { type: 'boolean' },
                        outlineOptions: { type: 'object' },
                        includeProfile: { type: 'boolean' },
                        includeHash: { type: 'boolean' }
                    },
                    required: ['target']
                }
            },
            {
                name: 'write',
                description: 'Creates new files or scaffolds content.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        intent: { type: 'string' },
                        targetPath: { type: 'string' },
                        template: { type: 'string' },
                        content: { type: 'string' }
                    },
                    required: ['intent']
                }
            },
            {
                name: 'manage',
                description: 'Manages project state and transactions.',
                inputSchema: {
                    type: 'object',
                    properties: {
                        command: {
                            type: 'string',
                            enum: ['status', 'undo', 'redo', 'reindex', 'rebuild', 'history', 'test']
                        },
                        scope: { type: 'string', enum: ['file', 'transaction', 'project'] },
                        target: { type: 'string' }
                    },
                    required: ['command']
                }
            }
        ];

        const compatTools: any[] = [];
        const exposeLegacyTools = process.env.SMART_CONTEXT_EXPOSE_LEGACY_TOOLS === "true";
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

        return [
            ...(exposeLegacyTools ? legacyTools : []),
            ...pillarTools,
            ...compatTools
        ];
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
        return { content: [{ type: 'text', text: JSON.stringify(payload, this.jsonReplacer, 2) }] };
    }

    private jsonReplacer(_key: string, value: any): any {
        if (value instanceof Map) {
            return { __type: "Map", entries: Array.from(value.entries()) };
        }
        if (value instanceof Set) {
            return { __type: "Set", values: Array.from(value.values()) };
        }
        return value;
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

    private normalizeSuggestedTestPath(testPath: string): string {
        if (!testPath) return testPath;
        const normalized = path.normalize(testPath);
        if (path.isAbsolute(normalized)) {
            if (normalized.startsWith(this.rootPath)) {
                const relative = path.relative(this.rootPath, normalized);
                return this.resolveRelativePath(relative);
            }
            return normalized;
        }
        return this.resolveRelativePath(normalized);
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
        try {
            return await this.skeletonCache.getSkeleton(
                absPath,
                skeletonOptions,
                async (targetPath, options) => {
                    const content = await this.fileSystem.readFile(filePath);
                    return this.skeletonGenerator.generateSkeleton(targetPath, content, options);
                }
            );
        } catch (error: any) {
            const content = await this.fileSystem.readFile(filePath);
            return this.buildSkeletonFallback(content, error?.message);
        }
    }

    private async docTocRaw(args: any) {
        const filePath = this.resolveRelativePath(args.filePath);
        const content = await this.fileSystem.readFile(filePath);
        const profile = this.documentProfiler.profile({
            filePath,
            content,
            kind: this.inferDocumentKind(filePath),
            options: args?.options
        });
        const degradation = buildDegradation(profile.parser?.reason ? [profile.parser.reason] : []);
        return {
            filePath,
            kind: profile.kind,
            outline: profile.outline,
            ...degradation
        };
    }

    private async docSkeletonRaw(args: any) {
        const filePath = this.resolveRelativePath(args.filePath);
        const content = await this.fileSystem.readFile(filePath);
        const profile = this.documentProfiler.profile({
            filePath,
            content,
            kind: this.inferDocumentKind(filePath),
            options: args?.options
        });
        const degradation = buildDegradation(profile.parser?.reason ? [profile.parser.reason] : []);
        return {
            filePath,
            kind: profile.kind,
            skeleton: this.documentProfiler.buildSkeleton(profile),
            outline: profile.outline,
            ...degradation
        };
    }

    private async docAnalyzeRaw(args: any) {
        const filePath = this.resolveRelativePath(args.filePath);
        const content = await this.fileSystem.readFile(filePath);
        const profile = this.documentProfiler.profile({
            filePath,
            content,
            kind: this.inferDocumentKind(filePath),
            options: args?.options
        });
        const degradation = buildDegradation(profile.parser?.reason ? [profile.parser.reason] : []);
        return {
            filePath,
            profile,
            skeleton: this.documentProfiler.buildSkeleton(profile),
            ...degradation
        };
    }

    private async docSectionRaw(args: any) {
        const filePath = this.resolveRelativePath(args.filePath);
        const content = await this.fileSystem.readFile(filePath);
        const profile = this.documentProfiler.profile({
            filePath,
            content,
            kind: this.inferDocumentKind(filePath),
            options: args?.options
        });
        const outline = profile.outline;
        const sectionId = args?.sectionId as string | undefined;
        const headingPath = normalizeHeadingPath(args?.headingPath);
        const includeSubsections = args?.includeSubsections === true;
        const reasons: string[] = [];
        if (profile.parser?.reason) {
            reasons.push(profile.parser.reason);
        }

        let sectionIndex = -1;
        if (sectionId) {
            sectionIndex = outline.findIndex(section => section.id === sectionId);
        } else if (headingPath && headingPath.length > 0) {
            sectionIndex = outline.findIndex(section =>
                matchesHeadingPath(section.path, headingPath)
            );
        }

        if (sectionIndex === -1) {
            let suggestions = outline.slice(0, 5).map(section => section.path);
            if (headingPath && headingPath.length > 0) {
                const ranked = rankSectionsByHeadingPath(outline, headingPath, 5);
                suggestions = ranked.map(entry => outline[entry.index].path);
                const best = ranked[0];
                if (best && best.score >= 2) {
                    sectionIndex = best.index;
                    reasons.push("closest_match");
                } else {
                    return {
                        success: false,
                        status: 'no_results',
                        message: 'Section not found.',
                        suggestions,
                        ...buildDegradation(reasons)
                    };
                }
            } else {
                return {
                    success: false,
                    status: 'no_results',
                    message: 'Section not found.',
                    suggestions,
                    ...buildDegradation(reasons)
                };
            }
        }

        const section = outline[sectionIndex];
        const range = computeSectionRange(outline, sectionIndex, includeSubsections);
        const lines = content.split(/\r?\n/);
        const sectionContent = lines.slice(range.startLine - 1, range.endLine).join("\n");
        const status = reasons.includes("closest_match") ? "closest_match" : "success";

        return {
            success: true,
            status,
            filePath,
            kind: profile.kind,
            section: {
                ...section,
                range: { ...section.range, startLine: range.startLine, endLine: range.endLine }
            },
            content: sectionContent,
            resolvedHeadingPath: section.path,
            requestedHeadingPath: headingPath ?? undefined,
            ...buildDegradation(reasons)
        };
    }

    private async docSearchRaw(args: any) {
        const query = args?.query ?? args?.text ?? args?.keywords?.join?.(" ") ?? "";
        if (!query || !String(query).trim()) {
            return {
                query: String(query ?? ""),
                results: [],
                evidence: [],
                degraded: false,
                provider: null,
                stats: {
                    candidateFiles: 0,
                    candidateChunks: 0,
                    vectorEnabled: false,
                    mmrApplied: false
                }
            };
        }

        return this.documentSearchEngine.search(String(query), {
            maxResults: args?.maxResults ?? args?.limit,
            maxCandidates: args?.maxCandidates,
            maxChunkCandidates: args?.maxChunkCandidates,
            maxVectorCandidates: args?.maxVectorCandidates,
            maxEvidenceSections: args?.maxEvidenceSections,
            maxEvidenceChars: args?.maxEvidenceChars,
            includeEvidence: args?.includeEvidence,
            snippetLength: args?.snippetLength,
            rrfK: args?.rrfK,
            rrfDepth: args?.rrfDepth,
            useMmr: args?.useMmr,
            mmrLambda: args?.mmrLambda,
            maxChunksEmbeddedPerRequest: args?.maxChunksEmbeddedPerRequest,
            maxEmbeddingTimeMs: args?.maxEmbeddingTimeMs,
            embedding: args?.embedding
        });
    }

    private inferDocumentKind(filePath: string): "markdown" | "mdx" | "text" | "unknown" {
        const ext = path.extname(filePath).toLowerCase();
        if (ext === ".mdx") return "mdx";
        if (ext === ".md") return "markdown";
        return "unknown";
    }

    private async searchProjectRaw(args: any) {
        const query = args?.query ?? args?.keywords?.join?.(' ') ?? args?.patterns?.join?.(' ');
        if (!query) {
            throw new Error("Missing required parameter: query");
        }
        const budget = args?.budget;
        const usage = budget ? ({ filesRead: 0, bytesRead: 0, parseTimeMs: 0 } as ResourceUsage) : undefined;
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
                context: `${match.symbol.type} ${match.symbol.name}`,
                line: typeof match.symbol?.range?.startLine === 'number' ? match.symbol.range.startLine : undefined,
                symbol: match.symbol
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
                maxResults,
                budget,
                usage
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

            if (usage?.degraded) {
                const fallbackResults: any[] = [];
                try {
                    const filenameResults = await this.searchEngine.searchFilenames(query, { maxResults });
                    fallbackResults.push(...filenameResults);
                } catch {}
                if (fallbackResults.length < maxResults) {
                    try {
                        const symbolMatches = await this.symbolIndex.search(query);
                        fallbackResults.push(...symbolMatches.slice(0, maxResults - fallbackResults.length).map(match => ({
                            type: 'symbol',
                            path: match.filePath,
                            score: 1,
                            context: `${match.symbol.type} ${match.symbol.name}`,
                            line: typeof match.symbol?.range?.startLine === 'number' ? match.symbol.range.startLine : undefined,
                            symbol: match.symbol
                        })));
                    } catch {}
                }
                if (fallbackResults.length > 0) {
                    results = fallbackResults.slice(0, maxResults);
                }
            }
        }

        if (results.length === 0) {
            const enhanced = ErrorEnhancer.enhanceSearchNotFound(query);
            return {
                results: [],
                inferredType,
                message: `No results found for "${query}".`,
                suggestions: enhanced.toolSuggestions,
                nextActionHint: enhanced.nextActionHint,
                degraded: usage?.degraded ?? false,
                budget: budget ? { ...budget, used: usage } : undefined
            };
        }

        return {
            results,
            inferredType,
            degraded: usage?.degraded ?? false,
            budget: budget ? { ...budget, used: usage } : undefined
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

    private async projectStatsRaw() {
        const files = this.indexDatabase.listFiles();
        return {
            fileCount: files.length
        };
    }

    private async executeEditCoordinator(args: any) {
        const filePath = args?.filePath ? this.resolveRelativePath(args.filePath) : undefined;
        const edits = Array.isArray(args?.edits) ? args.edits : [];
        const dryRun = Boolean(args?.dryRun);
        const options = args?.options ?? {};
        if (!filePath) {
            return { success: false, message: 'Missing filePath for edit_coordinator.' };
        }
        if (edits.length === 0) {
            return { success: false, message: 'No edits provided for edit_coordinator.' };
        }
        return this.editCoordinator.applyEdits(this.resolveAbsolutePath(filePath), edits, dryRun, options);
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
        const scope = args?.scope;
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
                {
                    const suppressLogs = Boolean(args?.suppressLogs ?? args?.quiet);
                    if (suppressLogs) {
                        this.dependencyGraph.setLoggingEnabled(false);
                    }
                    try {
                        await this.dependencyGraph.ensureBuilt();
                        const status = await this.dependencyGraph.getIndexStatus();
                        const detail = args?.detail ?? args?.verbosity ?? 'summary';
                        const includePerFile = detail === 'full' || detail === 'verbose' || args?.includePerFile === true;
                        if (includePerFile) {
                            return { success: true, output: "Index status", status };
                        }
                        const limit = typeof args?.limit === 'number' ? args.limit : 20;
                        const unresolvedSample = Object.entries(status.perFile ?? {})
                            .filter(([, value]) => !(value as any)?.resolved)
                            .slice(0, limit)
                            .map(([filePath, value]) => ({
                                filePath,
                                unresolvedImports: (value as any)?.unresolvedImports ?? []
                            }));
                        return {
                            success: true,
                            output: "Index status",
                            status: {
                                global: status.global,
                                unresolvedSample
                            },
                            activity: {
                                reindexInProgress: this.reindexInProgress,
                                lastReindex: this.reindexLastResult
                            }
                        };
                    } finally {
                        if (suppressLogs && !this.reindexInProgress) {
                            this.dependencyGraph.setLoggingEnabled(true);
                        }
                    }
                }
            case 'reindex':
                {
                    const suppressLogs = Boolean(args?.suppressLogs ?? args?.quiet);
                    if (suppressLogs) {
                        this.dependencyGraph.setLoggingEnabled(false);
                    }
                    try {
                        if (this.reindexInProgress) {
                            return { success: false, output: "Reindex already in progress." };
                        }
                        const startedAt = new Date();
                        this.reindexInProgress = true;
                        this.reindexLastResult = {
                            success: false,
                            output: "Reindex in progress.",
                            startedAt: startedAt.toISOString()
                        };

                        // Always clear skeleton caches before returning so callers can rely on immediate cache reset.
                        await this.skeletonCache.clearAll();

                        // In tests we skip the heavy rebuild to avoid long-running background work and open handles.
                        if (this.isTestEnv()) {
                            const finishedAt = new Date();
                            this.reindexLastResult = {
                                success: true,
                                output: "Reindex completed (test mode: caches cleared only).",
                                startedAt: startedAt.toISOString(),
                                finishedAt: finishedAt.toISOString()
                            };
                            this.reindexInProgress = false;
                            return { success: true, output: "Reindex completed (test mode).", activity: { reindexInProgress: false } };
                        }

                        if (!suppressLogs) {
                            console.info(`[SmartContextServer] CWD: ${process.cwd()}`);
                            console.info('[SmartContextServer] Reindex started.');
                            const excludes = this.searchEngine.getExcludeGlobs();
                            console.info(`[SmartContextServer] Excluding ${excludes.length} patterns.`);
                            for (const pattern of excludes) {
                                console.info(`[SmartContextServer] exclude: ${pattern}`);
                            }
                        }
                        void (async () => {
                            try {
                                const progressLogger = suppressLogs ? undefined : (message: string) => console.info(message);
                                await this.searchEngine.rebuild({ logEvery: 500, logger: progressLogger, logTotals: true });
                                await this.dependencyGraph.build({ logEvery: 200 });
                                if (this.documentIndexer) {
                                    await this.documentIndexer.rebuildAll();
                                }
                                const finishedAt = new Date();
                                this.reindexLastResult = {
                                    success: true,
                                    output: "Reindex completed.",
                                    startedAt: startedAt.toISOString(),
                                    finishedAt: finishedAt.toISOString()
                                };
                                if (!suppressLogs) {
                                    const elapsedMs = finishedAt.getTime() - startedAt.getTime();
                                    console.info(`[SmartContextServer] Reindex completed in ${elapsedMs}ms.`);
                                }
                            } catch (error: any) {
                                const finishedAt = new Date();
                                this.reindexLastResult = {
                                    success: false,
                                    output: error?.message ?? "Reindex failed.",
                                    startedAt: startedAt.toISOString(),
                                    finishedAt: finishedAt.toISOString()
                                };
                                console.error("[SmartContextServer] Reindex failed.", error);
                            } finally {
                                this.reindexInProgress = false;
                                if (suppressLogs) {
                                    this.dependencyGraph.setLoggingEnabled(true);
                                }
                            }
                        })();
                        return { success: true, output: "Reindex started.", activity: { reindexInProgress: true } };
                    } finally {
                        if (suppressLogs) {
                            this.dependencyGraph.setLoggingEnabled(true);
                        }
                    }
                }
            case 'history':
                {
                    const history = await this.historyEngine.getHistory();
                    const log = this.editCoordinator.getTransactionLog();
                    const pending = log ? log.getPendingTransactions() : [];
                    return {
                        success: true,
                        output: "History retrieved.",
                        history: {
                            undo: history.undoStack,
                            redo: history.redoStack,
                            pendingTransactions: pending
                        }
                    };
                }
            case 'test':
                {
                    const target = args?.target;
                    if (!target && scope !== 'project') {
                        return { success: false, output: "Missing target for test command." };
                    }
                    if (!target && scope === 'project') {
                        return {
                            success: true,
                            output: "Suggested tests generated.",
                            suggestedTests: []
                        };
                    }
                    const absPath = this.resolveAbsolutePath(target);
                    const report = await this.impactAnalyzer.analyzeImpact(absPath, []);
                    const suggestedTests = Array.isArray(report?.suggestedTests)
                        ? report.suggestedTests.map(testPath => this.normalizeSuggestedTestPath(testPath))
                        : [];
                    return {
                        success: true,
                        output: "Suggested tests generated.",
                        suggestedTests
                    };
                }
            default:
                return { success: false, output: `Unknown manage_project command: ${command}` };
        }
    }

    private async findReferencesRaw(args: any) {
        const symbolName = args?.symbolName ?? args?.symbol ?? args?.target;
        if (!symbolName) {
            return { success: false, message: "symbolName is required." };
        }

        const definitionPath = args?.definitionPath ?? args?.filePath ?? args?.contextPath;
        let resolvedDefinition: string | undefined;
        if (definitionPath) {
            resolvedDefinition = this.resolveAbsolutePath(definitionPath);
        } else {
            const matches = await this.symbolIndex.search(symbolName);
            if (matches.length > 0) {
                resolvedDefinition = path.isAbsolute(matches[0].filePath)
                    ? matches[0].filePath
                    : this.resolveAbsolutePath(matches[0].filePath);
            }
        }

        if (!resolvedDefinition) {
            return { success: false, message: `Symbol '${symbolName}' not found.` };
        }

        await this.dependencyGraph.ensureBuilt();
        const references = await this.referenceFinder.findReferences(symbolName, resolvedDefinition);
        return {
            success: true,
            symbolName,
            definitionFile: this.resolveRelativePath(resolvedDefinition),
            references
        };
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
        const docKind = this.inferDocumentKind(filePath);
        const isDocument = docKind !== "unknown";
        let outgoing: any[] = [];
        let incoming: any[] = [];
        let skeleton = '';
        let symbols: any[] = [];
        let document: any = undefined;

        if (isDocument) {
            try {
                const profile = this.documentProfiler.profile({
                    filePath,
                    content,
                    kind: docKind,
                    options: args?.outlineOptions
                });
                skeleton = this.documentProfiler.buildSkeleton(profile);
                document = profile;
            } catch (error: any) {
                skeleton = this.buildSkeletonFallback(content, error?.message);
                document = undefined;
            }
        } else {
            await this.dependencyGraph.ensureBuilt();
            outgoing = await this.dependencyGraph.getDependencies(filePath, 'downstream');
            incoming = await this.dependencyGraph.getDependencies(filePath, 'upstream');
            try {
                skeleton = await this.skeletonGenerator.generateSkeleton(absPath, content);
                symbols = await this.symbolIndex.getSymbolsForFile(absPath);
            } catch (error: any) {
                const fallback = this.buildSkeletonFallback(content, error?.message);
                skeleton = fallback;
                symbols = [];
            }
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
                symbols,
                document: document ? {
                    kind: document.kind,
                    title: document.title,
                    outline: document.outline,
                    links: document.links
                } : undefined
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
        this.stopHeartbeat();
        await this.server.close();
        this.clusterSearchEngine.stopBackgroundTasks();
        if (this.incrementalIndexer) {
            await this.incrementalIndexer.stop();
        }
        await this.searchEngine.dispose();
        await this.symbolIndex.dispose();
        await this.skeletonCache.close();
        await this.astManager.dispose();
        await this.configurationManager.dispose();
        this.indexDatabase.close();
    }

    public async waitForInitialScan() {
        // Simple delay or bridge to incremental indexer
        return new Promise(resolve => setTimeout(resolve, 100));
    }

    public async run() {

        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.error(`Smart Context MCP Server running on stdio (cwd=${process.cwd()})`);
    }
}

function normalizeHeadingPath(raw: any): string[] | null {
    if (!raw) return null;
    if (Array.isArray(raw)) {
        return raw.map(value => String(value));
    }
    if (typeof raw === "string") {
        return raw.split(">").map(part => part.trim()).filter(Boolean);
    }
    return null;
}

function buildDegradation(reasons: string[]): { degraded: boolean; reason?: string; reasons?: string[] } {
    const filtered = Array.from(new Set(reasons.filter(Boolean)));
    if (filtered.length === 0) {
        return { degraded: false };
    }
    return {
        degraded: true,
        reason: filtered[0],
        reasons: filtered.length > 1 ? filtered : undefined
    };
}

function matchesHeadingPath(candidate: string[], target: string[]): boolean {
    if (candidate.length !== target.length) return false;
    return candidate.every((value, idx) => normalizeHeading(value) === normalizeHeading(target[idx]));
}

function normalizeHeading(value: string): string {
    return value
        .toLowerCase()
        .replace(/\s+/g, " ")
        .replace(/[#:*_`~]+/g, "")
        .trim();
}

function rankSectionsByHeadingPath(
    outline: Array<{ path: string[] }>,
    target: string[],
    limit = 5
): Array<{ index: number; score: number }> {
    const scored = outline.map((section, index) => ({
        index,
        score: scoreHeadingPath(section.path, target)
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.max(1, limit));
}

function scoreHeadingPath(candidate: string[], target: string[]): number {
    const normalizedCandidate = candidate.map(normalizeHeading).filter(Boolean);
    const normalizedTarget = target.map(normalizeHeading).filter(Boolean);
    if (normalizedCandidate.length === 0 || normalizedTarget.length === 0) return 0;

    const minLen = Math.min(normalizedCandidate.length, normalizedTarget.length);
    const maxLen = Math.max(normalizedCandidate.length, normalizedTarget.length);
    let prefixMatches = 0;
    let exactMatches = 0;
    for (let idx = 0; idx < minLen; idx += 1) {
        if (normalizedCandidate[idx] === normalizedTarget[idx]) {
            prefixMatches += 1;
            exactMatches += 1;
        } else {
            break;
        }
    }
    for (let idx = prefixMatches; idx < minLen; idx += 1) {
        if (normalizedCandidate[idx] === normalizedTarget[idx]) {
            exactMatches += 1;
        }
    }

    const candidateSet = new Set(normalizedCandidate);
    const targetSet = new Set(normalizedTarget);
    let intersection = 0;
    for (const value of targetSet) {
        if (candidateSet.has(value)) intersection += 1;
    }
    const union = candidateSet.size + targetSet.size - intersection;
    const jaccard = union > 0 ? intersection / union : 0;

    const prefixScore = (prefixMatches / maxLen) * 4;
    const exactScore = exactMatches * 1.5;
    const overlapScore = jaccard * 3;
    const tailScore = normalizedCandidate[normalizedCandidate.length - 1] === normalizedTarget[normalizedTarget.length - 1] ? 2 : 0;
    const lengthPenalty = Math.abs(normalizedCandidate.length - normalizedTarget.length) * 0.5;

    return Math.max(0, prefixScore + exactScore + overlapScore + tailScore - lengthPenalty);
}

function computeSectionRange(
    outline: Array<{ level: number; range: { startLine: number; endLine: number } }>,
    index: number,
    includeSubsections: boolean
): { startLine: number; endLine: number } {
    const startLine = outline[index].range.startLine;
    if (!includeSubsections) {
        return outline[index].range;
    }
    const level = outline[index].level;
    let endLine = outline[index].range.endLine;
    for (let idx = index + 1; idx < outline.length; idx += 1) {
        if (outline[idx].level <= level) {
            endLine = outline[idx].range.startLine - 1;
            break;
        }
        endLine = outline[idx].range.endLine;
    }
    return { startLine, endLine };
}

const isDirectRun = (() => {
    const entry = process.argv[1];
    if (!entry) {
        return false;
    }
    try {
        return import.meta.url === url.pathToFileURL(entry).href;
    } catch {
        return false;
    }
})();

if (isDirectRun) {
    const envRoot = process.env.SMART_CONTEXT_ROOT_PATH || process.env.SMART_CONTEXT_ROOT;
    const resolvedRoot = envRoot && envRoot.trim().length > 0 ? envRoot : process.cwd();
    const server = new SmartContextServer(resolvedRoot);
    server.run().catch(console.error);
}
