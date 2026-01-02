import {
    createIndexStore,
    type IndexStore,
    type FileRecord,
    type StoredDependency,
    type StoredUnresolvedDependency,
    type StoredGhostSymbol,
    type StoredDocumentChunk,
    type StoredEmbedding,
    type EmbeddingKey,
    type TransactionLogEntry
} from "../storage/IndexStore.js";
import type { SymbolInfo } from "../types.js";
import { PathManager } from "../utils/PathManager.js";

export type {
    FileRecord,
    StoredDependency,
    StoredUnresolvedDependency,
    StoredGhostSymbol,
    StoredDocumentChunk,
    StoredEmbedding,
    EmbeddingKey,
    TransactionLogEntry
};

export class IndexDatabase implements IndexStore {
    private readonly store: IndexStore;
    public get mode() {
        return this.store.mode;
    }

    constructor(rootPath: string) {
        PathManager.setRoot(rootPath);
        this.store = createIndexStore(rootPath);
    }

    public getOrCreateFile(relativePath: string, lastModified?: number, language?: string | null): FileRecord {
        return this.store.getOrCreateFile(relativePath, lastModified, language);
    }

    public getFile(relativePath: string): FileRecord | undefined {
        return this.store.getFile(relativePath);
    }

    public listFiles(): FileRecord[] {
        return this.store.listFiles();
    }

    public deleteFile(relativePath: string): void {
        this.store.deleteFile(relativePath);
    }

    public deleteFilesByPrefix(prefix: string): void {
        this.store.deleteFilesByPrefix(prefix);
    }

    public replaceSymbols(args: { relativePath: string; lastModified: number; language?: string | null; symbols: SymbolInfo[] }): void {
        this.store.replaceSymbols(args);
    }

    public readSymbols(relativePath: string): SymbolInfo[] | undefined {
        return this.store.readSymbols(relativePath);
    }

    public streamAllSymbols(): Map<string, SymbolInfo[]> {
        return this.store.streamAllSymbols();
    }

    public searchSymbols(pattern: string, limit?: number): Array<{ path: string; data_json: string }> {
        return this.store.searchSymbols(pattern, limit);
    }

    public replaceDependencies(args: {
        relativePath: string;
        lastModified: number;
        outgoing: Array<{ targetPath?: string; type: string; weight?: number; metadata?: Record<string, unknown> }>;
        unresolved: StoredUnresolvedDependency[];
    }): void {
        this.store.replaceDependencies(args);
    }

    public getDependencies(relativePath: string, direction: "incoming" | "outgoing"): StoredDependency[] {
        return this.store.getDependencies(relativePath, direction);
    }

    public countDependencies(relativePath: string, direction: "incoming" | "outgoing"): number {
        return this.store.countDependencies(relativePath, direction);
    }

    public listUnresolved(): { filePath: string; specifier: string; error?: string; metadata?: Record<string, unknown> }[] {
        return this.store.listUnresolved();
    }

    public listUnresolvedForFile(relativePath: string): { specifier: string; error?: string; metadata?: Record<string, unknown> }[] {
        return this.store.listUnresolvedForFile(relativePath);
    }

    public clearDependencies(relativePath: string): void {
        this.store.clearDependencies(relativePath);
    }

    public addGhost(ghost: StoredGhostSymbol): void {
        this.store.addGhost(ghost);
    }

    public findGhost(name: string): StoredGhostSymbol | undefined {
        return this.store.findGhost(name);
    }

    public listGhosts(): StoredGhostSymbol[] {
        return this.store.listGhosts();
    }

    public deleteGhost(name: string): void {
        this.store.deleteGhost(name);
    }

    public pruneGhosts(olderThanMs: number): void {
        this.store.pruneGhosts(olderThanMs);
    }

    public upsertDocumentChunks(filePath: string, chunks: StoredDocumentChunk[]): void {
        this.store.upsertDocumentChunks(filePath, chunks);
    }

    public listDocumentChunks(filePath: string): StoredDocumentChunk[] {
        return this.store.listDocumentChunks(filePath);
    }

    public listDocumentFiles(limit?: number): string[] {
        return this.store.listDocumentFiles(limit);
    }

    public getChunkContentHash(chunkId: string): string | undefined {
        return this.store.getChunkContentHash(chunkId);
    }

    public deleteDocumentChunks(filePath: string): void {
        this.store.deleteDocumentChunks(filePath);
    }

    public upsertEmbedding(chunkId: string, key: EmbeddingKey, embedding: { dims: number; vector: Float32Array; norm?: number }): void {
        this.store.upsertEmbedding(chunkId, key, embedding);
    }

    public getEmbedding(chunkId: string, key: EmbeddingKey): StoredEmbedding | null {
        return this.store.getEmbedding(chunkId, key);
    }

    public deleteEmbedding(chunkId: string): void {
        this.store.deleteEmbedding(chunkId);
    }

    public deleteEmbeddingsForFile(filePath: string): void {
        this.store.deleteEmbeddingsForFile(filePath);
    }

    public upsertEvidencePack(packId: string, payload: unknown): void {
        this.store.upsertEvidencePack(packId, payload);
    }

    public getEvidencePack(packId: string): unknown | null {
        return this.store.getEvidencePack(packId);
    }

    public deleteEvidencePack(packId: string): void {
        this.store.deleteEvidencePack(packId);
    }

    public getChunkSummary(chunkId: string, style: "preview" | "summary"): { summary: string; contentHash?: string } | null {
        return this.store.getChunkSummary(chunkId, style);
    }

    public upsertChunkSummary(chunkId: string, style: "preview" | "summary", summary: string, contentHash?: string): void {
        this.store.upsertChunkSummary(chunkId, style, summary, contentHash);
    }

    public upsertPendingTransaction(entry: TransactionLogEntry): void {
        this.store.upsertPendingTransaction(entry);
    }

    public listPendingTransactions(): TransactionLogEntry[] {
        return this.store.listPendingTransactions();
    }

    public markTransactionCommitted(id: string, entry: TransactionLogEntry): void {
        this.store.markTransactionCommitted(id, entry);
    }

    public markTransactionRolledBack(id: string): void {
        this.store.markTransactionRolledBack(id);
    }

    public close(): void {
        this.store.close();
    }

    public dispose(): void {
        this.store.dispose();
    }
}
