import { createLogger } from "../utils/StructuredLogger.js";
import { metrics } from "../utils/MetricsCollector.js";
import { IndexDatabase } from "../indexing/IndexDatabase.js";

export interface TransactionSnapshot {
    filePath: string;
    originalContent: string;
    originalHash: string;
    newContent?: string;
    newHash?: string;
}

export type TransactionStatus = "pending" | "committed" | "rolled_back";

export interface TransactionLogEntry {
    id: string;
    timestamp: number;
    status: TransactionStatus;
    description: string;
    snapshots: TransactionSnapshot[];
}

export class TransactionLog {
    private readonly logger = createLogger("TransactionLog");

    constructor(private readonly store: IndexDatabase) {}

    public begin(id: string, description: string, snapshots: TransactionSnapshot[]): void {
        const entry: TransactionLogEntry = {
            id,
            timestamp: Date.now(),
            status: "pending",
            description,
            snapshots
        };
        this.store.upsertPendingTransaction(entry);
        metrics.inc("transactions.begin");
        this.logger.info("Transaction begun", { transactionId: id, fileCount: snapshots.length });
    }

    public commit(id: string, snapshots: TransactionSnapshot[]): void {
        const pending = this.store.listPendingTransactions().find(entry => entry.id === id);
        const entry: TransactionLogEntry = {
            id,
            timestamp: pending?.timestamp ?? Date.now(),
            status: "committed",
            description: pending?.description ?? "committed",
            snapshots
        };
        this.store.markTransactionCommitted(id, entry);
        metrics.inc("transactions.commit");
        this.logger.info("Transaction committed", { transactionId: id, fileCount: snapshots.length });
    }

    public rollback(id: string): void {
        this.store.markTransactionRolledBack(id);
        metrics.inc("transactions.rollback");
        this.logger.warn("Transaction rolled back", { transactionId: id });
    }

    public getPendingTransactions(): TransactionLogEntry[] {
        const pending = this.store.listPendingTransactions();
        metrics.gauge("transactions.pending", pending.length);
        return pending;
    }
}
