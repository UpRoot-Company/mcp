
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import * as fs from "fs";



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
import { FallbackResolver } from "./resolution/FallbackResolver.js";
import { ErrorEnhancer } from "./errors/ErrorEnhancer.js";
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
import { FileSearchResult, ReadFragmentResult, EditResult, Edit, EngineConfig, SmartFileProfile, SymbolInfo, ToolSuggestion, ImpactPreview, BatchEditGuidance, ReadCodeResult, ReadCodeArgs, SearchProjectResult, SearchProjectArgs, AnalyzeRelationshipResult, EditCodeArgs, EditCodeResult, EditCodeEdit, ManageProjectResult, ManageProjectArgs, AnalyzeRelationshipArgs, ReadCodeView, SearchProjectType, ResolvedRelationshipTarget, AnalyzeRelationshipDirection, AnalyzeRelationshipNode, AnalyzeRelationshipEdge, LineRange, DiffMode, SafetyLevel, RefactoringContext, NextActionHint, BatchOpportunity, SuggestedBatchEdit } from "./types.js";
import { FileStats, IFileSystem, NodeFileSystem } from "./platform/FileSystem.js";
import { AstAwareDiff } from "./engine/AstAwareDiff.js";
import { IndexDatabase } from "./indexing/IndexDatabase.js";
import { IncrementalIndexer } from "./indexing/IncrementalIndexer.js";
import { TransactionLog, TransactionLogEntry } from "./engine/TransactionLog.js";
import { metrics } from "./utils/MetricsCollector.js";
import { PathNormalizer } from "./utils/PathNormalizer.js";
import { ConfigurationManager } from "./config/ConfigurationManager.js";

export { ConfigurationManager } from "./config/ConfigurationManager.js";



const ENABLE_DEBUG_LOGS = process.env.SMART_CONTEXT_DEBUG === 'true';

export class SmartContextServer {
    private server: Server;
    private rootPath: string;
    private rootRealPath?: string;
    private fileSystem: IFileSystem;
    private ig: any;
    private ignoreGlobs: string[] = [];
    private searchEngine: SearchEngine;
    private contextEngine: ContextEngine;
    private editorEngine: EditorEngine;
    private historyEngine: HistoryEngine;
    private editCoordinator: EditCoordinator;
    private skeletonGenerator: SkeletonGenerator;
    private fallbackResolver: FallbackResolver;
    private astManager: AstManager;
    private symbolIndex: SymbolIndex;
    private moduleResolver: ModuleResolver;
    private dependencyGraph: DependencyGraph;
    private referenceFinder: ReferenceFinder;
    private callGraphBuilder: CallGraphBuilder;
    private typeDependencyTracker: TypeDependencyTracker;
    private dataFlowTracer: DataFlowTracer;
    private clusterSearchEngine: ClusterSearchEngine;
    private indexDatabase: IndexDatabase;
    private transactionLog: TransactionLog;
    private incrementalIndexer?: IncrementalIndexer;
    private configurationManager: ConfigurationManager;
    private sigintListener?: () => Promise<void>;
    private static hasSigintListener = false;
    private static readonly READ_CODE_MAX_BYTES = 1_000_000;
    private static readonly READ_FILE_DEFAULT_MAX_BYTES = 65_536;
    private static readonly DELETE_LARGE_FILE_BYTES = 10_000;
    private static readonly DELETE_LARGE_FILE_LINES = 100;
    private static readonly DELETE_PREVIEW_CHARS = 200;

    private exposeCompatTools: boolean;
    private readFileMaxBytes: number;
    private pathNormalizer: PathNormalizer;

    private static parsePositiveIntEnv(name: string, fallback: number): number {
        const raw = process.env[name];
        if (!raw) return fallback;
        const parsed = Number.parseInt(raw, 10);
        if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
        return parsed;
    }

    private ownsConfigurationManager: boolean;

    constructor(rootPath: string, fileSystem?: IFileSystem, configurationManager?: ConfigurationManager) {
        if (ENABLE_DEBUG_LOGS) {
            console.error("DEBUG: SmartContextServer constructor started");
        }
        this.server = new Server({
            name: "smart-context-mcp",
            version: "4.0.0",
        }, {
            capabilities: {
                tools: {},
            },
        });

        this.rootPath = path.resolve(rootPath);
        this.fileSystem = fileSystem ?? new NodeFileSystem(this.rootPath);
        if (this.fileSystem instanceof NodeFileSystem) {
            try {
                const real = (fs.realpathSync as any).native
                    ? (fs.realpathSync as any).native(this.rootPath)
                    : fs.realpathSync(this.rootPath);
                this.rootRealPath = real;
            } catch {
                this.rootRealPath = undefined;
            }
        }
        const isTestEnv = process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined;
        this.exposeCompatTools = process.env.SMART_CONTEXT_EXPOSE_COMPAT_TOOLS === 'true';
        this.readFileMaxBytes = SmartContextServer.parsePositiveIntEnv(
            'SMART_CONTEXT_READ_FILE_MAX_BYTES',
            SmartContextServer.READ_FILE_DEFAULT_MAX_BYTES
        );

        this.configurationManager = configurationManager ?? new ConfigurationManager(this.rootPath);
        this.ownsConfigurationManager = !configurationManager;
        this.ig = (ignore.default as any)();
        this.applyIgnorePatterns(this.configurationManager.getIgnoreGlobs(), { skipPropagation: true });

        // 경로 정규화 초기화 (절대경로 ↔ 상대경로 자동 변환)
        this.pathNormalizer = new PathNormalizer(this.rootPath);

        this.skeletonGenerator = new SkeletonGenerator();
        this.astManager = AstManager.getInstance();
        this.indexDatabase = new IndexDatabase(this.rootPath);
        this.transactionLog = new TransactionLog(this.indexDatabase.getHandle());
        this.symbolIndex = new SymbolIndex(this.rootPath, this.skeletonGenerator, this.ignoreGlobs, this.indexDatabase);
        this.fallbackResolver = new FallbackResolver(this.symbolIndex, this.skeletonGenerator);
        this.moduleResolver = new ModuleResolver(this.rootPath);
        this.dependencyGraph = new DependencyGraph(this.rootPath, this.symbolIndex, this.moduleResolver, this.indexDatabase);
        this.referenceFinder = new ReferenceFinder(this.rootPath, this.dependencyGraph, this.symbolIndex, this.skeletonGenerator, this.moduleResolver);
        this.callGraphBuilder = new CallGraphBuilder(this.rootPath, this.symbolIndex, this.moduleResolver);
        this.typeDependencyTracker = new TypeDependencyTracker(this.rootPath, this.symbolIndex);
        this.dataFlowTracer = new DataFlowTracer(this.rootPath, this.symbolIndex, this.fileSystem);
        const semanticDiffProvider = new AstAwareDiff(this.skeletonGenerator);
        this.contextEngine = new ContextEngine(this.ig, this.fileSystem);
        this.editorEngine = new EditorEngine(this.rootPath, this.fileSystem, semanticDiffProvider);
        this.historyEngine = new HistoryEngine(this.rootPath, this.fileSystem);
        this.editCoordinator = new EditCoordinator(this.editorEngine, this.historyEngine, {
            rootPath: this.rootPath,
            transactionLog: this.transactionLog,
            fileSystem: this.fileSystem
        });
        void this.recoverPendingTransactions();
        this.searchEngine = new SearchEngine(this.rootPath, this.fileSystem, this.ignoreGlobs, {
            symbolMetadataProvider: this.symbolIndex,
            callGraphBuilder: this.callGraphBuilder
        });
        const precomputeEnabled = process.env.SMART_CONTEXT_DISABLE_PRECOMPUTE === 'true' ? false : !isTestEnv;
        this.clusterSearchEngine = new ClusterSearchEngine({
            rootPath: this.rootPath,
            symbolIndex: this.symbolIndex,
            callGraphBuilder: this.callGraphBuilder,
            typeDependencyTracker: this.typeDependencyTracker,
            dependencyGraph: this.dependencyGraph,
            fileSystem: this.fileSystem
        }, {
            precomputation: { enabled: precomputeEnabled }
        });
        this.applyIgnorePatterns(this.ignoreGlobs);
        this.registerConfigurationListeners();
        const indexingEnabled = process.env.SMART_CONTEXT_DISABLE_STREAMING_INDEX === 'true' ? false : !isTestEnv;
        if (indexingEnabled) {
            this.incrementalIndexer = new IncrementalIndexer(
                this.rootPath,
                this.symbolIndex,
                this.dependencyGraph,
                this.indexDatabase,
                this.moduleResolver,
                this.configurationManager
            );
        }

        const requestedMode = process.env.SMART_CONTEXT_ENGINE_MODE as EngineConfig['mode'];
        const requestedBackend = process.env.SMART_CONTEXT_PARSER_BACKEND as EngineConfig['parserBackend'];
        const engineConfig: EngineConfig = {
            rootPath: this.rootPath,
            mode: requestedMode || (isTestEnv ? 'test' : 'prod'),
            parserBackend: requestedBackend || (isTestEnv ? 'js' : 'auto'),
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
                this.incrementalIndexer?.start();
                this.clusterSearchEngine.startBackgroundTasks();
            })
            .catch(error => {
                if (ENABLE_DEBUG_LOGS) {
                    console.error("AstManager initialization failed:", error);
                }
            });

        this.setupHandlers();
        this.server.onerror = (error) => console.error("[MCP Error]", error);

        if (!isTestEnv && !SmartContextServer.hasSigintListener) {
            this.sigintListener = async () => {
                this.clusterSearchEngine.stopBackgroundTasks();
                await this.incrementalIndexer?.stop();
                if (this.ownsConfigurationManager) {
                    await this.configurationManager.dispose();
                }
                await this.server.close();
                process.exit(0);
            };
            process.on("SIGINT", this.sigintListener);
            SmartContextServer.hasSigintListener = true;
        }

        if (ENABLE_DEBUG_LOGS) {
            console.error("DEBUG: SmartContextServer constructor finished");
        }
    }

    private applyIgnorePatterns(patterns: string[], options: { skipPropagation?: boolean } = {}): void {
        this.ignoreGlobs = patterns;
        const newIgnore = (ignore.default as any)();
        if (patterns.length > 0) {
            newIgnore.add(patterns);
        }
        this.ig = newIgnore;
        if (!options.skipPropagation) {
            this.contextEngine?.updateIgnoreFilter(this.ig);
            this.symbolIndex?.updateIgnorePatterns(patterns);
            if (this.searchEngine) {
                void this.searchEngine.updateExcludeGlobs(patterns).catch(error => {
                    console.warn('[SmartContextServer] Failed to update search ignore globs:', error);
                });
            }
        }
    }

    public getConfigurationManager(): ConfigurationManager {
        return this.configurationManager;
    }

    private registerConfigurationListeners(): void {
        this.configurationManager.on('ignoreChanged', ({ patterns }) => {
            console.info('[SmartContextServer] .gitignore or .mcpignore changed; refreshing ignore filters.');
            this.applyIgnorePatterns(patterns);
        });
    }

    private _getAbsPathAndVerify(filePath: string): string {
        const absPath = path.isAbsolute(filePath)
            ? path.normalize(filePath)
            : path.join(this.rootPath, filePath);

        if (!absPath.startsWith(this.rootPath + path.sep) && absPath !== this.rootPath) {
            throw new McpError(ErrorCode.InvalidParams,
                `SecurityViolation: File path is outside the allowed root directory.`);
        }

        // Harden against symlink escape (Node filesystem only).
        if (this.fileSystem instanceof NodeFileSystem && this.rootRealPath) {
            const rootReal = this.rootRealPath;
            const isInsideRoot = (candidate: string) => candidate === rootReal || candidate.startsWith(rootReal + path.sep);

            // If the path exists, resolve it directly.
            try {
                const realAbs = (fs.realpathSync as any).native
                    ? (fs.realpathSync as any).native(absPath)
                    : fs.realpathSync(absPath);
                if (!isInsideRoot(realAbs)) {
                    throw new McpError(ErrorCode.InvalidParams,
                        `SecurityViolation: File path resolves outside the allowed root directory.`);
                }
            } catch {
                // If it doesn't exist (create/write), validate against the nearest existing parent.
                let parent = path.dirname(absPath);
                while (parent !== this.rootPath && !fs.existsSync(parent)) {
                    const next = path.dirname(parent);
                    if (next === parent) {
                        break;
                    }
                    parent = next;
                }
                try {
                    const realParent = (fs.realpathSync as any).native
                        ? (fs.realpathSync as any).native(parent)
                        : fs.realpathSync(parent);
                    if (!isInsideRoot(realParent)) {
                        throw new McpError(ErrorCode.InvalidParams,
                            `SecurityViolation: Parent directory resolves outside the allowed root directory.`);
                    }
                } catch {
                    // If we can't realpath the parent, fall back to the prefix check above.
                }
            }
        }

        return absPath;
    }

    private async recoverPendingTransactions(): Promise<void> {
        const pending: TransactionLogEntry[] = this.transactionLog.getPendingTransactions();
        if (pending.length === 0) {
            return;
        }

        for (const tx of pending) {
            console.warn(`[Recovery] Rolling back incomplete transaction ${tx.id}`);
            for (const snapshot of tx.snapshots) {
                try {
                    await this.fileSystem.writeFile(snapshot.filePath, snapshot.originalContent);
                } catch (error) {
                    console.error(`[Recovery] Failed to restore ${snapshot.filePath}:`, error);
                }
            }
            this.transactionLog.rollback(tx.id);
            try {
                await this.historyEngine.removeOperation(tx.id);
            } catch (error) {
                console.error(`[Recovery] Failed to remove history placeholder for ${tx.id}:`, error);
            }
        }
    }

    private normalizeRelativePath(absPath: string): string {
        const relative = path.relative(this.rootPath, absPath) || path.basename(absPath);
        return relative.replace(/\\/g, '/');
    }

    private async buildSmartFileProfile(absPath: string, content: string, stats: FileStats | fs.Stats): Promise<SmartFileProfile> {
        await this.dependencyGraph.ensureBuilt();
        const relativePath = path.relative(this.rootPath, absPath) || path.basename(absPath);
        const [outgoingDeps, incomingRefs] = await Promise.all([
            this.dependencyGraph.getDependencies(absPath, 'downstream').then(edges => edges.map(e => e.to)),
            this.dependencyGraph.getDependencies(absPath, 'upstream').then(edges => edges.map(e => e.from))
        ]);
        const normalizedOutgoingDeps = outgoingDeps.map(dep => this.normalizeRelativePath(dep));
        const normalizedIncomingRefs = incomingRefs.map(ref => this.normalizeRelativePath(ref));

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

        const mtimeMs = typeof (stats as any).mtimeMs === "number"
            ? (stats as any).mtimeMs
            : (stats as any).mtime instanceof Date
                ? (stats as any).mtime.getTime()
                : typeof (stats as any).mtime === "number"
                    ? (stats as any).mtime
                    : Date.now();

        const metadata: SmartFileProfile['metadata'] = {
            filePath: absPath,
            relativePath,
            sizeBytes: stats.size,
            lineCount,
            language: path.extname(absPath).replace('.', '') || null,
            lastModified: new Date(mtimeMs).toISOString(),
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
            incomingCount: normalizedIncomingRefs.length,
            incomingFiles: normalizedIncomingRefs.slice(0, 10),
            outgoingCount: normalizedOutgoingDeps.length,
            outgoingFiles: normalizedOutgoingDeps.slice(0, 10)
        };
        const testFiles = this.detectTestFiles(normalizedIncomingRefs);
        if (testFiles.length > 0) {
            usage.testFiles = testFiles;
        }

        const guidance = this.buildGuidance(metadata, metaAnalysis);

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

    private buildGuidance(metadata: SmartFileProfile['metadata'], meta: FileMetadataAnalysis): SmartFileProfile['guidance'] {
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
        if (!fileEdits || fileEdits.length === 0) {
            return null;
        }
        const absPaths = fileEdits.map(entry => entry.filePath);
        return this.generateBatchGuidance(absPaths);
    }

    private async generateBatchGuidance(filePaths: string[], pattern?: string): Promise<BatchEditGuidance | null> {
        if (!filePaths || filePaths.length <= 1) {
            return null;
        }
        const unique = new Map<string, string>();
        for (const abs of filePaths) {
            const rel = this.normalizeRelativePath(abs);
            unique.set(rel, abs);
        }
        const normalized = Array.from(unique.entries()).map(([rel, abs]) => ({ rel, abs }));
        if (normalized.length <= 1) {
            return null;
        }

        const { clusters, companionSuggestions } = await this.computeBatchClusters(normalized);
        const opportunities = await this.detectBatchOpportunities(normalized, pattern);

        if (clusters.length === 0 && companionSuggestions.length === 0 && opportunities.length === 0) {
            return null;
        }

        return {
            clusters,
            companionSuggestions,
            opportunities: opportunities.length ? opportunities : undefined
        };
    }

    private async computeBatchClusters(normalized: { abs: string; rel: string }[]): Promise<{
        clusters: BatchEditGuidance['clusters'];
        companionSuggestions: BatchEditGuidance['companionSuggestions'];
    }> {
        const editSet = new Set(normalized.map(entry => entry.rel));
        const adjacency = new Map<string, Set<string>>();
        const dependencyCache = new Map<string, { incoming: string[]; outgoing: string[] }>();

        await Promise.all(normalized.map(async ({ abs, rel }) => {
            const [incoming, outgoing] = await Promise.all([
                this.dependencyGraph.getDependencies(abs, 'upstream').then(edges => edges.map(e => e.from)),
                this.dependencyGraph.getDependencies(abs, 'downstream').then(edges => edges.map(e => e.to))
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

        return { clusters, companionSuggestions };
    }

    private async detectBatchOpportunities(
        normalized: { abs: string; rel: string }[],
        pattern?: string
    ): Promise<BatchOpportunity[]> {
        if (normalized.length <= 1) {
            return [];
        }

        const importUsage = new Map<string, Set<string>>();
        const traitUsage = new Map<string, Set<string>>();

        for (const entry of normalized) {
            try {
                const content = await this.fileSystem.readFile(entry.abs);
                this.collectImportUsage(content, entry.rel, importUsage);
                this.collectTraitUsage(content, entry.rel, traitUsage);
            } catch (error) {
                if (ENABLE_DEBUG_LOGS) {
                    console.error(`[batch_guidance] Failed to analyze ${entry.abs}`, error);
                }
            }
        }

        let opportunities: BatchOpportunity[] = [];
        opportunities = opportunities.concat(this.createPatternOpportunities(normalized, importUsage, "add_import"));
        opportunities = opportunities.concat(this.createPatternOpportunities(normalized, traitUsage, "add_trait"));

        if (pattern && pattern.trim().length > 0) {
            const needle = pattern.trim().toLowerCase();
            opportunities = opportunities.filter(op =>
                op.type.includes(needle) ||
                op.description.toLowerCase().includes(needle) ||
                (op.notes?.some(note => note.toLowerCase().includes(needle)) ?? false)
            );
        }

        return opportunities;
    }

    private collectImportUsage(content: string, relPath: string, usage: Map<string, Set<string>>): void {
        const jsImportRegex = /import\s+(?:[\w*\s{},]+from\s+)?['"]([^'"]+)['"]/g;
        const requireRegex = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
        const phpUseRegex = /^use\s+([^;]+);/gm;

        const record = (key: string) => {
            if (!key) return;
            const normalizedKey = key.trim();
            if (!normalizedKey) return;
            if (!usage.has(normalizedKey)) {
                usage.set(normalizedKey, new Set());
            }
            usage.get(normalizedKey)!.add(relPath);
        };

        let match;
        while ((match = jsImportRegex.exec(content)) !== null) {
            record(match[1]);
        }
        while ((match = requireRegex.exec(content)) !== null) {
            record(match[1]);
        }
        while ((match = phpUseRegex.exec(content)) !== null) {
            record(match[1]);
        }
    }

    private collectTraitUsage(content: string, relPath: string, usage: Map<string, Set<string>>): void {
        const traitRegex = /^\s+use\s+([A-Z][\w\\]+);/gm;
        let match;
        while ((match = traitRegex.exec(content)) !== null) {
            const trait = match[1];
            if (!usage.has(trait)) {
                usage.set(trait, new Set());
            }
            usage.get(trait)!.add(relPath);
        }
    }

    private createPatternOpportunities(
        normalized: { abs: string; rel: string }[],
        usage: Map<string, Set<string>>,
        type: "add_import" | "add_trait"
    ): BatchOpportunity[] {
        const totalFiles = normalized.length;
        const opportunities: BatchOpportunity[] = [];
        for (const [symbol, files] of usage) {
            const supportingFiles = Array.from(files);
            if (supportingFiles.length === 0 || supportingFiles.length === totalFiles) {
                continue;
            }
            if (supportingFiles.length < Math.max(2, Math.ceil(totalFiles * 0.5))) {
                continue;
            }
            const affectedFiles = normalized
                .filter(entry => !files.has(entry.rel))
                .map(entry => entry.rel);
            if (affectedFiles.length === 0) continue;
            const coverage = supportingFiles.length / totalFiles;
            const confidence = Number(Math.min(0.95, 0.4 + coverage * 0.5).toFixed(2));
            const description = type === "add_import"
                ? `Import "${symbol}" appears in ${supportingFiles.length}/${totalFiles} files; consider adding it to ${affectedFiles.length} file(s).`
                : `Trait "${symbol}" is used in ${supportingFiles.length}/${totalFiles} files; consider adding it to ${affectedFiles.length} file(s).`;
            const suggestedEdit: SuggestedBatchEdit = type === "add_import"
                ? {
                    operation: "insert",
                    insertMode: "before",
                    targetHint: "module import block",
                    replacementTemplate: `import { /* members */ } from "${symbol}";`
                }
                : {
                    operation: "insert",
                    insertMode: "after",
                    targetHint: "inside class body after opening brace",
                    replacementTemplate: `    use ${symbol};`
                };
            opportunities.push({
                type,
                description,
                affectedFiles,
                supportingFiles,
                confidence,
                suggestedEdit,
                notes: [`Currently in: ${supportingFiles.join(", ")}`]
            });
        }
        return opportunities;
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
            return await this.fileSystem.exists(absPath);
        } catch {
            return false;
        }
    }

    private hashContent(content: string): string {
        return crypto.createHash("sha256").update(content).digest("hex");
    }

    private buildContentPreview(content: string, limit: number = SmartContextServer.DELETE_PREVIEW_CHARS): string {
        if (content.length <= limit) {
            return content;
        }
        return `${content.substring(0, limit)}\n...[truncated]`;
    }

    private async buildNextActionHintForFile(filePath: string, edits: Edit[], dryRun: boolean): Promise<NextActionHint | undefined> {
        if (dryRun) {
            return undefined;
        }
        try {
            const content = await this.fileSystem.readFile(filePath);
            const lines = content.split(/\r?\n/);
            const lineCount = lines.length;
            return {
                suggestReRead: true,
                modifiedContent: lineCount <= 100 ? content : undefined,
                affectedLineRange: this.deriveAffectedLineRange(edits)
            };
        } catch (error) {
            if (ENABLE_DEBUG_LOGS) {
                console.error(`[edit_code] Failed to build nextActionHint for ${filePath}`, error);
            }
            return {
                suggestReRead: true
            };
        }
    }

    private deriveAffectedLineRange(edits: Edit[]): LineRange | undefined {
        let minLine: number | undefined;
        let maxLine: number | undefined;

        for (const edit of edits) {
            if (edit.lineRange) {
                minLine = minLine === undefined ? edit.lineRange.start : Math.min(minLine, edit.lineRange.start);
                maxLine = maxLine === undefined ? edit.lineRange.end : Math.max(maxLine, edit.lineRange.end);
                continue;
            }
            if (edit.insertLineRange?.start) {
                const line = edit.insertLineRange.start;
                minLine = minLine === undefined ? line : Math.min(minLine, line);
                maxLine = maxLine === undefined ? line : Math.max(maxLine, line);
            }
        }

        if (minLine === undefined || maxLine === undefined) {
            return undefined;
        }
        return { start: minLine, end: maxLine };
    }

    private buildRefactoringGuidance(context?: RefactoringContext, batchSize?: number): string | undefined {
        if (!context) {
            return undefined;
        }
        const estimated = context.estimatedEdits ?? batchSize;
        if (estimated && estimated > 10) {
            const scope = context.scope ?? "project";
            const pattern = context.pattern ?? "refactor";
            const intro = `⚠️  Large ${pattern} refactoring detected (${estimated} planned edits, scope: ${scope}).`;
            const suggestions = [
                "💡 Consider:",
                "  1. Using analyze_relationship to enumerate all affected references.",
                "  2. Splitting the work into smaller batches (5-10 edits each).",
                "  3. Leveraging write_file for sweeping structural rewrites."
            ].join("\n");
            return `${intro}\n\n${suggestions}\n\nProceeding with current batch...`;
        }
        return undefined;
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
            this.fileSystem.readFile(absPath),
            this.fileSystem.stat(absPath)
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
                payload = await this.skeletonGenerator.generateSkeleton(absPath, content, args.skeletonOptions);
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

        let searchResult: SearchProjectResult = { results: [] };

        if (requestedType === "directory") {
            searchResult = { results: await this.runDirectorySearchResults(args.query, maxResults) };
        } else if (requestedType === "symbol") {
            searchResult = { results: await this.runSymbolSearchResults(args.query, maxResults) };
        } else if (requestedType === "file") {
            searchResult = { results: await this.runFileSearchResults(args.query, maxResults, args) };
        } else if (requestedType === "filename") {
            searchResult = {
                results: await this.searchEngine.searchFilenames(
                    args.query,
                    { fuzzyFilename: true, filenameOnly: false, maxResults }
                ),
                inferredType: "filename"
            };

        } else {
            // Auto mode
            const inferred = this.inferSearchProjectType(args.query);
            if (inferred === "directory") {
                searchResult = { results: await this.runDirectorySearchResults(args.query, maxResults), inferredType: inferred };
            } else if (inferred === "file") {
                searchResult = { results: await this.runFileSearchResults(args.query, maxResults, args), inferredType: inferred };
            } else {
                let symbolResults = await this.runClusterSearchResults(args.query, maxResults);
                if (symbolResults.length === 0) {
                    symbolResults = await this.runSymbolSearchResults(args.query, maxResults);
                }

                // Fallback to text search if no symbols found in auto mode
                if (symbolResults.length === 0) {
                    const fileResults = await this.runFileSearchResults(args.query, maxResults, args);
                    if (fileResults.length > 0) {
                        searchResult = { results: fileResults, inferredType: "file" };
                    } else {
                        searchResult = { results: [], inferredType: "symbol" };
                    }
                } else {
                    searchResult = { results: symbolResults, inferredType: "symbol" };
                }
            }
        }

        if (searchResult.results.length === 0) {
            const enhancedDetails = ErrorEnhancer.enhanceSearchNotFound(args.query);
            return {
                ...searchResult,
                message: "No results found",
                suggestions: enhancedDetails.toolSuggestions,
                nextActionHint: enhancedDetails.nextActionHint
            };
        }

        return searchResult;
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

    private async runFileSearchResults(query: string, maxResults: number, args?: SearchProjectArgs): Promise<SearchProjectResult["results"]> {
        const matches = await this.searchEngine.scout({
            keywords: [query],
            basePath: this.rootPath,
            fileTypes: args?.fileTypes,
            snippetLength: args?.snippetLength,
            matchesPerFile: args?.matchesPerFile,
            groupByFile: args?.groupByFile,
            deduplicateByContent: args?.deduplicateByContent
        });
        return matches.slice(0, maxResults).map(match => ({
            type: "file",
            path: match.filePath,
            score: this.clampScore(match.score ?? 0),
            context: match.preview,
            line: match.lineNumber,
            groupedMatches: match.groupedMatches,
            matchCount: match.matchCount
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

        // Ensure file-level dependency graph is available for dependency/impact queries.
        if (mode === "dependencies" || mode === "impact") {
            await this.dependencyGraph.ensureBuilt();
        }

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
                const downstream = await this.dependencyGraph.getDependencies(absTarget, 'downstream');
                for (const dep of downstream) {
                    const depId = addFileNode(dep.to);
                    edges.push({ source: baseId, target: depId, relation: "imports" });
                }
            }
            if (direction === "upstream" || direction === "both") {
                const upstream = await this.dependencyGraph.getDependencies(absTarget, 'upstream');
                for (const parent of upstream) {
                    const parentId = addFileNode(parent.from);
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

        // Tier 1: Symbol Index (includes fuzzy search)
        const matches = await this.symbolIndex.search(args.target);

        if (matches.length > 0) {
            const first = matches[0];
            const absPath = this._getAbsPathAndVerify(first.filePath);
            return {
                type: "symbol",
                path: this.normalizeRelativePath(absPath),
                symbolName: first.symbol.name
            };
        }

        // Tier 2: AST Direct Parsing
        const astMatches = await this.fallbackResolver.parseFileForSymbol(args.target);
        if (astMatches.length > 0) {
            const first = astMatches[0];
            const absPath = this._getAbsPathAndVerify(first.filePath);
            return {
                type: "symbol",
                path: this.normalizeRelativePath(absPath),
                symbolName: first.symbol.name
            };
        }

        // Tier 3: Regex Heuristic
        const regexMatches = await this.fallbackResolver.regexSymbolSearch(args.target);
        if (regexMatches.length > 0) {
            const first = regexMatches[0];
            const absPath = this._getAbsPathAndVerify(first.filePath);
            return {
                type: "symbol",
                path: this.normalizeRelativePath(absPath),
                symbolName: first.symbol.name
            };
        }

        // Enhanced error with suggestions
        const enhancedDetails = ErrorEnhancer.enhanceSymbolNotFound(
            args.target,
            this.symbolIndex
        );

        throw new McpError(
            ErrorCode.InvalidParams,
            `Unable to resolve symbol '${args.target}'. Provide 'contextPath' to disambiguate.`,
            enhancedDetails
        );
    }

    private async executeEditCode(args: EditCodeArgs): Promise<EditCodeResult> {
        if (!args || !Array.isArray(args.edits) || args.edits.length === 0) {
            throw new McpError(ErrorCode.InvalidParams, "Provide at least one edit in 'edits'.");
        }

        // 🔄 경로 정규화: 절대경로를 상대경로로 자동 변환
        // IDE 플러그인(VSCode)은 절대경로를 전송하고, CLI는 상대경로를 전송합니다.
        // 여기서 자동으로 정규화하므로 두 형태 모두 지원됩니다.
        args.edits = args.edits.map(edit => {
            try {
                const normalizedPath = this.pathNormalizer.normalize(edit.filePath);
                return { ...edit, filePath: normalizedPath };
            } catch (error: any) {
                // 경로 정규화 실패 시 원본 경로 사용하고 나중에 에러 처리
                console.warn(`[PathNormalizer] Failed to normalize path "${edit.filePath}": ${error.message}`);
                return edit;
            }
        });

        const dryRun = Boolean(args.dryRun);
        const createDirs = Boolean(args.createMissingDirectories);
        const ignoreMistakes = Boolean(args.ignoreMistakes);
        const diffMode: DiffMode | undefined = args.diffMode === "semantic" ? "semantic" : undefined;
        const transactionId = dryRun
            ? undefined
            : (typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
        const results: EditCodeResult["results"] = [];
        const rollbackActions: Array<() => Promise<void>> = [];
        const touchedFiles = new Set<string>();
        const warnings: string[] = [];
        const refactorGuidance = this.buildRefactoringGuidance(args.refactoringContext, args.edits.length);
        if (refactorGuidance) {
            warnings.push(refactorGuidance);
        }

        try {
            await this.handleCreateOperations(args.edits, dryRun, createDirs, results, rollbackActions, touchedFiles);
            await this.handleDeleteOperations(args.edits, dryRun, results, rollbackActions, touchedFiles);
            await this.handleReplaceOperations(args.edits, dryRun, ignoreMistakes, results, touchedFiles, diffMode);
        } catch (error: any) {
            await this.rollbackActions(rollbackActions);
            const message = error instanceof McpError ? error.message : (error?.message ?? "edit_code failed");
            results.push({ filePath: error?.filePath ?? args.edits[0]?.filePath ?? "", applied: false, error: message });
            return {
                success: false,
                results,
                transactionId,
                warnings: warnings.length ? warnings : undefined,
                message: refactorGuidance
            };
        }

        if (!dryRun && touchedFiles.size > 0) {
            await this.invalidateTouchedFiles(touchedFiles);
            for (const file of touchedFiles) {
                this.symbolIndex.markFileModified(file);
            }
        }

        return {
            success: true,
            results,
            transactionId,
            warnings: warnings.length ? warnings : undefined,
            message: refactorGuidance
        };
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
                    await this.fileSystem.createDir(parentDir);
                }
                await this.fileSystem.writeFile(absPath, edit.replacementString);
                touchedFiles.add(absPath);
                rollback.push(async () => {
                    if (await this.pathExists(absPath)) {
                        await this.fileSystem.deleteFile(absPath);
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
            const [content, stats] = await Promise.all([
                this.fileSystem.readFile(absPath),
                this.fileSystem.stat(absPath)
            ]);
            const lineCount = content.split(/\r?\n/).length;
            const fileSize = stats.size;
            const contentHash = this.hashContent(content);
            const preview = this.buildContentPreview(content);
            const safetyLevel: SafetyLevel = edit.safetyLevel ?? "strict";
            const isLargeFile = fileSize > SmartContextServer.DELETE_LARGE_FILE_BYTES ||
                lineCount > SmartContextServer.DELETE_LARGE_FILE_LINES;
            const requiresConfirmation = safetyLevel === "strict" && isLargeFile;
            const relativePath = this.normalizeRelativePath(absPath);

            if (edit.confirmationHash && edit.confirmationHash !== contentHash) {
                results.push({
                    filePath: relativePath,
                    applied: false,
                    hashMismatch: true,
                    fileSize,
                    lineCount,
                    contentPreview: preview,
                    error: [
                        "Hash mismatch: File content changed since confirmation.",
                        `Expected: ${edit.confirmationHash}`,
                        `Actual:   ${contentHash}`,
                        "Re-run a dry run to fetch the latest hash before deleting."
                    ].join("\n")
                });
                continue;
            }

            if (requiresConfirmation && !dryRun && !edit.confirmationHash) {
                results.push({
                    filePath: relativePath,
                    applied: false,
                    requiresConfirmation: true,
                    fileSize,
                    lineCount,
                    contentPreview: preview,
                    error: [
                        "⚠️  Large file deletion requires confirmation.",
                        `File: ${edit.filePath} (${fileSize} bytes, ${lineCount} lines)`,
                        "",
                        "Add confirmationHash to your delete operation:",
                        `  confirmationHash: \"${contentHash}\"`,
                        "",
                        "Or set safetyLevel: \"force\" to bypass (not recommended)."
                    ].join("\n")
                });
                continue;
            }

            if (dryRun) {
                results.push({
                    filePath: relativePath,
                    applied: false,
                    fileSize,
                    lineCount,
                    contentPreview: preview,
                    diff: [
                        "📋 Dry Run: Would delete file",
                        `  Size: ${fileSize} bytes (${lineCount} lines)`,
                        `  Hash: ${contentHash}`,
                        "",
                        "Preview:",
                        preview
                    ].join("\n")
                });
                continue;
            }

            await this.fileSystem.deleteFile(absPath);
            touchedFiles.add(absPath);
            const backup = content;
            rollback.push(async () => {
                const parentDir = path.dirname(absPath);
                if (!await this.pathExists(parentDir)) {
                    await this.fileSystem.createDir(parentDir);
                }
                await this.fileSystem.writeFile(absPath, backup);
                const restored = await this.fileSystem.readFile(absPath);
                const restoredHash = this.hashContent(restored);
                if (restoredHash !== contentHash) {
                    throw new Error(`Rollback verification failed for ${absPath}`);
                }
            });

            results.push({
                filePath: relativePath,
                applied: true,
                fileSize,
                lineCount,
                diff: `Deleted file (${fileSize} bytes, ${lineCount} lines, hash ${contentHash}).`
            });
        }
    }

    private async handleReplaceOperations(
        edits: EditCodeEdit[],
        dryRun: boolean,
        ignoreMistakes: boolean,
        results: EditCodeResult["results"],
        touchedFiles: Set<string>,
        diffMode?: DiffMode
    ): Promise<void> {
        const fileMap = new Map<string, Edit[]>();
        const fileOrder: string[] = [];
        for (const edit of edits) {
            if (edit.operation !== "replace") continue;
            const insertMode = edit.insertMode;
            const requiresTargetString = !insertMode || insertMode === "before" || insertMode === "after";
            if (requiresTargetString && typeof edit.targetString !== "string") {
                throw new McpError(
                    ErrorCode.InvalidParams,
                    insertMode
                        ? `insertMode "${insertMode}" requires 'targetString'.`
                        : "replace operation requires 'targetString'."
                );
            }
            if (insertMode === "at") {
                const lineStart = edit.insertLineRange?.start;
                if (typeof lineStart !== "number" || !Number.isFinite(lineStart)) {
                    throw new McpError(
                        ErrorCode.InvalidParams,
                        'insertMode "at" requires insertLineRange.start (1-based line number).'
                    );
                }
            }
            const absPath = this._getAbsPathAndVerify(edit.filePath);
            if (!fileMap.has(absPath)) {
                fileMap.set(absPath, []);
                fileOrder.push(absPath);
            }
            const normalizedEdit: Edit = {
                targetString: typeof edit.targetString === "string" ? edit.targetString : "",
                replacementString: edit.replacementString ?? "",
                lineRange: edit.lineRange,
                beforeContext: edit.beforeContext,
                afterContext: edit.afterContext,
                fuzzyMode: edit.fuzzyMode ?? (ignoreMistakes ? "whitespace" : undefined),
                anchorSearchRange: edit.anchorSearchRange,
                indexRange: edit.indexRange,
                normalization: edit.normalization,
                normalizationConfig: edit.normalizationConfig,
                expectedHash: edit.expectedHash,
                contextFuzziness: edit.contextFuzziness,
                insertMode,
                insertLineRange: edit.insertLineRange
            };
            fileMap.get(absPath)!.push(normalizedEdit);
        }

        if (fileMap.size === 0) {
            return;
        }

        const fileEdits = fileOrder.map(filePath => ({ filePath, edits: fileMap.get(filePath)! }));
        const result = await this.editCoordinator.applyBatchEdits(
            fileEdits,
            dryRun,
            diffMode ? { diffMode } : undefined
        );
        if (!result.success) {
            throw new McpError(ErrorCode.InternalError, result.message ?? "Failed to apply edits.");
        }

        if (!dryRun) {
            for (const { filePath } of fileEdits) {
                touchedFiles.add(filePath);
            }
        }

        for (const { filePath, edits: fileSpecificEdits } of fileEdits) {
            const relativePath = this.normalizeRelativePath(filePath);
            const nextActionHint = await this.buildNextActionHintForFile(filePath, fileSpecificEdits, dryRun);
            results.push({
                filePath: relativePath,
                applied: !dryRun,
                diff: result.message ?? (dryRun ? "Dry run: edits validated." : "Edits applied."),
                nextActionHint
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
            await this.dependencyGraph.invalidateFile(absPath);
            this.callGraphBuilder.invalidateFile(absPath);
            this.typeDependencyTracker.invalidateFile(absPath);
            this.clusterSearchEngine.invalidateFile(absPath);
            await this.searchEngine.invalidateFile(absPath);
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
                    markdown = await this.fileSystem.readFile(playbookPath);
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
                await this.dependencyGraph.ensureBuilt();
                const status = await this.dependencyGraph.getIndexStatus();
                const indexerStatus = this.incrementalIndexer?.getActivitySnapshot();
                return {
                    output: "Index status retrieved.",
                    data: {
                        dependencyIndex: status,
                        indexer: indexerStatus
                    }
                };
            }
            case "metrics": {
                const snapshot = metrics.snapshot();
                const indexerStats = this.incrementalIndexer?.getQueueStats();
                return {
                    output: "Metrics snapshot retrieved.",
                    data: {
                        ...snapshot,
                        indexer: indexerStats
                    }
                };
            }
            case "reindex": {
                const startTime = Date.now();
                try {
                    console.info('[SmartContextServer] Starting full project reindex...');

                    console.debug('[SmartContextServer] Clearing index database...');
                    this.indexDatabase.clearAllFiles();

                    const shouldRestartIndexer = !!this.incrementalIndexer;
                    if (this.incrementalIndexer) {
                        console.debug('[SmartContextServer] Stopping incremental indexer...');
                        await this.incrementalIndexer.stop();
                        this.incrementalIndexer = undefined;
                    }

                    console.debug('[SmartContextServer] Reloading module resolver config...');
                    this.moduleResolver.reloadConfig();

                    console.debug('[SmartContextServer] Clearing caches...');
                    this.symbolIndex.clearCache();
                    this.callGraphBuilder.clearCaches();
                    this.typeDependencyTracker.clearCaches();

                    if (shouldRestartIndexer) {
                        console.debug('[SmartContextServer] Starting incremental indexer for full scan...');
                        this.incrementalIndexer = new IncrementalIndexer(
                            this.rootPath,
                            this.symbolIndex,
                            this.dependencyGraph,
                            this.indexDatabase,
                            this.moduleResolver,
                            this.configurationManager
                        );
                        this.incrementalIndexer.start();
                        await this.incrementalIndexer.waitForInitialScan();
                    }

                    const elapsed = Date.now() - startTime;
                    console.info(`[SmartContextServer] Full project reindex completed in ${elapsed}ms`);

                    return {
                        output: `Project re-indexed successfully in ${elapsed}ms`,
                        data: {
                            status: "complete",
                            durationMs: elapsed,
                            timestamp: new Date().toISOString()
                        }
                    };
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    console.error('[SmartContextServer] Reindex failed:', message);
                    throw new McpError(
                        ErrorCode.InternalError,
                        `Re-indexing failed: ${message}`
                    );
                }
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
        const intentTools = [
            {
                name: "read_code",
                description: "Reads code with full, skeleton, or fragment views and standardized metadata.",
                inputSchema: {
                    type: "object",
                    properties: {
                        filePath: { type: "string" },
                        view: { type: "string", enum: ["full", "skeleton", "fragment"], default: "full" },
                        lineRange: { type: "string", description: "Required when view=\"fragment\". Format: start-end." },
                        skeletonOptions: {
                            type: "object",
                            properties: {
                                includeMemberVars: { type: "boolean", description: "Show member variables and attributes in skeleton output.", default: true },
                                includeComments: { type: "boolean", description: "Include comments and doc blocks.", default: false },
                                detailLevel: { type: "string", enum: ["minimal", "standard", "detailed"], default: "standard" },
                                maxMemberPreview: { type: "number", description: "Number of array/object entries to preview for member declarations.", default: 3 }
                            }
                        }
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
                        maxResults: { type: "number", default: 20 },
                        fileTypes: {
                            type: "array",
                            items: { type: "string" },
                            description: "Limit file-based search results to specific extensions (e.g., [\"ts\",\"tsx\"])."
                        },
                        snippetLength: {
                            type: "number",
                            description: "Override preview length (characters). Set to 0 to omit previews."
                        },
                        matchesPerFile: {
                            type: "number",
                            description: "Maximum matches to collect per file before ranking."
                        },
                        groupByFile: {
                            type: "boolean",
                            description: "Group multiple matches from the same file into a single entry."
                        },
                        deduplicateByContent: {
                            type: "boolean",
                            description: "Collapse identical previews that appear across multiple files."
                        }
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
                                    normalization: { type: "string", enum: ["exact", "whitespace", "structural"] },
                                    contextFuzziness: { type: "string", enum: ["strict", "normal", "loose"] },
                                    insertMode: { type: "string", enum: ["before", "after", "at"] },
                                    insertLineRange: { type: "object", properties: { start: { type: "number" } } }
                                },
                                required: ["filePath", "operation"]
                            }
                        },
                        dryRun: { type: "boolean", default: false },
                        createMissingDirectories: { type: "boolean", default: false },
                        ignoreMistakes: { type: "boolean", default: false },
                        diffMode: {
                            type: "string",
                            enum: ["myers", "semantic"],
                            description: "Use 'semantic' for Patience diff preview during dry runs."
                        }
                    },
                    required: ["edits"]
                }
            },
            {
                name: "get_batch_guidance",
                description: "Analyzes multiple files to suggest related batch edits (shared imports, traits, companions).",
                inputSchema: {
                    type: "object",
                    properties: {
                        filePaths: {
                            type: "array",
                            items: { type: "string" },
                            description: "List of file paths (relative or absolute) to analyze."
                        },
                        pattern: {
                            type: "string",
                            description: "Optional keyword to filter opportunities (e.g., 'trait', 'import')."
                        }
                    },
                    required: ["filePaths"]
                }
            },
            {
                name: "manage_project",
                description: "Runs project-level commands like undo, redo, workflow guidance, index status, metrics, and manual reindexing.",
                inputSchema: {
                    type: "object",
                    properties: {
                        command: { type: "string", enum: ["undo", "redo", "guidance", "status", "metrics", "reindex"] }
                    },
                    required: ["command"]
                }
            }
        ];

        if (!this.exposeCompatTools) {
            return intentTools;
        }

        const extendedTools = [
            {
                name: "read_file",
                description: "Reads a file. Returns a Smart File Profile by default; set full=true (or view=\"full\") for JSON-wrapped raw content (may be truncated).",
                inputSchema: {
                    type: "object",
                    properties: {
                        path: { type: "string", description: "Path to the file" },
                        filePath: { type: "string", description: "Path to the file (legacy)" },
                        full: { type: "boolean" },
                        view: { type: "string", enum: ["full", "profile"] }
                    }
                }
            },
            {
                name: "write_file",
                description: "Overwrites a file's full contents.",
                inputSchema: {
                    type: "object",
                    properties: {
                        path: { type: "string" },
                        filePath: { type: "string" },
                        content: { type: "string" }
                    },
                    required: ["content"]
                }
            },
            {
                name: "analyze_file",
                description: "Generates a comprehensive profile of a file, including metadata, structure, complexity, and dependencies.",
                inputSchema: {
                    type: "object",
                    properties: {
                        path: { type: "string" },
                        filePath: { type: "string" }
                    }
                }
            },
            {
                name: "read_fragment",
                description: "Reads file fragments by explicit line ranges or keyword/pattern matches.",
                inputSchema: {
                    type: "object",
                    properties: {
                        filePath: { type: "string" },
                        keywords: { type: "array", items: { type: "string" } },
                        patterns: { type: "array", items: { type: "string" } },
                        lineRanges: { type: "array", items: { type: "object", properties: { start: { type: "number" }, end: { type: "number" } }, required: ["start", "end"] } },
                        contextLines: { type: "number" }
                    },
                    required: ["filePath"]
                }
            },
            {
                name: "list_directory",
                description: "Lists a directory tree (ASCII).",
                inputSchema: {
                    type: "object",
                    properties: {
                        path: { type: "string" },
                        depth: { type: "number" }
                    },
                    required: ["path"]
                }
            },
            {
                name: "search_files",
                description: "Legacy file search (SearchEngine.scout).",
                inputSchema: {
                    type: "object",
                    properties: {
                        keywords: { type: "array", items: { type: "string" } },
                        patterns: { type: "array", items: { type: "string" } },
                        includeGlobs: { type: "array", items: { type: "string" } },
                        excludeGlobs: { type: "array", items: { type: "string" } },
                        smartCase: { type: "boolean" },
                        caseSensitive: { type: "boolean" },
                        maxMatchesPerFile: { type: "number" }
                    }
                }
            },
            {
                name: "search_with_context",
                description: "Legacy cluster search entry point.",
                inputSchema: {
                    type: "object",
                    properties: {
                        query: { type: "string" }
                    },
                    required: ["query"]
                }
            },
            {
                name: "expand_cluster_relationship",
                description: "Expands a cached cluster relationship from a previous search_with_context call.",
                inputSchema: {
                    type: "object",
                    properties: {
                        clusterId: { type: "string" },
                        relationshipType: { type: "string", enum: ["callers", "callees", "typeFamily"] }
                    },
                    required: ["clusterId", "relationshipType"]
                }
            },
            {
                name: "rebuild_index",
                description: "Rebuilds internal indexes (legacy).",
                inputSchema: { type: "object", properties: {} }
            },
            {
                name: "invalidate_index_file",
                description: "Invalidates indexes for a single file (legacy).",
                inputSchema: {
                    type: "object",
                    properties: { filePath: { type: "string" } },
                    required: ["filePath"]
                }
            },
            {
                name: "invalidate_index_directory",
                description: "Invalidates indexes for a directory (legacy).",
                inputSchema: {
                    type: "object",
                    properties: { directoryPath: { type: "string" }, path: { type: "string" } }
                }
            },
            {
                name: "edit_file",
                description: "Legacy single-file edit wrapper (deprecated; prefer edit_code).",
                inputSchema: {
                    type: "object",
                    properties: {
                        filePath: { type: "string" },
                        edits: { type: "array", items: { type: "object" } },
                        dryRun: { type: "boolean" }
                    },
                    required: ["filePath", "edits"]
                }
            },
            {
                name: "batch_edit",
                description: "Legacy batch edit wrapper (deprecated; prefer edit_code).",
                inputSchema: {
                    type: "object",
                    properties: {
                        fileEdits: { type: "array", items: { type: "object" } },
                        dryRun: { type: "boolean" }
                    },
                    required: ["fileEdits"]
                }
            },
            {
                name: "undo_last_edit",
                description: "Legacy undo (deprecated; prefer manage_project undo).",
                inputSchema: { type: "object", properties: {} }
            },
            {
                name: "redo_last_edit",
                description: "Legacy redo (deprecated; prefer manage_project redo).",
                inputSchema: { type: "object", properties: {} }
            },
            {
                name: "get_index_status",
                description: "Legacy index status (deprecated; prefer manage_project status).",
                inputSchema: { type: "object", properties: {} }
            },
            {
                name: "get_workflow_guidance",
                description: "Legacy workflow guidance (deprecated; prefer manage_project guidance).",
                inputSchema: { type: "object", properties: {} }
            },
            {
                name: "debug_edit_match",
                description: "Returns diagnostics for an edit match.",
                inputSchema: {
                    type: "object",
                    properties: {
                        filePath: { type: "string" },
                        targetString: { type: "string" },
                        lineRange: { type: "object" },
                        normalization: { type: "string" }
                    },
                    required: ["filePath", "targetString"]
                }
            },
            {
                name: "read_file_skeleton",
                description: "Legacy skeleton reader.",
                inputSchema: {
                    type: "object",
                    properties: {
                        filePath: { type: "string" },
                        format: { type: "string", enum: ["text", "json"] }
                    },
                    required: ["filePath"]
                }
            },
            {
                name: "search_symbol_definitions",
                description: "Legacy symbol search.",
                inputSchema: {
                    type: "object",
                    properties: { query: { type: "string" } },
                    required: ["query"]
                }
            },
            {
                name: "get_file_dependencies",
                description: "Legacy file dependency listing.",
                inputSchema: {
                    type: "object",
                    properties: { filePath: { type: "string" }, direction: { type: "string" } },
                    required: ["filePath"]
                }
            },
            {
                name: "analyze_impact",
                description: "Legacy transitive dependency impact.",
                inputSchema: {
                    type: "object",
                    properties: { filePath: { type: "string" }, direction: { type: "string" }, maxDepth: { type: "number" } },
                    required: ["filePath"]
                }
            },
            {
                name: "analyze_symbol_impact",
                description: "Legacy call graph impact analysis.",
                inputSchema: {
                    type: "object",
                    properties: { symbolName: { type: "string" }, filePath: { type: "string" }, direction: { type: "string" }, maxDepth: { type: "number" } },
                    required: ["symbolName", "filePath"]
                }
            },
            {
                name: "analyze_type_dependencies",
                description: "Legacy type dependency analysis.",
                inputSchema: {
                    type: "object",
                    properties: { symbolName: { type: "string" }, filePath: { type: "string" }, direction: { type: "string" }, maxDepth: { type: "number" } },
                    required: ["symbolName", "filePath"]
                }
            },
            {
                name: "trace_data_flow",
                description: "Legacy data flow trace.",
                inputSchema: {
                    type: "object",
                    properties: { variableName: { type: "string" }, fromFile: { type: "string" }, fromLine: { type: "number" }, maxSteps: { type: "number" } },
                    required: ["variableName", "fromFile"]
                }
            },
            {
                name: "find_symbol_references",
                description: "Legacy reference search.",
                inputSchema: {
                    type: "object",
                    properties: { symbolName: { type: "string" }, contextFile: { type: "string" } },
                    required: ["symbolName", "contextFile"]
                }
            },
            {
                name: "preview_rename",
                description: "Legacy rename preview (dry run batch edit).",
                inputSchema: {
                    type: "object",
                    properties: { symbolName: { type: "string" }, definitionFilePath: { type: "string" }, newName: { type: "string" } },
                    required: ["symbolName", "definitionFilePath", "newName"]
                }
            }
        ];

        return [...intentTools, ...extendedTools];
    }

    private async handleCallTool(toolName: string, args: any): Promise<any> {
        try {
            switch (toolName) {
                case "read_code": {
                    if (!args || typeof args.filePath !== "string") {
                        return this._createErrorResponse("MissingParameter", "Provide 'filePath' to read_code.");
                    }
                    if (args.view === "fragment" && typeof args.lineRange !== "string") {
                        return this._createErrorResponse("MissingParameter", "Provide 'lineRange' when view=\"fragment\".");
                    }
                    const result = await this.executeReadCode(args as ReadCodeArgs);
                    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
                }
                case "search_project": {
                    if (!args || typeof args.query !== "string") {
                        return this._createErrorResponse("MissingParameter", "Provide 'query' to search_project.");
                    }
                    const result = await this.executeSearchProject(args as SearchProjectArgs);
                    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
                }
                case "analyze_relationship": {
                    if (!args || typeof args.target !== "string") {
                        return this._createErrorResponse("MissingParameter", "Provide 'target' to analyze_relationship.");
                    }
                    if (typeof args.mode !== "string") {
                        return this._createErrorResponse("MissingParameter", "Provide 'mode' to analyze_relationship.");
                    }
                    const result = await this.executeAnalyzeRelationship(args as AnalyzeRelationshipArgs);
                    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
                }
                case "edit_code": {
                    if (!args || !Array.isArray(args.edits)) {
                        return this._createErrorResponse("MissingParameter", "Provide 'edits' to edit_code.");
                    }
                    const result = await this.executeEditCode(args as EditCodeArgs);
                    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
                }
                case "get_batch_guidance": {
                    if (!args || !Array.isArray(args.filePaths) || args.filePaths.length === 0) {
                        return this._createErrorResponse("MissingParameter", "Provide 'filePaths' to get_batch_guidance.");
                    }
                    const absPaths = args.filePaths.map((filePath: string) => this._getAbsPathAndVerify(filePath));
                    const pattern = typeof args.pattern === "string" ? args.pattern : undefined;
                    const guidance = await this.generateBatchGuidance(absPaths, pattern);
                    if (!guidance) {
                        return { content: [{ type: "text", text: JSON.stringify({ message: "No batch opportunities detected." }, null, 2) }] };
                    }
                    return { content: [{ type: "text", text: JSON.stringify(guidance, null, 2) }] };
                }
                case "manage_project": {
                    if (!args || typeof args.command !== "string") {
                        return this._createErrorResponse("MissingParameter", "Provide 'command' to manage_project.");
                    }
                    const result = await this.executeManageProject(args as ManageProjectArgs);
                    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
                }
                case "read_file": {
                    const filePath = args.path || args.filePath;
                    if (!filePath) {
                        return this._createErrorResponse("MissingParameter", "Provide 'path' to read_file.");
                    }
                    const absPath = this._getAbsPathAndVerify(filePath);
                    const fullMode = args.full === true || args.view === "full";

                    try {
                        const [content, stats] = await Promise.all([
                            this.fileSystem.readFile(absPath),
                            this.fileSystem.stat(absPath)
                        ]);

                        if (fullMode) {
                            const maxBytes = this.readFileMaxBytes;
                            const rawBytes = Buffer.from(content, 'utf8');
                            const truncated = rawBytes.length > maxBytes;
                            const payloadBytes = truncated ? rawBytes.subarray(0, maxBytes) : rawBytes;
                            const payload = payloadBytes.toString('utf8');

                            const result = {
                                content: payload,
                                meta: {
                                    truncated,
                                    bytesReturned: Buffer.byteLength(payload, 'utf8'),
                                    maxBytes,
                                    fileSizeBytes: stats.size,
                                    nextAction: {
                                        tool: "read_code",
                                        args: { filePath, view: "skeleton" }
                                    }
                                }
                            };

                            return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
                        }

                        const profile = await this.buildSmartFileProfile(absPath, content, stats);
                        return { content: [{ type: "text", text: JSON.stringify(profile, null, 2) }] };
                    } catch (error: any) {
                        console.error(`Failed to read/build Smart File Profile for ${absPath}:`, error);
                        return this._createErrorResponse("InternalError", error.message);
                    }
                }
                case "analyze_file": {
                    // Logic moved from old read_file
                    const filePath = args.path || args.filePath;
                    if (!filePath) {
                        return this._createErrorResponse("MissingParameter", "Provide 'path' to analyze_file.");
                    }
                    const absPath = this._getAbsPathAndVerify(filePath);

                    try {
                        const [content, stats] = await Promise.all([
                            this.fileSystem.readFile(absPath),
                            this.fileSystem.stat(absPath)
                        ]);
                        const profile = await this.buildSmartFileProfile(absPath, content, stats);
                        return { content: [{ type: "text", text: JSON.stringify(profile, null, 2) }] };
                    } catch (error: any) {
                        console.error(`Failed to build Smart File Profile for ${absPath}:`, error);
                        return this._createErrorResponse("InternalError", error.message);
                    }
                }
                case "read_file_skeleton": {
                    const absPath = this._getAbsPathAndVerify(args.filePath);
                    const content = await this.fileSystem.readFile(absPath);
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
                    await this.dependencyGraph.ensureBuilt();
                    const absPath = this._getAbsPathAndVerify(args.filePath);
                    const direction = args.direction || 'outgoing';
                    const deps = await this.dependencyGraph.getDependencies(absPath, direction);
                    return { content: [{ type: "text", text: JSON.stringify(deps, null, 2) }] };
                }
                case "analyze_impact": {
                    await this.dependencyGraph.ensureBuilt();
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
                    await this.dependencyGraph.ensureBuilt();
                    const status = await this.dependencyGraph.getIndexStatus();
                    return { content: [{ type: "text", text: JSON.stringify(status, null, 2) }] };
                }
                case "rebuild_index": {
                    this.moduleResolver.clearCache();
                    await this.dependencyGraph.build();
                    this.callGraphBuilder.clearCaches();
                    this.typeDependencyTracker.clearCaches();
                    this.clusterSearchEngine.clearCache();
                    await this.searchEngine.rebuild();
                    const status = await this.dependencyGraph.getIndexStatus();
                    return { content: [{ type: "text", text: JSON.stringify({ message: "Index rebuilt successfully", status }, null, 2) }] };
                }
                case "invalidate_index_file": {
                    const absPath = this._getAbsPathAndVerify(args.filePath);
                    await this.dependencyGraph.invalidateFile(absPath);
                    this.callGraphBuilder.invalidateFile(absPath);
                    this.typeDependencyTracker.invalidateFile(absPath);
                    this.clusterSearchEngine.invalidateFile(absPath);
                    await this.searchEngine.invalidateFile(absPath);
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
                    await this.searchEngine.invalidateDirectory(absDir);
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
                    // Simple overwrite alias
                    const filePath = args.path || args.filePath;
                    if (!filePath) {
                        return this._createErrorResponse("MissingParameter", "Provide 'path' to write_file.");
                    }
                    if (args.content === undefined) {
                        return this._createErrorResponse("MissingParameter", "Provide 'content' to write_file.");
                    }
                    const absPath = this._getAbsPathAndVerify(filePath);
                    await this.fileSystem.writeFile(absPath, String(args.content));

                    // Invalidate indexes/caches
                    await this.dependencyGraph.invalidateFile(absPath);
                    this.callGraphBuilder.invalidateFile(absPath);
                    this.typeDependencyTracker.invalidateFile(absPath);
                    this.clusterSearchEngine.invalidateFile(absPath);
                    await this.searchEngine.invalidateFile(absPath);

                    return { content: [{ type: "text", text: `Successfully wrote to ${filePath}` }] };
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
                        await this.searchEngine.invalidateFile(absPath);
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
                            await this.searchEngine.invalidateFile(fileEdit.filePath);
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
                        markdown = await this.fileSystem.readFile(playbookPath);
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
                    const content = await this.fileSystem.readFile(absPath);
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
                    `Ambiguity detected. Refine your request by adding a 'lineRange' parameter to specify which occurrence to target. Conflicting lines are: ${ambiguousError.conflictingLines.join(', ')}.`, {
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
