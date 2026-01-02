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
    constructor(private readonly indexDb: IndexDatabase) {
    }

    public upsertEmbedding(chunkId: string, embedding: Omit<StoredEmbedding, "chunkId">): void {
        this.indexDb.upsertEmbedding(
            chunkId,
            { provider: embedding.provider, model: embedding.model },
            { dims: embedding.dims, vector: embedding.vector, norm: embedding.norm }
        );
    }

    public getEmbedding(chunkId: string, provider: string, model: string): StoredEmbedding | null {
        return this.indexDb.getEmbedding(chunkId, { provider, model });
    }

    public deleteEmbedding(chunkId: string): void {
        this.indexDb.deleteEmbedding(chunkId);
    }

    public deleteEmbeddingsForFile(filePath: string): void {
        this.indexDb.deleteEmbeddingsForFile(filePath);
    }

    public listEmbeddings(provider: string, model: string, limit?: number): StoredEmbedding[] {
        return this.indexDb.listEmbeddings({ provider, model }, limit);
    }
}
