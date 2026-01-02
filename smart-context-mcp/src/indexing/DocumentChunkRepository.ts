import { IndexDatabase, type StoredDocumentChunk } from "./IndexDatabase.js";

export type { StoredDocumentChunk };

export class DocumentChunkRepository {
    constructor(private readonly indexDb: IndexDatabase) {
    }

    public upsertChunksForFile(filePath: string, chunks: StoredDocumentChunk[]): void {
        if (!filePath) return;
        this.indexDb.getOrCreateFile(filePath);
        this.indexDb.upsertDocumentChunks(filePath, chunks);
    }

    public deleteChunksForFile(filePath: string): void {
        this.indexDb.deleteDocumentChunks(filePath);
    }

    public listChunksForFile(filePath: string): StoredDocumentChunk[] {
        return this.indexDb.listDocumentChunks(filePath);
    }

    public getContentHashByChunkId(chunkId: string): string | null {
        if (!chunkId) return null;
        const value = this.indexDb.getChunkContentHash(chunkId);
        return typeof value === "string" && value.length > 0 ? value : null;
    }

    public listDocumentFiles(limit: number = 500): string[] {
        return this.indexDb.listDocumentFiles(limit);
    }
}
