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
    },
    {
        version: 3,
        name: "document_chunks_and_embeddings",
        up: (db) => {
            db.exec(`
                CREATE TABLE IF NOT EXISTS document_chunks (
                    id TEXT PRIMARY KEY,
                    file_id INTEGER NOT NULL,
                    kind TEXT NOT NULL,
                    section_path_json TEXT NOT NULL,
                    heading TEXT,
                    heading_level INTEGER,
                    start_line INTEGER NOT NULL,
                    end_line INTEGER NOT NULL,
                    start_byte INTEGER NOT NULL,
                    end_byte INTEGER NOT NULL,
                    text TEXT NOT NULL,
                    content_hash TEXT NOT NULL,
                    updated_at INTEGER NOT NULL,
                    FOREIGN KEY(file_id) REFERENCES files(id) ON DELETE CASCADE
                );

                CREATE INDEX IF NOT EXISTS idx_document_chunks_file ON document_chunks(file_id);

                CREATE TABLE IF NOT EXISTS chunk_embeddings (
                    chunk_id TEXT PRIMARY KEY,
                    provider TEXT NOT NULL,
                    model TEXT NOT NULL,
                    dims INTEGER NOT NULL,
                    vector_blob BLOB NOT NULL,
                    norm REAL,
                    created_at INTEGER NOT NULL,
                    FOREIGN KEY(chunk_id) REFERENCES document_chunks(id) ON DELETE CASCADE
                );

                CREATE INDEX IF NOT EXISTS idx_chunk_embeddings_model ON chunk_embeddings(provider, model);
            `);
            db.prepare(
                `INSERT OR REPLACE INTO metadata(key, value) VALUES ('schema_version', '3')`
            ).run();
        }
    }
];
