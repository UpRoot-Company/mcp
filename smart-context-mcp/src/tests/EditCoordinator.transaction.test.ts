import { jest, describe, it, expect, beforeEach } from "@jest/globals";
import Database from "better-sqlite3";
import { EditCoordinator } from "../engine/EditCoordinator.js";
import { TransactionLog } from "../engine/TransactionLog.js";
import { MemoryFileSystem } from "../platform/FileSystem.js";
import { Edit, EditOperation, EditResult } from "../types.js";

describe("EditCoordinator transactional batch edits", () => {
    const rootPath = "/project/root";
    let fileSystem: MemoryFileSystem;
    let editorEngine: any;
    let historyEngine: any;
    let transactionLog: TransactionLog;
    let coordinator: EditCoordinator;

    beforeEach(async () => {
        fileSystem = new MemoryFileSystem(rootPath);
        await fileSystem.writeFile("/project/root/a.txt", "hello a");
        await fileSystem.writeFile("/project/root/b.txt", "hello b");

        editorEngine = {
            applyEdits: jest.fn(async (filePath: string, edits: Edit[], dryRun: boolean): Promise<EditResult> => {
                if (dryRun) {
                    return { success: true };
                }
                if (filePath.endsWith("b.txt")) {
                    return { success: false, message: "boom" };
                }
                const content = await fileSystem.readFile(filePath);
                const next = content.replace(edits[0].targetString, edits[0].replacementString);
                await fileSystem.writeFile(filePath, next);
                const op: EditOperation = {
                    id: "op-a",
                    timestamp: Date.now(),
                    description: "edit a",
                    edits,
                    inverseEdits: [],
                    filePath: "a.txt"
                };
                return { success: true, operation: op };
            })
        };

        historyEngine = {
            pushOperation: jest.fn(),
            replaceOperation: jest.fn(),
            removeOperation: jest.fn()
        };

        const db = new Database(":memory:");
        transactionLog = new TransactionLog(db);

        coordinator = new EditCoordinator(editorEngine, historyEngine, {
            rootPath,
            transactionLog,
            fileSystem
        });
    });

    it("rolls back to snapshots when a later file fails", async () => {
        const fileEdits = [
            {
                filePath: "/project/root/a.txt",
                edits: [{ targetString: "hello", replacementString: "hi" }] as Edit[]
            },
            {
                filePath: "/project/root/b.txt",
                edits: [{ targetString: "hello", replacementString: "hi" }] as Edit[]
            }
        ];

        const result = await coordinator.applyBatchEdits(fileEdits, false);

        expect(result.success).toBe(false);
        expect(await fileSystem.readFile("/project/root/a.txt")).toBe("hello a");
        expect(await fileSystem.readFile("/project/root/b.txt")).toBe("hello b");
        expect(historyEngine.pushOperation).toHaveBeenCalledTimes(1);
        expect(historyEngine.removeOperation).toHaveBeenCalledTimes(1);
        expect(transactionLog.getPendingTransactions()).toHaveLength(0);
    });
});
