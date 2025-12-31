import Database from "better-sqlite3";
import { IndexDatabase } from "./IndexDatabase.js";

export interface StoredEmbedding {
    chunkId: string;
    provider: string;
    model: string;
    dims: number;
    vector: Float32Array;
    norm?: number;
}

export class EmbeddingRepository {
    private readonly db: Database.Database;
    private readonly upsertStmt: Database.Statement;
    private readonly selectStmt: Database.Statement;
    private readonly deleteStmt: Database.Statement;
    private readonly deleteForFileStmt: Database.Statement;

    constructor(private readonly indexDb: IndexDatabase) {
        this.db = indexDb.getHandle();
        this.upsertStmt = this.db.prepare(`
            INSERT INTO chunk_embeddings (chunk_id, provider, model, dims, vector_blob, norm, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(chunk_id, provider, model) DO UPDATE SET
                dims = excluded.dims,
                vector_blob = excluded.vector_blob,
                norm = excluded.norm,
                created_at = excluded.created_at
        `);
        this.selectStmt = this.db.prepare(`
            SELECT provider, model, dims, vector_blob, norm
            FROM chunk_embeddings
            WHERE chunk_id = ? AND provider = ? AND model = ?
        `);
        this.deleteStmt = this.db.prepare(`DELETE FROM chunk_embeddings WHERE chunk_id = ?`);
        this.deleteForFileStmt = this.db.prepare(`
            DELETE FROM chunk_embeddings
            WHERE chunk_id IN (
                SELECT id FROM document_chunks WHERE file_id = ?
            )
        `);
    }

    public upsertEmbedding(chunkId: string, embedding: Omit<StoredEmbedding, "chunkId">): void {
        const blob = encodeVector(embedding.vector);
        this.upsertStmt.run(
            chunkId,
            embedding.provider,
            embedding.model,
            embedding.dims,
            blob,
            embedding.norm ?? null,
            Date.now()
        );
    }

    public getEmbedding(chunkId: string, provider: string, model: string): StoredEmbedding | null {
        const row = this.selectStmt.get(chunkId, provider, model) as
            | { provider: string; model: string; dims: number; vector_blob: Buffer; norm: number | null }
            | undefined;
        if (!row) return null;
        return {
            chunkId,
            provider: row.provider,
            model: row.model,
            dims: row.dims,
            vector: decodeVector(row.vector_blob),
            norm: row.norm ?? undefined
        };
    }

    public deleteEmbedding(chunkId: string): void {
        this.deleteStmt.run(chunkId);
    }

    public deleteEmbeddingsForFileId(fileId: number): void {
        this.deleteForFileStmt.run(fileId);
    }

    public deleteEmbeddingsForFile(filePath: string): void {
        const file = this.indexDb.getFile(filePath);
        if (!file) return;
        this.deleteEmbeddingsForFileId(file.id);
    }
}

function encodeVector(values: Float32Array): Buffer {
    return Buffer.from(new Uint8Array(values.buffer));
}

function decodeVector(buffer: Buffer): Float32Array {
    return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
}
