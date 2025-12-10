
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import * as fs from "fs";
import { promisify } from "util";
import * as path from "path";
import * as ignore from "ignore";
import * as url from "url";

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
import { FileSearchResult, ReadFragmentResult, EditResult, DirectoryTree, Edit, EngineConfig, SmartFileProfile, SymbolInfo, ToolSuggestion, ImpactPreview, BatchEditGuidance } from "./types.js";

const readFileAsync = promisify(fs.readFile);
const writeFileAsync = promisify(fs.writeFile);
const statAsync = promisify(fs.stat);
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
    private sigintListener?: () => Promise<void>;

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
            .catch(error => {
                if (ENABLE_DEBUG_LOGS) {
                    console.error("AstManager initialization failed:", error);
                }
            });

        this.setupHandlers();
        this.server.onerror = (error) => console.error("[MCP Error]", error);

        this.sigintListener = async () => {
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
                ? '파일이 커서 기본 프로필과 read_fragment(lineRange)를 조합해 필요한 구간만 읽는 것이 안전합니다.'
                : '기본 프로필에 주요 정보가 담겨 있으니 정말 필요할 때만 full=true를 사용하세요.';
        const styleHint = `${(meta.newlineStyle || 'lf').toUpperCase()} newline / ${meta.usesTabs ? 'TAB' : `${meta.indentSize || 2}-space`} indent`;
        const readFragmentHint = `스켈레톤 라인 번호를 기준으로 read_fragment와 edit_file(lineRange + expectedHash)을 함께 사용하세요. (Style: ${styleHint})`;
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

    private setupHandlers(): void {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            return {
                tools: [
                    {
                        name: "read_file",
                        description: "Reads file content. By default, it returns a JSON Smart File Profile (metadata, skeleton, complexity metrics, impacted tests, guidance). Set 'full: true' strictly only when you need the entire raw content.",
                        inputSchema: {
                            type: "object",
                            properties: {
                                filePath: { type: "string" },
                                full: { type: "boolean", description: "If true, reads the entire raw content. Defaults to false (returns profile).", default: false }
                            },
                            required: ["filePath"]
                        }
                    },
                    {
                        name: "read_fragment",
                        description: "Smartly extracts relevant sections of a file based on keywords or line ranges.",
                        inputSchema: {
                            type: "object",
                            properties: {
                                filePath: { type: "string" },
                                keywords: { type: "array", items: { type: "string" } },
                                patterns: { type: "array", items: { type: "string" } },
                                contextLines: { type: "number", default: 0 },
                                lineRanges: { type: "array", items: { type: "object", properties: { start: { type: "number" }, end: { type: "number" } } } }
                            },
                            required: ["filePath"]
                        }
                    },
                    {
                        name: "read_file_skeleton",
                        description: "Reads the file and returns a skeleton view (signatures only) by folding function/method bodies. Useful for understanding code structure, with optional JSON output.",
                        inputSchema: {
                            type: "object",
                            properties: {
                                filePath: { type: "string" },
                                format: { type: "string", enum: ["text", "json"], default: "text" }
                            },
                            required: ["filePath"]
                        }
                    },
                    {
                        name: "search_symbol_definitions",
                        description: "Searches for symbol definitions (classes, functions, methods) across the project using AST parsing.",
                        inputSchema: {
                            type: "object",
                            properties: {
                                query: { type: "string" }
                            },
                            required: ["query"]
                        }
                    },
                    {
                        name: "get_file_dependencies",
                        description: "Analyzes direct file dependencies (imports/exports) based on AST.",
                        inputSchema: {
                            type: "object",
                            properties: {
                                filePath: { type: "string" },
                                direction: { type: "string", enum: ["incoming", "outgoing"], default: "outgoing" }
                            },
                            required: ["filePath"]
                        }
                    },
                    {
                        name: "analyze_impact",
                        description: "Analyzes transitive dependencies to assess the impact of changes to a file.",
                        inputSchema: {
                            type: "object",
                            properties: {
                                filePath: { type: "string" },
                                direction: { type: "string", enum: ["incoming", "outgoing"], default: "incoming" },
                                maxDepth: { type: "number", default: 20 }
                            },
                            required: ["filePath"]
                        }
                    },
                    {
                        name: "analyze_symbol_impact",
                        description: "Builds a symbol-level call graph to understand upstream/downstream impact chains.",
                        inputSchema: {
                            type: "object",
                            properties: {
                                symbolName: { type: "string" },
                                filePath: { type: "string" },
                                direction: { type: "string", enum: ["upstream", "downstream", "both"], default: "both" },
                                maxDepth: { type: "number", default: 3 }
                            },
                            required: ["symbolName", "filePath"]
                        }
                    },
                    {
                        name: "analyze_type_dependencies",
                        description: "Traces TypeScript class/interface/type-alias relationships (extends, implements, alias, constraints).",
                        inputSchema: {
                            type: "object",
                            properties: {
                                symbolName: { type: "string" },
                                filePath: { type: "string" },
                                direction: { type: "string", enum: ["incoming", "outgoing", "both"], default: "both" },
                                maxDepth: { type: "number", default: 2 }
                            },
                            required: ["symbolName", "filePath"]
                        }
                    },
                    {
                        name: "trace_data_flow",
                        description: "Traces how a variable moves through definitions, assignments, calls, and returns.",
                        inputSchema: {
                            type: "object",
                            properties: {
                                variableName: { type: "string" },
                                fromFile: { type: "string" },
                                fromLine: { type: "number" },
                                maxSteps: { type: "number", default: 10 }
                            },
                            required: ["variableName", "fromFile"]
                        }
                    },
                    {
                        name: "find_symbol_references",
                        description: "Finds all references (usages) of a symbol using AST-based static analysis.",
                        inputSchema: {
                            type: "object",
                            properties: {
                                symbolName: { type: "string" },
                                contextFile: { type: "string", description: "The file where the symbol is defined." }
                            },
                            required: ["symbolName", "contextFile"]
                        }
                    },
                    {
                        name: "preview_rename",
                        description: "Preview a rename operation across the project. Returns a diff of changes.",
                        inputSchema: {
                            type: "object",
                            properties: {
                                symbolName: { type: "string" },
                                newName: { type: "string" },
                                definitionFilePath: { type: "string" }
                            },
                            required: ["symbolName", "newName", "definitionFilePath"]
                                                }
                    },
                    {
                        name: "get_index_status",
                        description: "Retrieves the status of the project index, including file counts and unresolved dependencies.",
                        inputSchema: {
                            type: "object",
                            properties: {},
                        }
                    },
                    {
                        name: "rebuild_index",
                        description: "Forces a rebuild of the dependency graph and clears resolution caches.",
                        inputSchema: {
                            type: "object",
                            properties: {},
                        }
                    },
                    {
                        name: "invalidate_index_file",
                        description: "Invalidates cached symbol and dependency information for a single file.",
                        inputSchema: {
                            type: "object",
                            properties: {
                                filePath: { type: "string" }
                            },
                            required: ["filePath"]
                        }
                    },
                    {
                        name: "invalidate_index_directory",
                        description: "Invalidates cached index data for an entire directory (recursive).",
                        inputSchema: {
                            type: "object",
                            properties: {
                                directoryPath: { type: "string" }
                            },
                            required: ["directoryPath"]
                        }
                    },
                    {
                        name: "write_file",
                        description: "Creates a new file or overwrites an existing file completely.",
                        inputSchema: {
                            type: "object",
                            properties: {
                                filePath: { type: "string" },
                                content: { type: "string" }
                            },
                            required: ["filePath", "content"]
                        }
                    },
                    {
                        name: "edit_file",
                        description: "Applies multiple edits to a file safely using atomic transaction and conflict detection.",
                        inputSchema: {
                            type: "object",
                            properties: {
                                filePath: { type: "string" },
                                edits: {
                                    type: "array",
                                    items: {
                                        type: "object",
                                        properties: {
                                            targetString: { type: "string" },
                                            replacementString: { type: "string" },
                                            lineRange: { type: "object", properties: { start: { type: "number" }, end: { type: "number" } } },
                                            beforeContext: { type: "string" },
                                            afterContext: { type: "string" },
                                            fuzzyMode: { type: "string", enum: ["whitespace", "levenshtein"] },
                                            anchorSearchRange: { type: "object", properties: { lines: { type: "number" }, chars: { type: "number" } } }
                                        },
                                        required: ["targetString", "replacementString"]
                                    }
                                },
                                dryRun: { type: "boolean" }
                            },
                            required: ["filePath", "edits"]
                        }
                    },
                    {
                        name: "batch_edit",
                        description: "Applies edits to multiple files atomically (all or nothing).",
                        inputSchema: {
                            type: "object",
                            properties: {
                                fileEdits: {
                                    type: "array",
                                    items: {
                                        type: "object",
                                        properties: {
                                            filePath: { type: "string" },
                                            edits: {
                                                type: "array",
                                                items: {
                                                    type: "object",
                                                    properties: {
                                                        targetString: { type: "string" },
                                                        replacementString: { type: "string" },
                                                        lineRange: { type: "object", properties: { start: { type: "number" }, end: { type: "number" } } },
                                                        beforeContext: { type: "string" },
                                                        afterContext: { type: "string" },
                                                        fuzzyMode: { type: "string", enum: ["whitespace", "levenshtein"] },
                                                        anchorSearchRange: { type: "object", properties: { lines: { type: "number" }, chars: { type: "number" } } }
                                                    },
                                                    required: ["targetString", "replacementString"]
                                                }
                                            }
                                        },
                                        required: ["filePath", "edits"]
                                    }
                                },
                                dryRun: { type: "boolean" }
                            },
                            required: ["fileEdits"]
                        }
                    },
                    {
                        name: "debug_edit_match",
                        description: "Diagnose why an edit_file match failed.",
                        inputSchema: {
                            type: "object",
                            properties: {
                                filePath: { type: "string" },
                                targetString: { type: "string" },
                                lineRange: { type: "object", properties: { start: { type: "number" }, end: { type: "number" } } },
                                normalization: { type: "string", enum: ["exact", "whitespace", "structural"] }
                            },
                            required: ["filePath", "targetString"]
                        }
                    },
                    {
                        name: "undo_last_edit",
                        description: "Undoes the last successful edit_file operation using stored inverse edits.",
                        inputSchema: {
                            type: "object",
                            properties: {},
                        },
                    },
                    {
                        name: "redo_last_edit",
                        description: "Redoes the last undone edit_file operation using stored forward edits.",
                        inputSchema: {
                            type: "object",
                            properties: {},
                        },
                    },
                    {
                        name: "search_files",
                        description: "Searches for keywords or patterns across the project.",
                        inputSchema: {
                            type: "object",
                            properties: {
                                keywords: { type: "array", items: { type: "string" } },
                                patterns: { type: "array", items: { type: "string" } },
                                includeGlobs: { type: "array", items: { type: "string" } },
                                excludeGlobs: { type: "array", items: { type: "string" } }
                            }
                        }
                    },
                    {
                        name: "get_workflow_guidance",
                        description: "Retrieves the canonical agent playbook for interacting with the codebase.",
                        inputSchema: {
                            type: "object",
                            properties: {},
                        }
                    },
                    {
                        name: "list_directory",
                        description: "Lists directory contents in a tree-like structure, respecting common ignore files.",
                        inputSchema: {
                            type: "object",
                            properties: {
                                path: { type: "string" },
                                depth: { type: "number", default: 2 }
                            },
                            required: ["path"]
                        }
                    }
                ],
            };
        });

        this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
            return this.handleCallTool(request.params.name, request.params.arguments);
        });
    }

    private async handleCallTool(toolName: string, args: any): Promise<any> {
        try {
            switch (toolName) {
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
                    const status = await this.dependencyGraph.getIndexStatus();
                    return { content: [{ type: "text", text: JSON.stringify({ message: "Index rebuilt successfully", status }, null, 2) }] };
                }
                case "invalidate_index_file": {
                    const absPath = this._getAbsPathAndVerify(args.filePath);
                    await this.dependencyGraph.invalidateFile(absPath);
                    this.callGraphBuilder.invalidateFile(absPath);
                    this.typeDependencyTracker.invalidateFile(absPath);
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
