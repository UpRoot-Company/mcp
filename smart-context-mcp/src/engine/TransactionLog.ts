import Database from "better-sqlite3";
import { createLogger } from "../utils/StructuredLogger.js";
import { metrics } from "../utils/MetricsCollector.js";

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
    private readonly db: Database.Database;
    private readonly logger = createLogger("TransactionLog");

    constructor(db: Database.Database) {
        this.db = db;
        this.ensureSchema();
    }

    private ensureSchema(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS transaction_log (
                id TEXT PRIMARY KEY,
                timestamp INTEGER NOT NULL,
                status TEXT NOT NULL CHECK(status IN ('pending','committed','rolled_back')),
                description TEXT,
                snapshots_json TEXT NOT NULL
            );

            CREATE INDEX IF NOT EXISTS idx_transaction_log_status_timestamp
                ON transaction_log(status, timestamp DESC);

            CREATE TRIGGER IF NOT EXISTS transaction_log_prune
            AFTER INSERT ON transaction_log
            BEGIN
                DELETE FROM transaction_log
                WHERE status IN ('committed','rolled_back')
                  AND timestamp < (strftime('%s','now') - 604800) * 1000;
            END;
        `);
    }

    public begin(id: string, description: string, snapshots: TransactionSnapshot[]): void {
        const payload = JSON.stringify(snapshots);
        this.db.prepare(`
            INSERT OR REPLACE INTO transaction_log (id, timestamp, status, description, snapshots_json)
            VALUES (?, ?, 'pending', ?, ?)
        `).run(id, Date.now(), description, payload);
        metrics.inc("transactions.begin");
        this.logger.info("Transaction begun", { transactionId: id, fileCount: snapshots.length });
    }

    public commit(id: string, snapshots: TransactionSnapshot[]): void {
        const payload = JSON.stringify(snapshots);
        this.db.prepare(`
            UPDATE transaction_log
            SET status = 'committed', snapshots_json = ?
            WHERE id = ?
        `).run(payload, id);
        metrics.inc("transactions.commit");
        this.logger.info("Transaction committed", { transactionId: id, fileCount: snapshots.length });
    }

    public rollback(id: string): void {
        this.db.prepare(`
            UPDATE transaction_log
            SET status = 'rolled_back'
            WHERE id = ?
        `).run(id);
        metrics.inc("transactions.rollback");
        this.logger.warn("Transaction rolled back", { transactionId: id });
    }

    public getPendingTransactions(): TransactionLogEntry[] {
        const rows = this.db.prepare(`
            SELECT id, timestamp, status, description, snapshots_json
            FROM transaction_log
            WHERE status = 'pending'
            ORDER BY timestamp ASC
        `).all();
        metrics.gauge("transactions.pending", rows.length);

        return rows.map((row: any) => ({
            id: row.id,
            timestamp: row.timestamp,
            status: row.status,
            description: row.description,
            snapshots: JSON.parse(row.snapshots_json)
        }));
    }
}
