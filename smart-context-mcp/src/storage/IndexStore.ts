import * as fs from "fs";
import * as path from "path";
import { PathManager } from "../utils/PathManager.js";
import type { DocumentKind, SymbolInfo } from "../types.js";
import { EmbeddingPackManager, resolveEmbeddingPackConfigFromEnv, type EmbeddingPackConfig } from "./EmbeddingPack.js";

export type StorageMode = "memory" | "file";

export interface FileRecord {
    path: string;
    last_modified: number;
    language?: string | null;
    size_bytes?: number;
    content_hash?: string;
}

export interface StoredDependency {
    source: string;
    target: string;
    type: string;
    weight: number;
    metadata?: Record<string, unknown>;
}

export interface StoredUnresolvedDependency {
    specifier: string;
    error?: string;
    metadata?: Record<string, unknown>;
}

export interface StoredGhostSymbol {
    name: string;
    lastSeenPath: string;
    type: string;
    lastKnownSignature?: string | null;
    deletedAt: number;
}

export interface StoredDocumentChunk {
    id: string;
    filePath: string;
    kind: DocumentKind;
    sectionPath: string[];
    heading: string | null;
    headingLevel: number | null;
    range: { startLine: number; endLine: number; startByte: number; endByte: number };
    text: string;
    contentHash: string;
    updatedAt: number;
}

export interface StoredEmbedding {
    chunkId: string;
    provider: string;
    model: string;
    dims: number;
    vector: Float32Array;
    norm?: number;
}

export type EmbeddingKey = { provider: string; model: string };

export interface TransactionLogEntry {
    id: string;
    timestamp: number;
    status: "pending" | "committed" | "rolled_back";
    description: string;
    snapshots: Array<{
        filePath: string;
        originalContent: string;
        originalHash: string;
        newContent?: string;
        newHash?: string;
    }>;
}

export interface IndexStore {
    mode: StorageMode;

    getOrCreateFile(relativePath: string, lastModified?: number, language?: string | null): FileRecord;
    getFile(relativePath: string): FileRecord | undefined;
    listFiles(): FileRecord[];
    deleteFile(relativePath: string): void;
    deleteFilesByPrefix(prefix: string): void;

    replaceSymbols(args: { relativePath: string; lastModified: number; language?: string | null; symbols: SymbolInfo[] }): void;
    readSymbols(relativePath: string): SymbolInfo[] | undefined;
    streamAllSymbols(): Map<string, SymbolInfo[]>;
    searchSymbols(pattern: string, limit?: number): Array<{ path: string; data_json: string }>;

    replaceDependencies(args: {
        relativePath: string;
        lastModified: number;
        outgoing: Array<{ targetPath?: string; type: string; weight?: number; metadata?: Record<string, unknown> }>;
        unresolved: StoredUnresolvedDependency[];
    }): void;
    getDependencies(relativePath: string, direction: "incoming" | "outgoing"): StoredDependency[];
    countDependencies(relativePath: string, direction: "incoming" | "outgoing"): number;
    listUnresolved(): { filePath: string; specifier: string; error?: string; metadata?: Record<string, unknown> }[];
    listUnresolvedForFile(relativePath: string): { specifier: string; error?: string; metadata?: Record<string, unknown> }[];
    clearDependencies(relativePath: string): void;

    addGhost(ghost: StoredGhostSymbol): void;
    findGhost(name: string): StoredGhostSymbol | undefined;
    listGhosts(): StoredGhostSymbol[];
    deleteGhost(name: string): void;
    pruneGhosts(olderThanMs: number): void;

    upsertDocumentChunks(filePath: string, chunks: StoredDocumentChunk[]): void;
    listDocumentChunks(filePath: string): StoredDocumentChunk[];
    listDocumentFiles(limit?: number): string[];
    getChunkContentHash(chunkId: string): string | undefined;
    getDocumentChunk(chunkId: string): StoredDocumentChunk | null;
    deleteDocumentChunks(filePath: string): void;

    upsertEmbedding(chunkId: string, key: EmbeddingKey, embedding: { dims: number; vector: Float32Array; norm?: number }): void;
    getEmbedding(chunkId: string, key: EmbeddingKey): StoredEmbedding | null;
    deleteEmbedding(chunkId: string): void;
    deleteEmbeddingsForFile(filePath: string): void;
    listEmbeddings(key: EmbeddingKey, limit?: number): StoredEmbedding[];
    iterateEmbeddings(key: EmbeddingKey, visitor: (embedding: StoredEmbedding) => void, options?: { limit?: number }): void;

    upsertEvidencePack(packId: string, payload: unknown): void;
    getEvidencePack(packId: string): unknown | null;
    deleteEvidencePack(packId: string): void;

    getChunkSummary(chunkId: string, style: "preview" | "summary"): { summary: string; contentHash?: string } | null;
    upsertChunkSummary(chunkId: string, style: "preview" | "summary", summary: string, contentHash?: string): void;

    upsertPendingTransaction(entry: TransactionLogEntry): void;
    listPendingTransactions(): TransactionLogEntry[];
    markTransactionCommitted(id: string, entry: TransactionLogEntry): void;
    markTransactionRolledBack(id: string): void;

    close(): void;
    dispose(): void;
}

type DependencySnapshot = { outgoing: StoredDependency[]; unresolved: StoredUnresolvedDependency[] };

export class MemoryIndexStore implements IndexStore {
    public readonly mode: StorageMode;
    protected readonly rootPath: string;

    protected readonly files = new Map<string, FileRecord>();
    protected readonly symbols = new Map<string, SymbolInfo[]>();
    protected readonly dependencies = new Map<string, DependencySnapshot>();
    protected readonly ghosts = new Map<string, StoredGhostSymbol>();
    protected readonly documentChunks = new Map<string, StoredDocumentChunk[]>();
    protected readonly chunkIndex = new Map<string, { filePath: string; contentHash: string }>();
    protected readonly embeddings = new Map<string, Map<string, StoredEmbedding>>();
    protected readonly evidencePacks = new Map<string, unknown>();
    protected readonly chunkSummaries = new Map<string, Map<string, { summary: string; contentHash?: string }>>();
    protected readonly transactions = new Map<string, TransactionLogEntry>();

    constructor(rootPath: string, mode: StorageMode = "memory") {
        this.rootPath = path.resolve(rootPath);
        this.mode = mode;
    }

    public getOrCreateFile(relativePath: string, lastModified?: number, language?: string | null): FileRecord {
        const normalized = this.normalize(relativePath);
        const existing = this.files.get(normalized);
        if (existing) {
            if (lastModified !== undefined) {
                existing.last_modified = lastModified;
            }
            if (language !== undefined) {
                existing.language = language ?? null;
            }
            return { ...existing };
        }
        const record: FileRecord = {
            path: normalized,
            last_modified: lastModified ?? 0,
            language: language ?? null
        };
        this.files.set(normalized, record);
        return { ...record };
    }

    public getFile(relativePath: string): FileRecord | undefined {
        const normalized = this.normalize(relativePath);
        const record = this.files.get(normalized);
        return record ? { ...record } : undefined;
    }

    public listFiles(): FileRecord[] {
        return Array.from(this.files.values()).map(record => ({ ...record }));
    }

    public deleteFile(relativePath: string): void {
        const normalized = this.normalize(relativePath);
        this.files.delete(normalized);
        this.symbols.delete(normalized);
        this.dependencies.delete(normalized);
        this.deleteEmbeddingsForFile(normalized);
        this.deleteDocumentChunks(normalized);
        this.cleanupIncomingDependencies(normalized);
    }

    public deleteFilesByPrefix(prefix: string): void {
        const normalizedPrefix = this.normalize(prefix);
        for (const key of Array.from(this.files.keys())) {
            if (key === normalizedPrefix || key.startsWith(`${normalizedPrefix}/`)) {
                this.deleteFile(key);
            }
        }
    }

    public replaceSymbols(args: { relativePath: string; lastModified: number; language?: string | null; symbols: SymbolInfo[] }): void {
        const normalized = this.normalize(args.relativePath);
        this.getOrCreateFile(normalized, args.lastModified, args.language);
        this.symbols.set(normalized, [...(args.symbols ?? [])]);
    }

    public readSymbols(relativePath: string): SymbolInfo[] | undefined {
        const normalized = this.normalize(relativePath);
        const stored = this.symbols.get(normalized);
        return stored ? stored.map(symbol => ({ ...symbol })) : undefined;
    }

    public streamAllSymbols(): Map<string, SymbolInfo[]> {
        const map = new Map<string, SymbolInfo[]>();
        for (const [key, symbols] of this.symbols.entries()) {
            map.set(key, symbols.map(symbol => ({ ...symbol })));
        }
        return map;
    }

    public searchSymbols(pattern: string, limit: number = 100): Array<{ path: string; data_json: string }> {
        const query = normalizeLikePattern(pattern);
        const results: Array<{ path: string; data_json: string }> = [];
        if (!query) return results;
        for (const [filePath, symbols] of this.symbols.entries()) {
            for (const symbol of symbols) {
                if (!symbol?.name) continue;
                if (!symbol.name.toLowerCase().includes(query)) continue;
                results.push({ path: filePath, data_json: JSON.stringify(symbol) });
                if (results.length >= limit) {
                    return results;
                }
            }
        }
        return results;
    }

    public replaceDependencies(args: {
        relativePath: string;
        lastModified: number;
        outgoing: Array<{ targetPath?: string; type: string; weight?: number; metadata?: Record<string, unknown> }>;
        unresolved: StoredUnresolvedDependency[];
    }): void {
        const normalized = this.normalize(args.relativePath);
        this.getOrCreateFile(normalized, args.lastModified);
        const outgoing: StoredDependency[] = [];
        for (const dep of args.outgoing) {
            if (!dep.targetPath) continue;
            outgoing.push({
                source: normalized,
                target: this.normalize(dep.targetPath),
                type: dep.type,
                weight: dep.weight ?? 1,
                metadata: dep.metadata
            });
        }
        this.dependencies.set(normalized, {
            outgoing,
            unresolved: args.unresolved ?? []
        });
    }

    public getDependencies(relativePath: string, direction: "incoming" | "outgoing"): StoredDependency[] {
        const normalized = this.normalize(relativePath);
        if (direction === "outgoing") {
            return (this.dependencies.get(normalized)?.outgoing ?? []).map(dep => ({ ...dep }));
        }
        const incoming: StoredDependency[] = [];
        for (const [source, snapshot] of this.dependencies.entries()) {
            for (const dep of snapshot.outgoing) {
                if (dep.target === normalized) {
                    incoming.push({ ...dep, source });
                }
            }
        }
        return incoming;
    }

    public countDependencies(relativePath: string, direction: "incoming" | "outgoing"): number {
        return this.getDependencies(relativePath, direction).length;
    }

    public listUnresolved(): { filePath: string; specifier: string; error?: string; metadata?: Record<string, unknown> }[] {
        const unresolved: { filePath: string; specifier: string; error?: string; metadata?: Record<string, unknown> }[] = [];
        for (const [filePath, snapshot] of this.dependencies.entries()) {
            for (const entry of snapshot.unresolved ?? []) {
                unresolved.push({
                    filePath,
                    specifier: entry.specifier,
                    error: entry.error,
                    metadata: entry.metadata
                });
            }
        }
        return unresolved;
    }

    public listUnresolvedForFile(relativePath: string): { specifier: string; error?: string; metadata?: Record<string, unknown> }[] {
        const normalized = this.normalize(relativePath);
        const entries = this.dependencies.get(normalized)?.unresolved ?? [];
        return entries.map(entry => ({
            specifier: entry.specifier,
            error: entry.error,
            metadata: entry.metadata
        }));
    }

    public clearDependencies(relativePath: string): void {
        const normalized = this.normalize(relativePath);
        const snapshot = this.dependencies.get(normalized);
        if (snapshot) {
            this.dependencies.set(normalized, { outgoing: [], unresolved: [] });
        }
    }

    public addGhost(ghost: StoredGhostSymbol): void {
        this.ghosts.set(ghost.name, { ...ghost });
    }

    public findGhost(name: string): StoredGhostSymbol | undefined {
        const ghost = this.ghosts.get(name);
        return ghost ? { ...ghost } : undefined;
    }

    public listGhosts(): StoredGhostSymbol[] {
        return Array.from(this.ghosts.values()).map(ghost => ({ ...ghost }));
    }

    public deleteGhost(name: string): void {
        this.ghosts.delete(name);
    }

    public pruneGhosts(olderThanMs: number): void {
        const cutoff = Date.now() - olderThanMs;
        for (const [name, ghost] of this.ghosts.entries()) {
            if (ghost.deletedAt < cutoff) {
                this.ghosts.delete(name);
            }
        }
    }

    public upsertDocumentChunks(filePath: string, chunks: StoredDocumentChunk[]): void {
        const normalized = this.normalize(filePath);
        const copy = chunks.map(chunk => ({ ...chunk, filePath: normalized }));
        const previous = this.documentChunks.get(normalized) ?? [];
        for (const chunk of previous) {
            this.chunkIndex.delete(chunk.id);
        }
        this.documentChunks.set(normalized, copy);
        for (const chunk of copy) {
            this.chunkIndex.set(chunk.id, { filePath: normalized, contentHash: chunk.contentHash });
        }
    }

    public listDocumentChunks(filePath: string): StoredDocumentChunk[] {
        const normalized = this.normalize(filePath);
        const chunks = this.documentChunks.get(normalized) ?? [];
        return chunks
            .slice()
            .sort((a, b) => a.range.startLine - b.range.startLine)
            .map(chunk => ({ ...chunk, sectionPath: [...(chunk.sectionPath ?? [])] }));
    }

    public listDocumentFiles(limit: number = 500): string[] {
        const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 500;
        return Array.from(this.documentChunks.keys()).sort().slice(0, safeLimit);
    }

    public getChunkContentHash(chunkId: string): string | undefined {
        return this.chunkIndex.get(chunkId)?.contentHash;
    }

    public getDocumentChunk(chunkId: string): StoredDocumentChunk | null {
        const meta = this.chunkIndex.get(chunkId);
        if (!meta) return null;
        const chunks = this.documentChunks.get(meta.filePath) ?? [];
        const found = chunks.find(chunk => chunk.id === chunkId);
        return found ? { ...found, sectionPath: [...(found.sectionPath ?? [])] } : null;
    }

    public deleteDocumentChunks(filePath: string): void {
        const normalized = this.normalize(filePath);
        const chunks = this.documentChunks.get(normalized) ?? [];
        for (const chunk of chunks) {
            this.chunkIndex.delete(chunk.id);
        }
        this.documentChunks.delete(normalized);
    }

    public upsertEmbedding(chunkId: string, key: EmbeddingKey, embedding: { dims: number; vector: Float32Array; norm?: number }): void {
        const mapKey = embeddingKey(key);
        const entry: StoredEmbedding = {
            chunkId,
            provider: key.provider,
            model: key.model,
            dims: embedding.dims,
            vector: embedding.vector,
            norm: embedding.norm
        };
        if (!this.embeddings.has(chunkId)) {
            this.embeddings.set(chunkId, new Map());
        }
        this.embeddings.get(chunkId)!.set(mapKey, entry);
    }

    public getEmbedding(chunkId: string, key: EmbeddingKey): StoredEmbedding | null {
        const mapKey = embeddingKey(key);
        const entry = this.embeddings.get(chunkId)?.get(mapKey);
        if (!entry) return null;
        return {
            ...entry,
            vector: new Float32Array(entry.vector)
        };
    }

    public deleteEmbedding(chunkId: string): void {
        this.embeddings.delete(chunkId);
    }

    public deleteEmbeddingsForFile(filePath: string): void {
        const normalized = this.normalize(filePath);
        for (const [chunkId, meta] of this.chunkIndex.entries()) {
            if (meta.filePath === normalized) {
                this.embeddings.delete(chunkId);
            }
        }
    }

    public listEmbeddings(key: EmbeddingKey, limit?: number): StoredEmbedding[] {
        const mapKey = embeddingKey(key);
        const max = Number.isFinite(limit) && (limit as number) > 0 ? Math.floor(limit as number) : undefined;
        const results: StoredEmbedding[] = [];
        for (const [chunkId, variants] of this.embeddings.entries()) {
            const entry = variants.get(mapKey);
            if (!entry) continue;
            results.push({
                ...entry,
                vector: new Float32Array(entry.vector)
            });
            if (max && results.length >= max) break;
        }
        return results;
    }

    public iterateEmbeddings(key: EmbeddingKey, visitor: (embedding: StoredEmbedding) => void, options?: { limit?: number }): void {
        const mapKey = embeddingKey(key);
        const max = Number.isFinite(options?.limit) && (options?.limit as number) > 0 ? Math.floor(options?.limit as number) : undefined;
        let count = 0;
        for (const variants of this.embeddings.values()) {
            const entry = variants.get(mapKey);
            if (!entry) continue;
            visitor({
                ...entry,
                vector: new Float32Array(entry.vector)
            });
            count++;
            if (max && count >= max) break;
        }
    }

    public upsertEvidencePack(packId: string, payload: unknown): void {
        this.evidencePacks.set(packId, payload);
    }

    public getEvidencePack(packId: string): unknown | null {
        return this.evidencePacks.get(packId) ?? null;
    }

    public deleteEvidencePack(packId: string): void {
        this.evidencePacks.delete(packId);
    }

    public getChunkSummary(chunkId: string, style: "preview" | "summary"): { summary: string; contentHash?: string } | null {
        const entry = this.chunkSummaries.get(chunkId)?.get(style);
        if (!entry) return null;
        return { ...entry };
    }

    public upsertChunkSummary(chunkId: string, style: "preview" | "summary", summary: string, contentHash?: string): void {
        if (!this.chunkSummaries.has(chunkId)) {
            this.chunkSummaries.set(chunkId, new Map());
        }
        this.chunkSummaries.get(chunkId)!.set(style, { summary, contentHash });
    }

    public upsertPendingTransaction(entry: TransactionLogEntry): void {
        this.transactions.set(entry.id, { ...entry });
    }

    public listPendingTransactions(): TransactionLogEntry[] {
        const entries: TransactionLogEntry[] = [];
        for (const entry of this.transactions.values()) {
            if (entry.status === "pending") {
                entries.push({ ...entry, snapshots: entry.snapshots.map(snapshot => ({ ...snapshot })) });
            }
        }
        return entries.sort((a, b) => a.timestamp - b.timestamp);
    }

    public markTransactionCommitted(id: string, entry: TransactionLogEntry): void {
        this.transactions.set(id, { ...entry, status: "committed" });
    }

    public markTransactionRolledBack(id: string): void {
        const entry = this.transactions.get(id);
        if (!entry) return;
        this.transactions.set(id, { ...entry, status: "rolled_back" });
    }

    public close(): void {}

    public dispose(): void {}

    protected normalize(relPath: string): string {
        let normalized = relPath.replace(/\\/g, "/");
        const resolvedRoot = path.resolve(this.rootPath).replace(/\\/g, "/");
        const realRoot = fs.existsSync(this.rootPath)
            ? fs.realpathSync(this.rootPath).replace(/\\/g, "/")
            : resolvedRoot;

        const absoluteInput = path.isAbsolute(normalized)
            ? normalized
            : path.resolve(this.rootPath, normalized).replace(/\\/g, "/");

        if (absoluteInput.startsWith(realRoot)) {
            normalized = absoluteInput.substring(realRoot.length);
        } else if (absoluteInput.startsWith(resolvedRoot)) {
            normalized = absoluteInput.substring(resolvedRoot.length);
        }

        if (normalized.startsWith("/")) {
            normalized = normalized.substring(1);
        }

        return normalized || ".";
    }

    private cleanupIncomingDependencies(targetPath: string): void {
        for (const [source, snapshot] of this.dependencies.entries()) {
            const filtered = snapshot.outgoing.filter(dep => dep.target !== targetPath);
            if (filtered.length !== snapshot.outgoing.length) {
                this.dependencies.set(source, { ...snapshot, outgoing: filtered });
            }
        }
    }
}

type PersistedEmbedding = {
    provider: string;
    model: string;
    dims: number;
    vector: string;
    norm?: number;
};

type PersistedTransaction = TransactionLogEntry;

export class FileIndexStore extends MemoryIndexStore {
    private readonly storageDir: string;
    private readonly manifestPath: string;
    private readonly filesPath: string;
    private readonly symbolsPath: string;
    private readonly dependenciesPath: string;
    private readonly ghostsPath: string;
    private readonly chunksPath: string;
    private readonly embeddingsPath: string;
    private readonly packsPath: string;
    private readonly summariesPath: string;
    private readonly transactionsPath: string;
    private readonly embeddingPackConfig: EmbeddingPackConfig;
    private readonly embeddingPacks = new Map<string, EmbeddingPackManager>();
    private readonly hasLegacyEmbeddingsOnDisk: boolean;
    private hasEmbeddingPackOnDisk: boolean;

    constructor(rootPath: string) {
        super(rootPath, "file");
        PathManager.setRoot(rootPath);
        this.embeddingPackConfig = resolveEmbeddingPackConfigFromEnv();
        this.storageDir = PathManager.getStorageDir();
        this.manifestPath = path.join(this.storageDir, "manifest.json");
        this.filesPath = path.join(this.storageDir, "files.json");
        this.symbolsPath = path.join(this.storageDir, "symbols.json");
        this.dependenciesPath = path.join(this.storageDir, "dependencies.json");
        this.ghostsPath = path.join(this.storageDir, "ghosts.json");
        this.chunksPath = path.join(this.storageDir, "chunks.json");
        this.embeddingsPath = path.join(this.storageDir, "embeddings.json");
        this.packsPath = path.join(this.storageDir, "packs.json");
        this.summariesPath = path.join(this.storageDir, "summaries.json");
        this.transactionsPath = path.join(this.storageDir, "transactions.json");
        this.ensureStorage();
        this.hasLegacyEmbeddingsOnDisk = fs.existsSync(this.embeddingsPath) && fs.statSync(this.embeddingsPath).size > 2;
        this.hasEmbeddingPackOnDisk = this.embeddingPackConfig.enabled && (!this.hasLegacyEmbeddingsOnDisk || this.detectEmbeddingPackOnDisk());
        this.maybeMigrateEmbeddingPack();
        this.loadFromDisk();
    }

    public override getOrCreateFile(relativePath: string, lastModified?: number, language?: string | null): FileRecord {
        const record = super.getOrCreateFile(relativePath, lastModified, language);
        this.persistFiles();
        return record;
    }

    public override deleteFile(relativePath: string): void {
        super.deleteFile(relativePath);
        this.persistFiles();
        this.persistSymbols();
        this.persistDependencies();
        this.persistChunks();
        if (!this.embeddingPackConfig.enabled || !this.hasEmbeddingPackOnDisk) {
            this.persistEmbeddings();
        }
    }

    public override deleteFilesByPrefix(prefix: string): void {
        super.deleteFilesByPrefix(prefix);
        this.persistFiles();
        this.persistSymbols();
        this.persistDependencies();
        this.persistChunks();
        if (!this.embeddingPackConfig.enabled || !this.hasEmbeddingPackOnDisk) {
            this.persistEmbeddings();
        }
    }

    public override replaceSymbols(args: { relativePath: string; lastModified: number; language?: string | null; symbols: SymbolInfo[] }): void {
        super.replaceSymbols(args);
        this.persistFiles();
        this.persistSymbols();
    }

    public override replaceDependencies(args: {
        relativePath: string;
        lastModified: number;
        outgoing: Array<{ targetPath?: string; type: string; weight?: number; metadata?: Record<string, unknown> }>;
        unresolved: StoredUnresolvedDependency[];
    }): void {
        super.replaceDependencies(args);
        this.persistFiles();
        this.persistDependencies();
    }

    public override clearDependencies(relativePath: string): void {
        super.clearDependencies(relativePath);
        this.persistDependencies();
    }

    public override addGhost(ghost: StoredGhostSymbol): void {
        super.addGhost(ghost);
        this.persistGhosts();
    }

    public override deleteGhost(name: string): void {
        super.deleteGhost(name);
        this.persistGhosts();
    }

    public override pruneGhosts(olderThanMs: number): void {
        super.pruneGhosts(olderThanMs);
        this.persistGhosts();
    }

    public override upsertDocumentChunks(filePath: string, chunks: StoredDocumentChunk[]): void {
        super.upsertDocumentChunks(filePath, chunks);
        this.persistChunks();
    }

    public override deleteDocumentChunks(filePath: string): void {
        super.deleteDocumentChunks(filePath);
        this.persistChunks();
    }

    public override upsertEmbedding(chunkId: string, key: EmbeddingKey, embedding: { dims: number; vector: Float32Array; norm?: number }): void {
        if (this.embeddingPackConfig.enabled && this.hasEmbeddingPackOnDisk) {
            const pack = this.getEmbeddingPack(key);
            pack.upsertEmbedding(chunkId, embedding);
            pack.markReady();
            return;
        }
        super.upsertEmbedding(chunkId, key, embedding);
        this.persistEmbeddings();
    }

    public override getEmbedding(chunkId: string, key: EmbeddingKey): StoredEmbedding | null {
        if (this.embeddingPackConfig.enabled && this.hasEmbeddingPackOnDisk) {
            const pack = this.getEmbeddingPack(key);
            const embedding = pack.getEmbedding(chunkId);
            if (embedding) return embedding;
            return null;
        }
        return super.getEmbedding(chunkId, key);
    }

    public override deleteEmbedding(chunkId: string): void {
        if (this.embeddingPackConfig.enabled && this.hasEmbeddingPackOnDisk) {
            for (const pack of this.embeddingPacks.values()) {
                pack.deleteEmbedding(chunkId);
            }
            return;
        }
        super.deleteEmbedding(chunkId);
        this.persistEmbeddings();
    }

    public override deleteEmbeddingsForFile(filePath: string): void {
        const normalized = this.normalize(filePath);
        const chunkIds: string[] = [];
        for (const [chunkId, meta] of this.chunkIndex.entries()) {
            if (meta.filePath === normalized) {
                chunkIds.push(chunkId);
            }
        }
        if (this.embeddingPackConfig.enabled && this.hasEmbeddingPackOnDisk) {
            for (const chunkId of chunkIds) {
                for (const pack of this.embeddingPacks.values()) {
                    pack.deleteEmbedding(chunkId);
                }
            }
            return;
        }
        super.deleteEmbeddingsForFile(filePath);
        this.persistEmbeddings();
    }

    public override listEmbeddings(key: EmbeddingKey, limit?: number): StoredEmbedding[] {
        if (this.embeddingPackConfig.enabled && this.hasEmbeddingPackOnDisk) {
            return this.getEmbeddingPack(key).listEmbeddings(limit);
        }
        return super.listEmbeddings(key, limit);
    }

    public override iterateEmbeddings(key: EmbeddingKey, visitor: (embedding: StoredEmbedding) => void, options?: { limit?: number }): void {
        if (this.embeddingPackConfig.enabled && this.hasEmbeddingPackOnDisk) {
            this.getEmbeddingPack(key).iterateEmbeddings(visitor, options);
            return;
        }
        super.iterateEmbeddings(key, visitor, options);
    }

    public override upsertEvidencePack(packId: string, payload: unknown): void {
        super.upsertEvidencePack(packId, payload);
        this.persistPacks();
    }

    public override deleteEvidencePack(packId: string): void {
        super.deleteEvidencePack(packId);
        this.persistPacks();
    }

    public override upsertChunkSummary(chunkId: string, style: "preview" | "summary", summary: string, contentHash?: string): void {
        super.upsertChunkSummary(chunkId, style, summary, contentHash);
        this.persistSummaries();
    }

    public override upsertPendingTransaction(entry: TransactionLogEntry): void {
        super.upsertPendingTransaction(entry);
        this.persistTransactions();
    }

    public override markTransactionCommitted(id: string, entry: TransactionLogEntry): void {
        super.markTransactionCommitted(id, entry);
        this.persistTransactions();
    }

    public override markTransactionRolledBack(id: string): void {
        super.markTransactionRolledBack(id);
        this.persistTransactions();
    }

    public override close(): void {
        if (this.embeddingPackConfig.enabled && this.hasEmbeddingPackOnDisk) {
            for (const pack of this.embeddingPacks.values()) {
                pack.close();
            }
        }
    }

    public override dispose(): void {
        this.close();
    }

    private ensureStorage(): void {
        fs.mkdirSync(this.storageDir, { recursive: true });
        if (!fs.existsSync(this.manifestPath)) {
            this.writeJson(this.manifestPath, { version: 0, createdAt: new Date().toISOString() });
        }
    }

    private loadFromDisk(): void {
        const files = this.readJson<FileRecord[]>(this.filesPath, []);
        for (const record of files) {
            if (record?.path) {
                this.files.set(record.path, { ...record });
            }
        }

        const symbols = this.readJson<Record<string, SymbolInfo[]>>(this.symbolsPath, {});
        for (const [filePath, entries] of Object.entries(symbols)) {
            super.replaceSymbols({
                relativePath: filePath,
                lastModified: this.getFile(filePath)?.last_modified ?? Date.now(),
                language: this.getFile(filePath)?.language ?? null,
                symbols: entries ?? []
            });
        }

        const deps = this.readJson<Record<string, DependencySnapshot>>(this.dependenciesPath, {});
        for (const [filePath, snapshot] of Object.entries(deps)) {
            this.dependencies.set(filePath, {
                outgoing: snapshot.outgoing ?? [],
                unresolved: snapshot.unresolved ?? []
            });
        }

        const ghosts = this.readJson<StoredGhostSymbol[]>(this.ghostsPath, []);
        for (const ghost of ghosts) {
            if (ghost?.name) {
                super.addGhost(ghost);
            }
        }

        const chunks = this.readJson<Record<string, StoredDocumentChunk[]>>(this.chunksPath, {});
        for (const [filePath, entries] of Object.entries(chunks)) {
            super.upsertDocumentChunks(filePath, entries ?? []);
        }

        if (!this.embeddingPackConfig.enabled || !this.hasEmbeddingPackOnDisk) {
            const embeddings = this.readJson<Record<string, Record<string, PersistedEmbedding>>>(this.embeddingsPath, {});
            for (const [chunkId, variants] of Object.entries(embeddings)) {
                for (const [variantKey, payload] of Object.entries(variants ?? {})) {
                    if (!payload?.vector) continue;
                    const vector = decodeVector(payload.vector);
                    const [provider, model] = variantKey.split("::", 2);
                    if (!provider || !model) continue;
                    super.upsertEmbedding(chunkId, { provider, model }, {
                        dims: payload.dims,
                        vector,
                        norm: payload.norm
                    });
                }
            }
        }

        const packs = this.readJson<Record<string, unknown>>(this.packsPath, {});
        for (const [packId, payload] of Object.entries(packs)) {
            super.upsertEvidencePack(packId, payload);
        }

        const summaries = this.readJson<Record<string, Record<string, { summary: string; contentHash?: string }>>>(this.summariesPath, {});
        for (const [chunkId, styles] of Object.entries(summaries)) {
            for (const [style, payload] of Object.entries(styles ?? {})) {
                if (style !== "preview" && style !== "summary") continue;
                if (!payload?.summary) continue;
                super.upsertChunkSummary(chunkId, style as "preview" | "summary", payload.summary, payload.contentHash);
            }
        }

        const transactions = this.readJson<Record<string, PersistedTransaction>>(this.transactionsPath, {});
        for (const entry of Object.values(transactions)) {
            if (entry?.id) {
                super.upsertPendingTransaction(entry);
            }
        }
    }

    private persistFiles(): void {
        this.writeJson(this.filesPath, this.listFiles());
    }

    private persistSymbols(): void {
        const payload: Record<string, SymbolInfo[]> = {};
        for (const [filePath, entries] of this.streamAllSymbols().entries()) {
            payload[filePath] = entries;
        }
        this.writeJson(this.symbolsPath, payload);
    }

    private persistDependencies(): void {
        const payload: Record<string, DependencySnapshot> = {};
        for (const [filePath, snapshot] of this.dependencies.entries()) {
            payload[filePath] = snapshot;
        }
        this.writeJson(this.dependenciesPath, payload);
    }

    private persistGhosts(): void {
        this.writeJson(this.ghostsPath, this.listGhosts());
    }

    private persistChunks(): void {
        const payload: Record<string, StoredDocumentChunk[]> = {};
        for (const [filePath, chunks] of this.documentChunks.entries()) {
            payload[filePath] = chunks;
        }
        this.writeJson(this.chunksPath, payload);
    }

    private persistEmbeddings(): void {
        if (this.embeddingPackConfig.enabled && this.hasEmbeddingPackOnDisk) {
            for (const pack of this.embeddingPacks.values()) {
                pack.flush();
            }
            return;
        }
        const payload: Record<string, Record<string, PersistedEmbedding>> = {};
        for (const [chunkId, variants] of this.embeddings.entries()) {
            payload[chunkId] = {};
            for (const [variantKey, embedding] of variants.entries()) {
                payload[chunkId][variantKey] = {
                    provider: embedding.provider,
                    model: embedding.model,
                    dims: embedding.dims,
                    vector: encodeVector(embedding.vector),
                    norm: embedding.norm
                };
            }
        }
        this.writeJson(this.embeddingsPath, payload);
    }

    private getEmbeddingPack(key: EmbeddingKey): EmbeddingPackManager {
        const mapKey = embeddingKey(key);
        const existing = this.embeddingPacks.get(mapKey);
        if (existing) return existing;
        const pack = new EmbeddingPackManager(key, this.embeddingPackConfig);
        this.embeddingPacks.set(mapKey, pack);
        return pack;
    }

    private detectEmbeddingPackOnDisk(): boolean {
        const v1Dir = path.join(this.storageDir, "v1", "embeddings");
        if (!fs.existsSync(v1Dir)) return false;
        try {
            const providers = fs.readdirSync(v1Dir);
            for (const provider of providers) {
                const providerDir = path.join(v1Dir, provider);
                if (!fs.statSync(providerDir).isDirectory()) continue;
                const models = fs.readdirSync(providerDir);
                for (const model of models) {
                    const dir = path.join(providerDir, model);
                    if (!fs.statSync(dir).isDirectory()) continue;
                    const readyPath = path.join(dir, "ready.json");
                    if (fs.existsSync(readyPath)) return true;
                }
            }
        } catch {
            return false;
        }
        return false;
    }

    private maybeMigrateEmbeddingPack(): void {
        if (!this.embeddingPackConfig.enabled || !this.hasLegacyEmbeddingsOnDisk) return;
        if (this.embeddingPackConfig.rebuild === "manual") return;
        const hasReadyPack = this.detectEmbeddingPackOnDisk();
        if (this.embeddingPackConfig.rebuild === "auto" && hasReadyPack) {
            this.hasEmbeddingPackOnDisk = true;
            return;
        }

        try {
            if (this.embeddingPackConfig.rebuild === "on_start") {
                const v1Dir = path.join(this.storageDir, "v1", "embeddings");
                fs.rmSync(v1Dir, { recursive: true, force: true });
            }

            const embeddings = this.readJson<Record<string, Record<string, PersistedEmbedding>>>(this.embeddingsPath, {});
            const packs = new Map<string, EmbeddingPackManager>();
            let wrote = false;

            for (const [chunkId, variants] of Object.entries(embeddings)) {
                for (const [variantKey, payload] of Object.entries(variants ?? {})) {
                    if (!payload?.vector) continue;
                    const [provider, model] = variantKey.split("::", 2);
                    if (!provider || !model) continue;
                    const packKey = `${provider}::${model}`;
                    let pack = packs.get(packKey);
                    if (!pack) {
                        pack = new EmbeddingPackManager({ provider, model }, this.embeddingPackConfig);
                        packs.set(packKey, pack);
                    }
                    const vector = decodeVector(payload.vector);
                    pack.upsertEmbedding(chunkId, { dims: payload.dims, vector, norm: payload.norm });
                    wrote = true;
                }
            }

            for (const pack of packs.values()) {
                pack.markReady();
                pack.close();
            }

            if (wrote) {
                this.hasEmbeddingPackOnDisk = true;
            }
        } catch (err) {
            console.warn("[embedding-pack] Failed to migrate legacy embeddings pack:", err);
        }
    }

    private persistPacks(): void {
        const payload: Record<string, unknown> = {};
        for (const [packId, value] of this.evidencePacks.entries()) {
            payload[packId] = value;
        }
        this.writeJson(this.packsPath, payload);
    }

    private persistSummaries(): void {
        const payload: Record<string, Record<string, { summary: string; contentHash?: string }>> = {};
        for (const [chunkId, styles] of this.chunkSummaries.entries()) {
            payload[chunkId] = {};
            for (const [style, value] of styles.entries()) {
                payload[chunkId][style] = value;
            }
        }
        this.writeJson(this.summariesPath, payload);
    }

    private persistTransactions(): void {
        const payload: Record<string, PersistedTransaction> = {};
        for (const [id, entry] of this.transactions.entries()) {
            payload[id] = entry;
        }
        this.writeJson(this.transactionsPath, payload);
    }

    private writeJson(filePath: string, value: unknown): void {
        const dir = path.dirname(filePath);
        fs.mkdirSync(dir, { recursive: true });
        const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
        fs.writeFileSync(tmpPath, JSON.stringify(value));
        fs.renameSync(tmpPath, filePath);
    }

    private readJson<T>(filePath: string, fallback: T): T {
        try {
            if (!fs.existsSync(filePath)) return fallback;
            const raw = fs.readFileSync(filePath, "utf8");
            if (!raw.trim()) return fallback;
            return JSON.parse(raw) as T;
        } catch {
            return fallback;
        }
    }
}

export function resolveStorageMode(): StorageMode {
    const raw = (process.env.SMART_CONTEXT_STORAGE_MODE ?? "").trim().toLowerCase();
    if (raw === "memory") return "memory";
    return "file";
}

export function createIndexStore(rootPath: string): IndexStore {
    const mode = resolveStorageMode();
    if (mode === "memory") {
        return new MemoryIndexStore(rootPath, "memory");
    }
    return new FileIndexStore(rootPath);
}

function normalizeLikePattern(pattern: string): string {
    const trimmed = pattern.trim().replace(/%/g, "");
    return trimmed.toLowerCase();
}

function embeddingKey(key: EmbeddingKey): string {
    return `${key.provider}::${key.model}`;
}

function encodeVector(vector: Float32Array): string {
    const buffer = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
    return buffer.toString("base64");
}

function decodeVector(encoded: string): Float32Array {
    const buffer = Buffer.from(encoded, "base64");
    return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
}
