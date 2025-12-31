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
    },
    {
        version: 4,
        name: "storage_v4_embeddings_composite_pk",
        up: (db) => {
            db.exec(`
                -- Improve doc chunk query performance for multi-kind corpora.
                CREATE INDEX IF NOT EXISTS idx_document_chunks_file_kind_line
                    ON document_chunks(file_id, kind, start_line);

                CREATE INDEX IF NOT EXISTS idx_document_chunks_hash
                    ON document_chunks(content_hash);

                -- Move embeddings to a composite primary key so a single chunk can store multiple embeddings.
                ALTER TABLE chunk_embeddings RENAME TO chunk_embeddings_v3;

                CREATE TABLE IF NOT EXISTS chunk_embeddings (
                    chunk_id TEXT NOT NULL,
                    provider TEXT NOT NULL,
                    model TEXT NOT NULL,
                    dims INTEGER NOT NULL,
                    vector_blob BLOB NOT NULL,
                    norm REAL,
                    created_at INTEGER NOT NULL,
                    PRIMARY KEY(chunk_id, provider, model),
                    FOREIGN KEY(chunk_id) REFERENCES document_chunks(id) ON DELETE CASCADE
                );

                CREATE INDEX IF NOT EXISTS idx_chunk_embeddings_model ON chunk_embeddings(provider, model);
                CREATE INDEX IF NOT EXISTS idx_chunk_embeddings_chunk ON chunk_embeddings(chunk_id);
                CREATE INDEX IF NOT EXISTS idx_chunk_embeddings_created_at ON chunk_embeddings(created_at);

                INSERT OR REPLACE INTO chunk_embeddings (chunk_id, provider, model, dims, vector_blob, norm, created_at)
                SELECT chunk_id, provider, model, dims, vector_blob, norm, created_at
                FROM chunk_embeddings_v3;

                DROP TABLE IF EXISTS chunk_embeddings_v3;
            `);
            db.prepare(
                `INSERT OR REPLACE INTO metadata(key, value) VALUES ('schema_version', '4')`
            ).run();
        }
    }
];
