// Context:
// EditorEngine (handles file I/O, diffs, backups, applyEdits)
// HistoryEngine (handles history.json, undo/redo stacks)
// EditCoordinator needs to coordinate these two.

import * as crypto from "crypto";
import * as path from "path";
import { createRequire } from "module";
import { EditorEngine } from "./Editor.js";
import { HistoryEngine } from "./History.js";
import { ImpactAnalyzer } from "./ImpactAnalyzer.js";
import {
    Edit,
    EditResult,
    EditOperation,
    BatchOperation,
    HistoryItem,
    EditExecutionOptions,
    ImpactPreview
} from "../types.js";
import { IFileSystem } from "../platform/FileSystem.js";
import { TransactionLog, TransactionSnapshot } from "./TransactionLog.js";
import { metrics } from "../utils/MetricsCollector.js";

interface EditCoordinatorInitOptions {
    rootPath?: string;
    transactionLog: TransactionLog;
    fileSystem: IFileSystem;
    impactAnalyzer?: ImpactAnalyzer;
}

interface BatchFailure {
    message: string;
    errorCode?: string;
}

const require = createRequire(import.meta.url);
let importedXxhash: any = null;
try {
    importedXxhash = require("xxhashjs");
} catch {
    importedXxhash = null;
}
const XXH: any = importedXxhash ? (importedXxhash.default ?? importedXxhash) : null;

export class EditCoordinator {
    private editorEngine: EditorEngine;
    private historyEngine: HistoryEngine;
    private rootPath?: string;
    private readonly fileSystem?: IFileSystem;
    private readonly transactionLog?: TransactionLog;
    private readonly impactAnalyzer?: ImpactAnalyzer;

    /**
     * @param editorEngine EditorEngine instance (expects absolute file paths)
     * @param historyEngine HistoryEngine instance (stores filePath relative to root)
     * @param rootPathOrOptions Either the legacy root path string or an options object enabling transactions
     */
    constructor(
        editorEngine: EditorEngine,
        historyEngine: HistoryEngine,
        rootPathOrOptions?: string | EditCoordinatorInitOptions
    ) {
        this.editorEngine = editorEngine;
        this.historyEngine = historyEngine;
        if (typeof rootPathOrOptions === "string" || rootPathOrOptions === undefined) {
            this.rootPath = rootPathOrOptions;
        } else {
            this.rootPath = rootPathOrOptions.rootPath;
            this.transactionLog = rootPathOrOptions.transactionLog;
            this.fileSystem = rootPathOrOptions.fileSystem;
            this.impactAnalyzer = rootPathOrOptions.impactAnalyzer;
        }
    }

    public getTransactionLog(): TransactionLog | undefined {
        return this.transactionLog;
    }

    /**
     * Apply edits to a file and, if not a dry run, record the operation in history.
     *
     * - Calls EditorEngine.applyEdits(filePath, edits, dryRun).
     * - If successful and not dryRun, pushes the returned operation (if any) to HistoryEngine.
     * - Returns the EditResult from EditorEngine.
     */
    public async applyEdits(
        filePath: string,
        edits: Edit[],
        dryRun: boolean = false,
        options?: EditExecutionOptions
    ): Promise<EditResult> {
        const result = options?.diffMode
            ? await this.editorEngine.applyEdits(filePath, edits, dryRun, options)
            : await this.editorEngine.applyEdits(filePath, edits, dryRun);

        if (result.success && !dryRun && result.operation) {
            await this.historyEngine.pushOperation(result.operation as EditOperation);
        }

        if (result.success && dryRun && this.impactAnalyzer && !options?.skipImpactPreview) {
            result.impactPreview = await this.impactAnalyzer.analyzeImpact(filePath, edits);
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
        dryRun: boolean = false,
        options?: EditExecutionOptions
    ): Promise<EditResult> {
        const invokeApply = (targetPath: string, targetEdits: Edit[], isDryRun: boolean) => {
            if (options?.diffMode) {
                return this.editorEngine.applyEdits(targetPath, targetEdits, isDryRun, options);
            }
            return this.editorEngine.applyEdits(targetPath, targetEdits, isDryRun);
        };

        if (fileEdits.length === 0) {
            return { success: true, message: "No edits provided." };
        }

        if (dryRun) {
            for (const { filePath, edits } of fileEdits) {
                const result = await invokeApply(filePath, edits, true);
                if (!result.success) {
                    return {
                        ...result,
                        success: false,
                        message: `Dry run failed for file ${filePath}: ${result.message ?? "Unknown error"}`,
                        errorCode: result.errorCode ?? "BatchDryRunFailed",
                    };
                }
            }

            const impactPreviews: ImpactPreview[] = [];
            if (this.impactAnalyzer) {
                for (const { filePath, edits } of fileEdits) {
                    const preview = await this.impactAnalyzer.analyzeImpact(filePath, edits);
                    impactPreviews.push(preview);
                }
            }

            return {
                success: true,
                message: `Dry run successful for ${fileEdits.length} file(s).`,
                impactPreviews: impactPreviews.length > 0 ? impactPreviews : undefined
            };
        }

        if (!this.transactionLog || !this.fileSystem) {
            return this.applyBatchWithoutTransactions(fileEdits, invokeApply);
        }

        return this.applyBatchWithTransactions(fileEdits, invokeApply);
    }

    private async applyBatchWithoutTransactions(
        fileEdits: { filePath: string; edits: Edit[] }[],
        invokeApply: (filePath: string, edits: Edit[], dryRun: boolean) => Promise<EditResult>
    ): Promise<EditResult> {
        const applied: { filePath: string; operation: EditOperation }[] = [];

        for (const { filePath, edits } of fileEdits) {
            const result = await invokeApply(filePath, edits, false);

            if (!result.success || !result.operation) {
                // Rollback previously applied edits in this batch
                const errors = [`Failed to apply edits to ${filePath}: ${result.message ?? "Unknown error"}`];
                for (let i = applied.length - 1; i >= 0; i--) {
                    const entry = applied[i];
                    const rbResult = await invokeApply(entry.filePath, entry.operation.inverseEdits as Edit[], false);
                    if (!rbResult.success) {
                        errors.push(`Critical: Failed to rollback ${entry.filePath}: ${rbResult.message ?? "Unknown error"}`);
                    }
                }
                return {
                    success: false,
                    message: errors.join("\n"),
                    errorCode: result.errorCode ?? "BatchApplyFailed",
                };
            }

            applied.push({ filePath, operation: result.operation as EditOperation });
        }

        const batchOperation: BatchOperation = {
            id: this.generateTransactionId(),
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

    private async applyBatchWithTransactions(
        fileEdits: { filePath: string; edits: Edit[] }[],
        invokeApply: (filePath: string, edits: Edit[], dryRun: boolean) => Promise<EditResult>
    ): Promise<EditResult> {
        const transactionLog = this.transactionLog!;
        const fileSystem = this.fileSystem!;
        const transactionId = this.generateTransactionId();
        const description = `Batch operation on ${fileEdits.length} file(s).`;

        const snapshots: TransactionSnapshot[] = [];
        const snapshotMap = new Map<string, TransactionSnapshot>();

        for (const { filePath } of fileEdits) {
            const originalContent = await fileSystem.readFile(filePath);
            const snapshot: TransactionSnapshot = {
                filePath,
                originalContent,
                originalHash: this.computeHash(originalContent),
            };
            snapshots.push(snapshot);
            snapshotMap.set(filePath, snapshot);
        }

        transactionLog.begin(transactionId, description, snapshots);
        await this.historyEngine.pushOperation({
            id: transactionId,
            timestamp: Date.now(),
            description,
            operations: []
        } as BatchOperation);

        const operations: EditOperation[] = [];

        try {
            for (const { filePath, edits } of fileEdits) {
                const result = await invokeApply(filePath, edits, false);

                if (!result.success || !result.operation) {
                    throw this.buildBatchFailure(filePath, result);
                }

                operations.push(result.operation as EditOperation);

                const newContent = await fileSystem.readFile(filePath);
                const snapshot = snapshotMap.get(filePath);
                if (snapshot) {
                    snapshot.newContent = newContent;
                    snapshot.newHash = this.computeHash(newContent);
                }
            }

            const batchOperation: BatchOperation = {
                id: transactionId,
                timestamp: Date.now(),
                description,
                operations,
            };

            transactionLog.commit(transactionId, snapshots);
            await this.historyEngine.replaceOperation(transactionId, batchOperation as HistoryItem);

            return {
                success: true,
                message: `Successfully applied batch edits to ${operations.length} file(s).`,
            };
        } catch (error) {
            await this.restoreSnapshots(snapshots);
            transactionLog.rollback(transactionId);
            await this.historyEngine.removeOperation(transactionId);

            const failure = this.normalizeBatchFailure(error);
            return {
                success: false,
                message: failure.message,
                errorCode: failure.errorCode ?? "BatchApplyFailed",
            };
        }
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
                message: "No operation to undo.",
            };
        }

        // BatchOperation: undo each contained EditOperation in reverse order.
        if ((item as BatchOperation).operations) {
            const batch = item as BatchOperation;
            for (let i = batch.operations.length - 1; i >= 0; i--) {
                const op = batch.operations[i];
                const resolvedPath = this.resolveFilePath(op.filePath!);
                const result = await this.editorEngine.applyEdits(
                    resolvedPath,
                    op.inverseEdits as Edit[],
                    false
                );
                if (!result.success) {
                    return {
                        success: false,
                        message: `Failed to undo part of batch: ${result.message}`,
                    };
                }
            }
            return { success: true, message: "Successfully undid batch operation." };
        } else {
            const op = item as EditOperation;
            const resolvedPath = this.resolveFilePath(op.filePath!);
            const result = await this.editorEngine.applyEdits(
                resolvedPath,
                op.inverseEdits as Edit[],
                false
            );
            return result;
        }
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
                message: "No operation to redo.",
            };
        }

        // BatchOperation: redo each contained EditOperation in original order.
        if ((item as BatchOperation).operations) {
            const batch = item as BatchOperation;
            for (const op of batch.operations) {
                const resolvedPath = this.resolveFilePath(op.filePath!);
                const result = await this.editorEngine.applyEdits(
                    resolvedPath,
                    op.edits as Edit[],
                    false
                );
                if (!result.success) {
                    return {
                        success: false,
                        message: `Failed to redo part of batch: ${result.message}`,
                    };
                }
            }
            return { success: true, message: "Successfully redid batch operation." };
        } else {
            const op = item as EditOperation;
            const resolvedPath = this.resolveFilePath(op.filePath!);
            const result = await this.editorEngine.applyEdits(resolvedPath, op.edits as Edit[], false);
            return result;
        }
    }

    private computeHash(content: string): string {
        if (XXH) {
            return XXH.h64(0xABCD).update(content).digest().toString(16);
        }
        return crypto.createHash("sha256").update(content).digest("hex");
    }

    private generateTransactionId(): string {
        try {
            return crypto.randomUUID();
        } catch {
            return `tx-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
        }
    }

    private async restoreSnapshots(snapshots: TransactionSnapshot[]): Promise<void> {
        if (!this.fileSystem) {
            return;
        }

        for (const snapshot of snapshots) {
            try {
                await this.fileSystem.writeFile(snapshot.filePath, snapshot.originalContent);
                const restored = await this.fileSystem.readFile(snapshot.filePath);
                const restoredHash = this.computeHash(restored);
                if (restoredHash !== snapshot.originalHash) {
                    console.error(`[EditCoordinator] Hash mismatch after rollback for ${snapshot.filePath}`);
                    metrics.inc("transactions.hash_mismatch");
                }
            } catch (error) {
                console.error(`[EditCoordinator] Failed to restore ${snapshot.filePath}:`, error);
            }
        }
    }

    private buildBatchFailure(filePath: string, result: EditResult): BatchFailure {
        return {
            message: `Batch edit failed for file ${filePath}: ${result.message ?? "Unknown error"}`,
            errorCode: result.errorCode ?? "BatchApplyFailed",
        };
    }

    private normalizeBatchFailure(error: unknown): BatchFailure {
        if (error && typeof error === "object" && "message" in error) {
            const maybeFailure = error as BatchFailure & { message?: string };
            return {
                message: maybeFailure.message || "Unknown batch error",
                errorCode: maybeFailure.errorCode,
            };
        }
        return { message: String(error) };
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
