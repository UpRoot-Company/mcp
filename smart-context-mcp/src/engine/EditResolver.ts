// ADR-042-005: Phase A3 - EditResolver
import { IFileSystem } from "../platform/FileSystem.js";
import { EditorEngine, PlannedMatch } from "./Editor.js";
import { Edit, ResolvedEdit, ResolveError, ResolveResult, ResolveOptions } from "../types.js";
import { ConfigurationManager } from "../config/ConfigurationManager.js";
import * as path from "path";

export class EditResolver {
    private readonly fileSystem: IFileSystem;
    private readonly editor: EditorEngine;

    constructor(fileSystem: IFileSystem, editor: EditorEngine) {
        this.fileSystem = fileSystem;
        this.editor = editor;
    }

    /**
     * Resolves edits to indexRange-based ResolvedEdit or ResolveError
     * 
     * @param absPath Absolute file path
     * @param edits Array of Edit specifications
     * @param options Resolve options (timeout, allowAmbiguousAutoPick, etc.)
     * @returns ResolveResult with either resolvedEdits or errors
     */
    public async resolveAll(
        absPath: string,
        edits: Edit[],
        options?: ResolveOptions
    ): Promise<ResolveResult> {
        const startTime = Date.now();
        const timeoutMs = options?.timeoutMs ?? ConfigurationManager.getResolveTimeoutMs();
        const allowAmbiguousAutoPick = options?.allowAmbiguousAutoPick ?? ConfigurationManager.getAllowAmbiguousAutoPick();

        try {
            // 1. Check file exists
            if (!(await this.fileSystem.exists(absPath))) {
                return {
                    success: false,
                    errors: [{
                        filePath: absPath,
                        editIndex: 0,
                        errorCode: "NO_MATCH",
                        message: `File not found: ${absPath}`,
                        suggestion: {
                            tool: "read",
                            next: "Ensure the file path is correct"
                        }
                    }]
                };
            }

            // 2. Read file content
            const content = await this.fileSystem.readFile(absPath);
            const fileSize = Buffer.byteLength(content, 'utf-8');

            // 3. Resolve each edit
            const resolvedEdits: ResolvedEdit[] = [];
            const errors: ResolveError[] = [];

            for (let i = 0; i < edits.length; i++) {
                // Check timeout
                if (Date.now() - startTime > timeoutMs) {
                    errors.push({
                        filePath: absPath,
                        editIndex: i,
                        errorCode: "RESOLVE_TIMEOUT",
                        message: `Resolve exceeded ${timeoutMs}ms timeout`,
                        suggestion: {
                            tool: "change",
                            lineRange: edits[i].lineRange,
                            next: "Provide narrower lineRange or indexRange to avoid full-file scan"
                        }
                    });
                    continue;
                }

                const edit = edits[i];

                try {
                    // Apply cost guardrails for levenshtein
                    if (edit.fuzzyMode === "levenshtein" && !this.shouldAllowLevenshtein(fileSize, edit.targetString?.length ?? 0)) {
                        errors.push({
                            filePath: absPath,
                            editIndex: i,
                            errorCode: "NO_MATCH",
                            message: `Levenshtein disabled: file too large (${fileSize} bytes) or target too short (${edit.targetString?.length ?? 0} chars)`,
                            suggestion: {
                                tool: "change",
                                next: "Provide lineRange or use exact match instead of fuzzy"
                            }
                        });
                        continue;
                    }

                    // Plan the edit using Editor's planning API
                    const planned = this.editor.planEditsFromContent(
                        content,
                        [edit],
                        { allowAmbiguousAutoPick, timeoutMs: timeoutMs - (Date.now() - startTime) }
                    );

                    const plannedMatch = planned[0];

                    // Check for ambiguous match
                    if (plannedMatch.candidateCount > 1 && !allowAmbiguousAutoPick) {
                        const candidates = plannedMatch.allCandidates ?? [plannedMatch.match];
                        errors.push({
                            filePath: absPath,
                            editIndex: i,
                            errorCode: "AMBIGUOUS_MATCH",
                            message: `Found ${plannedMatch.candidateCount} matches for target string`,
                            suggestion: {
                                tool: "read",
                                lineRange: {
                                    start: candidates[0].lineNumber,
                                    end: candidates[0].lineNumber + 5
                                },
                                next: "Use read to view context, then provide lineRange or indexRange to disambiguate"
                            }
                        });
                        continue;
                    }

                    // Build ResolvedEdit
                    const match = plannedMatch.match;
                    const relPath = path.relative(process.cwd(), absPath).replace(/\\/g, '/');

                    resolvedEdits.push({
                        filePath: relPath,
                        indexRange: { start: match.start, end: match.end },
                        targetString: match.original,
                        replacementString: match.replacement,
                        diagnostics: {
                            resolvedBy: this.getResolveMethod(edit, match),
                            candidateCount: plannedMatch.candidateCount,
                            timingMs: Date.now() - startTime,
                            notes: plannedMatch.candidateCount > 1
                                ? [`Auto-selected from ${plannedMatch.candidateCount} candidates`]
                                : undefined
                        }
                    });

                } catch (error: any) {
                    errors.push({
                        filePath: absPath,
                        editIndex: i,
                        errorCode: error.name === "MatchNotFoundError" ? "NO_MATCH" : "INVALID_RANGE",
                        message: error.message || "Unknown error during resolution",
                        suggestion: {
                            tool: "read",
                            lineRange: edit.lineRange,
                            next: "Use read to inspect the file content"
                        }
                    });
                }
            }

            // 4. Return result
            if (errors.length > 0) {
                return {
                    success: false,
                    errors
                };
            }

            return {
                success: true,
                resolvedEdits
            };

        } catch (error: any) {
            return {
                success: false,
                errors: [{
                    filePath: absPath,
                    editIndex: 0,
                    errorCode: "NO_MATCH",
                    message: error.message || "Unknown error",
                    suggestion: {
                        next: "Check file path and edit specification"
                    }
                }]
            };
        }
    }

    /**
     * Determines if levenshtein should be allowed based on file size and target length
     */
    private shouldAllowLevenshtein(fileSize: number, targetLen: number): boolean {
        const minLen = ConfigurationManager.getMinLevenshteinTargetLen();
        const maxFileSize = ConfigurationManager.getMaxLevenshteinFileBytes();
        return targetLen >= minLen && fileSize <= maxFileSize;
    }

    /**
     * Determines how the edit was resolved (for diagnostics)
     */
    private getResolveMethod(edit: Edit, match: any): "indexRange" | "lineRange" | "context" | "ast" | "fuzzy" {
        if (edit.indexRange) return "indexRange";
        if (edit.lineRange && (edit.beforeContext || edit.afterContext)) return "context";
        if (edit.lineRange) return "lineRange";
        if (edit.fuzzyMode === "levenshtein" || edit.fuzzyMode === "whitespace") return "fuzzy";
        return "indexRange"; // default
    }
}
