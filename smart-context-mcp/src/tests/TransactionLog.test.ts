import { describe, it, expect } from "@jest/globals";
import Database from "better-sqlite3";
import { TransactionLog } from "../engine/TransactionLog.js";

describe("TransactionLog", () => {
    it("records pending transactions and clears on commit", () => {
        const db = new Database(":memory:");
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
    });

    it("clears pending transactions on rollback", () => {
        const db = new Database(":memory:");
        const log = new TransactionLog(db);
        const txId = "tx-2";
        const snapshots = [
            { filePath: "/b.txt", originalContent: "b", originalHash: "h2" }
        ];

        log.begin(txId, "test", snapshots);
        expect(log.getPendingTransactions()).toHaveLength(1);

        log.rollback(txId);
        expect(log.getPendingTransactions()).toHaveLength(0);
    });
});
