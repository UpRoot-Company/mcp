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
    },
    {
        version: 5,
        name: "token_efficient_evidence_packs_v5",
        up: (db) => {
            db.exec(`
                CREATE TABLE IF NOT EXISTS evidence_packs (
                    pack_id TEXT PRIMARY KEY,
                    query TEXT NOT NULL,
                    options_json TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    expires_at INTEGER,
                    meta_json TEXT,
                    root_fingerprint TEXT NOT NULL
                );

                CREATE INDEX IF NOT EXISTS idx_evidence_packs_expires_at
                    ON evidence_packs(expires_at);

                CREATE TABLE IF NOT EXISTS evidence_pack_items (
                    pack_id TEXT NOT NULL,
                    role TEXT NOT NULL CHECK(role IN ('result','evidence')),
                    rank INTEGER NOT NULL,
                    chunk_id TEXT NOT NULL,
                    file_path TEXT NOT NULL,
                    kind TEXT NOT NULL,
                    section_path_json TEXT,
                    heading TEXT,
                    heading_level INTEGER,
                    start_line INTEGER,
                    end_line INTEGER,
                    preview TEXT NOT NULL,
                    content_hash_snapshot TEXT,
                    updated_at_snapshot INTEGER,
                    scores_json TEXT,
                    PRIMARY KEY(pack_id, role, rank),
                    FOREIGN KEY(pack_id) REFERENCES evidence_packs(pack_id) ON DELETE CASCADE
                );

                CREATE INDEX IF NOT EXISTS idx_evidence_pack_items_chunk
                    ON evidence_pack_items(chunk_id);
                CREATE INDEX IF NOT EXISTS idx_evidence_pack_items_file
                    ON evidence_pack_items(file_path);

                CREATE TABLE IF NOT EXISTS chunk_summaries (
                    chunk_id TEXT NOT NULL,
                    style TEXT NOT NULL,
                    summary TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    PRIMARY KEY(chunk_id, style)
                );

                CREATE TRIGGER IF NOT EXISTS evidence_packs_prune_expired
                AFTER INSERT ON evidence_packs
                BEGIN
                    DELETE FROM evidence_packs
                    WHERE expires_at IS NOT NULL
                      AND expires_at < (strftime('%s','now') * 1000);
                END;
            `);
            db.prepare(
                `INSERT OR REPLACE INTO metadata(key, value) VALUES ('schema_version', '5')`
            ).run();
        }
    },
    {
        version: 6,
        name: "chunk_summaries_content_hash_v6",
        up: (db) => {
            // Add content_hash to allow staleness detection for cached previews/summaries.
            const columns = db.prepare(`PRAGMA table_info(chunk_summaries)`).all() as Array<{ name: string }>;
            const hasContentHash = columns.some(c => c?.name === "content_hash");
            if (!hasContentHash) {
                db.exec(`ALTER TABLE chunk_summaries ADD COLUMN content_hash TEXT;`);
            }
            db.exec(`CREATE INDEX IF NOT EXISTS idx_chunk_summaries_hash ON chunk_summaries(content_hash);`);
            db.prepare(
                `INSERT OR REPLACE INTO metadata(key, value) VALUES ('schema_version', '6')`
            ).run();
        }
    }
];
