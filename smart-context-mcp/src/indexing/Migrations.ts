import Database from "better-sqlite3";

export interface Migration {
    version: number;
    name: string;
    up: (db: Database.Database) => void;
}

export const MIGRATIONS: Migration[] = [
    {
        version: 1,
        name: "initial_schema",
        up: (db) => {
            db.prepare(
                `INSERT OR IGNORE INTO metadata(key, value) VALUES ('schema_version', '1')`
            ).run();
        }
    },
    {
        version: 2,
        name: "transaction_log",
        up: (db) => {
            db.exec(`
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
            db.prepare(
                `INSERT OR REPLACE INTO metadata(key, value) VALUES ('schema_version', '2')`
            ).run();
        }
    }
];

