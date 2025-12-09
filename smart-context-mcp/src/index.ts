
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
import { FileSearchResult, ReadFragmentResult, EditResult, DirectoryTree, Edit } from "./types.js";

const readFileAsync = promisify(fs.readFile);
const writeFileAsync = promisify(fs.writeFile);
const statAsync = promisify(fs.stat);

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

        constructor(rootPath: string) {
        console.error("DEBUG: SmartContextServer constructor started");
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

        // Warm up AstManager with common languages (non-blocking)
        this.astManager.warmup().catch(error => {
            console.error("AstManager warmup failed:", error);
        });

        this.setupHandlers();
        this.server.onerror = (error) => console.error("[MCP Error]", error);

        process.on("SIGINT", async () => {
            await this.server.close();
            process.exit(0);
        });

        console.error("DEBUG: SmartContextServer constructor finished");
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

    private _createErrorResponse(code: string, message: string, suggestion?: string, details?: any): { isError: true; content: { type: "text"; text: string; }[] } {
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
                        description: "Reads file content. By default, it returns a 'Smart Profile' (metadata, skeleton, dependencies) to save context. Set 'full: true' strictly only when you need the entire raw content.",
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

                    const [stats, outgoingDeps, incomingRefs] = await Promise.all([
                        statAsync(absPath),
                        this.dependencyGraph.getDependencies(absPath, 'outgoing'),
                        this.dependencyGraph.getDependencies(absPath, 'incoming')
                    ]);

                    let skeleton = `// Skeleton generation failed or not applicable for this file type.`;
                    try {
                        skeleton = await this.skeletonGenerator.generateSkeleton(absPath, content);
                    } catch (error) {
                        console.error(`Skeleton generation failed for ${absPath}:`, error);
                        // Fallback to full content only if the file is small, otherwise show error message
                        if (content.length < 5000) { // arbitrary limit, can be tuned
                            skeleton = `// Skeleton generation failed. Displaying full content due to small file size.\n${content}`;
                        } else {
                            skeleton = `// Skeleton generation failed. File too large to display full content as fallback.`;
                        }
                    }

                    const relativePath = path.relative(this.rootPath, absPath) || path.basename(absPath);
                    const sizeKb = stats.size / 1024;
                    const lineCount = content.length === 0 ? 0 : (content.split(/\r?\n/).filter(line => line.trim() !== '')).length;
                    const extension = path.extname(absPath).replace(/^\./, '') || 'unknown';

                    const formatList = (items: string[]) => {
                        if (!items || items.length === 0) return 'None';
                        return items.join(', ');
                    };
                    const incomingFormatted = (() => {
                        if (!incomingRefs || incomingRefs.length === 0) return 'None';
                        const top = incomingRefs.slice(0, 5);
                        const remainder = incomingRefs.length - top.length;
                        const base = top.join(', ');
                        return remainder > 0 ? `${base}, and ${remainder} others` : base;
                    })();

                    const profile = [
                        'Metadata',
                        `- Path: ${relativePath}`,
                        `- Size: ${sizeKb.toFixed(2)} KB`,
                        `- Lines: ${lineCount}`,
                        `- Language: ${extension}`,
                        '',
                        'Relationships',
                        `- Imports: ${formatList(outgoingDeps || [])}`,
                        `- Used By: ${incomingFormatted}`,
                        '',
                        'Skeleton',
                        skeleton,
                        '',
                        'Hint',
                        'Use read_fragment for focused slices or call read_file with full=true for the raw document.'
                    ].join('\n');

                    return { content: [{ type: "text", text: profile }] };
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
                    
                    const result: EditResult = await this.editCoordinator.applyEdits(absPath, adaptedEdits as Edit[], args.dryRun);
                    
                    if (!result.success) {
                        const errorCode = result.errorCode || "EditFailed";
                        const details = result.details;
                        return this._createErrorResponse(errorCode as string, result.message || "Unknown error", result.suggestion, details);
                    }
                    // History is now handled by EditCoordinator
                    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
                }
                case "batch_edit": {
                    const fileEdits = args.fileEdits.map((fileEdit: any) => {
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
                    
                    const result: EditResult = await this.editCoordinator.applyBatchEdits(fileEdits, args.dryRun);

                     if (!result.success) {
                        const errorCode = result.errorCode || "BatchEditFailed";
                        const details = result.details;
                        return this._createErrorResponse(errorCode as string, result.message || "Unknown error", result.suggestion, details);
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
                case "list_directory": {
                    const absPath = this._getAbsPathAndVerify(args.path);
                    const tree: string = await this.contextEngine.listDirectoryTree(absPath, args.depth, this.rootPath);
                    return { content: [{ type: "text", text: tree }] };
                }
                case "undo_last_edit": {
                    const result: EditResult = await this.editCoordinator.undo();

                    if (!result.success) {
                        const errorCode = result.errorCode || "UndoFailed";
                        const details = result.details;
                        return this._createErrorResponse(errorCode as string, result.message || "Unknown error during undo operation", result.suggestion, details);
                    }

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

    public async run() {
        console.error("DEBUG: SmartContextServer run method started");
        const transport = new StdioServerTransport();
        await this.server.connect(transport);
        console.error("DEBUG: MCP Server connected to transport");
        console.error("Smart Context MCP Server running on stdio");
    }
}

if (import.meta.url === url.pathToFileURL(process.argv[1]).href) {
    const server = new SmartContextServer(process.cwd());
    server.run().catch(console.error);
}
