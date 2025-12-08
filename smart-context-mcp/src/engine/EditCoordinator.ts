// Context:
// EditorEngine (handles file I/O, diffs, backups, applyEdits)
// HistoryEngine (handles history.json, undo/redo stacks)
// EditCoordinator needs to coordinate these two.

import { EditorEngine } from "./Editor.js";
import { HistoryEngine } from "./History.js";
import { Edit, EditResult, EditOperation, BatchOperation, HistoryItem } from "../types.js";
import * as path from "path";
import * as crypto from "crypto";

export class EditCoordinator {
    private editorEngine: EditorEngine;
    private historyEngine: HistoryEngine;
    private rootPath?: string;

    /**
     * @param editorEngine EditorEngine instance (expects absolute file paths)
     * @param historyEngine HistoryEngine instance (stores filePath relative to root)
     * @param rootPath Optional project root path used to resolve relative paths from history
     */
    constructor(editorEngine: EditorEngine, historyEngine: HistoryEngine, rootPath?: string) {
        this.editorEngine = editorEngine;
        this.historyEngine = historyEngine;
        this.rootPath = rootPath;
    }

    /**
     * Apply edits to a file and, if not a dry run, record the operation in history.
     *
     * - Calls EditorEngine.applyEdits(filePath, edits, dryRun).
     * - If successful and not dryRun, pushes the returned operation (if any) to HistoryEngine.
     * - Returns the EditResult from EditorEngine.
     */
    public async applyEdits(filePath: string, edits: Edit[], dryRun: boolean = false): Promise<EditResult> {
        const result = await this.editorEngine.applyEdits(filePath, edits, dryRun);

        if (result.success && !dryRun && result.operation) {
            await this.historyEngine.pushOperation(result.operation as EditOperation);
        }

        return result;
    }

    /**
     * Apply a batch of edits across multiple files as a single logical operation.
     *
     * - If dryRun is true, verifies that all edits can be applied without writing or touching history.
     * - If dryRun is false, applies all edits and rolls back previously applied ones if any file fails.
     * - On full success, pushes a BatchOperation to history and returns a combined EditResult.
     */
    public async applyBatchEdits(
        fileEdits: { filePath: string; edits: Edit[] }[],
        dryRun: boolean = false
    ): Promise<EditResult> {
        if (fileEdits.length === 0) {
            return {
                success: true,
                message: "No edits to apply.",
            };
        }

        if (dryRun) {
            for (const { filePath, edits } of fileEdits) {
                const result = await this.editorEngine.applyEdits(filePath, edits, true);
                if (!result.success) {
                    return {
                        ...result,
                        success: false,
                        message: `Dry run failed for file ${filePath}: ${result.message ?? "Unknown error"}`,
                        errorCode: result.errorCode ?? "BatchDryRunFailed",
                    };
                }
            }

            return {
                success: true,
                message: `Dry run successful for ${fileEdits.length} file(s).`,
            };
        }

        const applied: { filePath: string; operation: EditOperation }[] = [];

        for (const { filePath, edits } of fileEdits) {
            const result = await this.editorEngine.applyEdits(filePath, edits, false);

            if (!result.success || !result.operation) {
                // Roll back all previously applied operations in reverse order.
                for (let i = applied.length - 1; i >= 0; i--) {
                    const entry = applied[i];
                    try {
                        await this.editorEngine.applyEdits(
                            entry.filePath,
                            entry.operation.inverseEdits,
                            false
                        );
                    } catch {
                        // Best-effort rollback; ignore individual rollback failures here.
                    }
                }

                return {
                    success: false,
                    message: `Batch edit failed for file ${filePath}: ${result.message ?? "Unknown error"}`,
                    errorCode: result.errorCode ?? "BatchApplyFailed",
                };
            }

            applied.push({ filePath, operation: result.operation as EditOperation });
        }

        const batchOperation: BatchOperation = {
            id:
                typeof crypto.randomUUID === "function"
                    ? crypto.randomUUID()
                    : `${Date.now()}-${Math.random()}`,
            timestamp: Date.now(),
            description: `Batch operation on ${applied.length} file(s).`,
            operations: applied.map((entry) => entry.operation),
        };

        await this.historyEngine.pushOperation(batchOperation as HistoryItem);

        return {
            success: true,
            message: `Successfully applied batch edits to ${applied.length} file(s).`,
        };
    }

    /**
     * Undo the last edit operation using the stored inverse edits.
     *
     * - Calls HistoryEngine.undo().
     * - If no operation is available, returns an error EditResult.
     * - If an operation exists, resolves its filePath (relative to root) back to an absolute path.
     * - Calls EditorEngine.applyEdits(resolvedPath, op.inverseEdits, false).
     * - Returns the EditResult from EditorEngine.
     */
    public async undo(): Promise<EditResult> {
        const item = (await this.historyEngine.undo()) as HistoryItem | null;

        if (!item) {
            return {
                success: false,
                message: "No undo history",
                errorCode: "NoUndoHistory",
            };
        }

        // BatchOperation: undo each contained EditOperation in reverse order.
        if ((item as BatchOperation).operations) {
            const batch = item as BatchOperation;

            for (let i = batch.operations.length - 1; i >= 0; i--) {
                const op = batch.operations[i];

                if (!op.filePath) {
                    return {
                        success: false,
                        message: "Cannot undo batch: a history entry is missing filePath.",
                        errorCode: "MissingFilePath",
                    };
                }

                const resolvedPath = this.resolveFilePath(op.filePath);
                const result = await this.editorEngine.applyEdits(
                    resolvedPath,
                    op.inverseEdits as Edit[],
                    false
                );

                if (!result.success) {
                    return {
                        success: false,
                        message: `Undo failed for batch operation on file ${resolvedPath}: ${
                            result.message ?? "Unknown error"
                        }`,
                        errorCode: result.errorCode ?? "UndoFailed",
                    };
                }
            }

            return {
                success: true,
                message: `Successfully undid batch operation affecting ${
                    (item as BatchOperation).operations.length
                } file(s).`,
            };
        }

        const op = item as EditOperation;

        if (!op.filePath) {
            return {
                success: false,
                message: "Cannot undo: history entry is missing filePath.",
                errorCode: "MissingFilePath",
            };
        }

        const resolvedPath = this.resolveFilePath(op.filePath);
        const result = await this.editorEngine.applyEdits(
            resolvedPath,
            op.inverseEdits as Edit[],
            false
        );

        if (!result.success && !result.errorCode) {
            result.errorCode = "UndoFailed";
        }

        return result;
    }

    /**
     * Redo the last undone edit operation using the stored forward edits.
     *
     * - Calls HistoryEngine.redo().
     * - If no operation is available, returns an error EditResult.
     * - If an operation exists, resolves its filePath (relative to root) back to an absolute path.
     * - Calls EditorEngine.applyEdits(resolvedPath, op.edits, false).
     * - Returns the EditResult from EditorEngine.
     */
    public async redo(): Promise<EditResult> {
        const item = (await this.historyEngine.redo()) as HistoryItem | null;

        if (!item) {
            return {
                success: false,
                message: "No redo history",
                errorCode: "NoRedoHistory",
            };
        }

        // BatchOperation: redo each contained EditOperation in original order.
        if ((item as BatchOperation).operations) {
            const batch = item as BatchOperation;

            for (const op of batch.operations) {
                if (!op.filePath) {
                    return {
                        success: false,
                        message: "Cannot redo batch: a history entry is missing filePath.",
                        errorCode: "MissingFilePath",
                    };
                }

                const resolvedPath = this.resolveFilePath(op.filePath);
                const result = await this.editorEngine.applyEdits(
                    resolvedPath,
                    op.edits as Edit[],
                    false
                );

                if (!result.success) {
                    return {
                        success: false,
                        message: `Redo failed for batch operation on file ${resolvedPath}: ${
                            result.message ?? "Unknown error"
                        }`,
                        errorCode: result.errorCode ?? "RedoFailed",
                    };
                }
            }

            return {
                success: true,
                message: `Successfully redid batch operation affecting ${
                    (item as BatchOperation).operations.length
                } file(s).`,
            };
        }

        const op = item as EditOperation;

        if (!op.filePath) {
            return {
                success: false,
                message: "Cannot redo: history entry is missing filePath.",
                errorCode: "MissingFilePath",
            };
        }

        const resolvedPath = this.resolveFilePath(op.filePath);
        const result = await this.editorEngine.applyEdits(resolvedPath, op.edits as Edit[], false);

        if (!result.success && !result.errorCode) {
            result.errorCode = "RedoFailed";
        }

        return result;
    }

    /**
     * Resolve a file path stored in history (typically relative to the project root)
     * back to an absolute path for EditorEngine.
     */
    private resolveFilePath(storedPath: string): string {
        if (path.isAbsolute(storedPath)) {
            return storedPath;
        }

        if (this.rootPath) {
            return path.join(this.rootPath, storedPath);
        }

        // Fallback: resolve relative to current working directory
        return path.resolve(storedPath);
    }
}
