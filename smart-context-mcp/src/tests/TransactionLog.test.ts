import { describe, it, expect } from "@jest/globals";
import { TransactionLog } from "../engine/TransactionLog.js";
import { IndexDatabase } from "../indexing/IndexDatabase.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

describe("TransactionLog", () => {
    it("records pending transactions and clears on commit", () => {
        const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "smart-context-tx-"));
        const db = new IndexDatabase(rootDir);
        const log = new TransactionLog(db);
        const txId = "tx-1";
        const snapshots = [
            { filePath: "/a.txt", originalContent: "a", originalHash: "h1" }
        ];

        log.begin(txId, "test", snapshots);
        let pending = log.getPendingTransactions();
        expect(pending).toHaveLength(1);
        expect(pending[0].id).toBe(txId);
        expect(pending[0].snapshots[0].filePath).toBe("/a.txt");

        log.commit(txId, snapshots);
        pending = log.getPendingTransactions();
        expect(pending).toHaveLength(0);
        db.dispose();
        fs.rmSync(rootDir, { recursive: true, force: true });
    });

    it("clears pending transactions on rollback", () => {
        const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "smart-context-tx-"));
        const db = new IndexDatabase(rootDir);
        const log = new TransactionLog(db);
        const txId = "tx-2";
        const snapshots = [
            { filePath: "/b.txt", originalContent: "b", originalHash: "h2" }
        ];

        log.begin(txId, "test", snapshots);
        expect(log.getPendingTransactions()).toHaveLength(1);

        log.rollback(txId);
        expect(log.getPendingTransactions()).toHaveLength(0);
        db.dispose();
        fs.rmSync(rootDir, { recursive: true, force: true });
    });
});
