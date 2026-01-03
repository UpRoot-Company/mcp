import * as fs from "fs/promises";
import * as path from "path";
import { PathManager } from "../utils/PathManager.js";
import { EmbeddingRepository } from "../indexing/EmbeddingRepository.js";
import { resolveEmbeddingProviderEnv } from "../embeddings/EmbeddingConfig.js";
import type { EmbeddingConfig } from "../types.js";
import { computeRootFingerprint } from "../indexing/EvidencePackRepository.js";
import { metrics } from "../utils/MetricsCollector.js";
import type { VectorIndex, VectorIndexResult } from "./VectorIndex.js";
import { BruteforceVectorIndex } from "./BruteforceVectorIndex.js";
import { HnswVectorIndex } from "./HnswVectorIndex.js";
import { resolveVectorIndexConfigFromEnv, type VectorIndexConfig, type VectorIndexMode, type VectorIndexShardSetting } from "./VectorIndexConfig.js";

/**
 * Vector item type - supports both document chunks and code symbols
 */
export type VectorItemType = 'doc' | 'symbol';

export interface VectorItemMetadata {
    type: VectorItemType;
    filePath: string;
    lineRange?: { start: number; end: number };
    symbolType?: 'class' | 'function' | 'method' | 'interface' | 'type';
    symbolName?: string;
    signature?: string;
}

export interface VectorItem {
    id: string;
    metadata: VectorItemMetadata;
    embedding: {
        provider: string;
        model: string;
        dims: number;
        vector: Float32Array;
    };
}

type VectorIndexMeta = {
    version: number;
    provider: string;
    model: string;
    dims: number;
    count: number;
    rootFingerprint: string;
    backend: "hnsw" | "bruteforce";
    shardCount?: number;
    shards?: Array<{ shardId: number; count: number }>;
    hnsw?: { m: number; efConstruction: number; efSearch: number };
    updatedAt: number;
};

type VectorIndexState = {
    key: string;
    provider: string;
    model: string;
    backend: "hnsw";
    dims: number;
    shardCount: number;
    indexes: HnswVectorIndex[];
    meta: VectorIndexMeta;
};

export class VectorIndexManager {
    private readonly rootPath: string;
    private readonly embeddingRepository: EmbeddingRepository;
    private readonly config: VectorIndexConfig;
    private readonly rootFingerprint: string;
    private readonly states = new Map<string, VectorIndexState>();
    private readonly loadPromises = new Map<string, Promise<VectorIndexState | null>>();

    constructor(rootPath: string, embeddingRepository: EmbeddingRepository, config?: VectorIndexConfig) {
        this.rootPath = path.resolve(rootPath);
        this.embeddingRepository = embeddingRepository;
        this.config = config ?? resolveVectorIndexConfigFromEnv();
        this.rootFingerprint = computeRootFingerprint(this.rootPath);
    }

    public getConfig(): VectorIndexConfig {
        return this.config;
    }

    public isEnabled(): boolean {
        return this.config.mode !== "off";
    }

    public async initializeFromEmbeddingConfig(config: EmbeddingConfig): Promise<void> {
        if (!this.isEnabled()) return;
        const provider = resolveEmbeddingProviderEnv(config).provider;
        const model = config.local?.model;
        if (!model || provider === "disabled" || model === "hash") return;
        if (this.config.rebuild === "manual") return;
        await this.ensureIndex(provider, model, { allowRebuild: true });
    }

    public async rebuildFromRepository(provider: string, model: string): Promise<VectorIndexMeta | null> {
        if (!this.isEnabled() || this.config.mode === "off") {
            throw new Error("Vector index is disabled.");
        }
        const state = await this.buildIndex(provider, model);
        return state?.meta ?? null;
    }

    public async search(query: Float32Array, args: { provider: string; model: string; k: number }): Promise<{ ids: string[]; scores: Map<string, number>; degraded: boolean; reason?: string; backend?: string }> {
        if (!this.isEnabled()) {
            return { ids: [], scores: new Map(), degraded: true, reason: "vector_index_disabled" };
        }
        const { provider, model } = args;
        if (!provider || !model || model === "hash") {
            return { ids: [], scores: new Map(), degraded: true, reason: "vector_index_disabled" };
        }
        const backend = this.resolveBackend();
        if (backend === "bruteforce") {
            const stop = metrics.startTimer("vector_index.query_ms");
            try {
                const results = this.searchBruteforce(query, provider, model, args.k);
                metrics.gauge("vector_index.backend", 0);
                return {
                    ids: results.map(r => r.id),
                    scores: new Map(results.map(r => [r.id, r.score])),
                    degraded: false,
                    backend
                };
            } finally {
                stop();
            }
        }

        const state = await this.ensureIndex(provider, model, { allowRebuild: this.config.rebuild === "on_start" || this.config.rebuild === "auto" });
        if (!state) {
            if (this.config.mode === "auto") {
                const fallback = this.searchBruteforce(query, provider, model, args.k);
                return {
                    ids: fallback.map(r => r.id),
                    scores: new Map(fallback.map(r => [r.id, r.score])),
                    degraded: fallback.length === 0,
                    reason: fallback.length === 0 ? "vector_index_unavailable" : undefined,
                    backend: "bruteforce"
                };
            }
            return { ids: [], scores: new Map(), degraded: true, reason: "vector_index_unavailable" };
        }

        const stop = metrics.startTimer("vector_index.query_ms");
        try {
            const scoreMap = new Map<string, number>();
            const perShardK = Math.max(0, Math.floor(args.k));
            for (const index of state.indexes) {
                const results = index.search(query, perShardK);
                for (const res of results) {
                    const prev = scoreMap.get(res.id);
                    if (prev === undefined || res.score > prev) {
                        scoreMap.set(res.id, res.score);
                    }
                }
            }
            const results = Array.from(scoreMap.entries())
                .map(([id, score]) => ({ id, score }))
                .sort((a, b) => b.score - a.score)
                .slice(0, perShardK);
            return {
                ids: results.map(r => r.id),
                scores: new Map(results.map(r => [r.id, r.score])),
                degraded: false,
                backend: state.backend
            };
        } finally {
            stop();
        }
    }

    /**
     * Index a vector item (document chunk or code symbol)
     * @param item - VectorItem with metadata and embedding
     */
    public indexItem(item: VectorItem): void {
        if (!this.isEnabled() || this.config.mode === "off") return;
        const key = this.keyFor(item.embedding.provider, item.embedding.model);
        const state = this.states.get(key);
        if (!state) return;
        if (state.dims !== item.embedding.dims) return;
        const shardId = this.shardForId(item.id, state.shardCount);
        state.indexes[shardId]?.upsert(item.id, item.embedding.vector);
    }

    /**
     * @deprecated Use indexItem() instead. Kept for backward compatibility.
     */
    public upsertEmbedding(chunkId: string, embedding: { provider: string; model: string; dims: number; vector: Float32Array }): void {
        // Backward compatibility: treat as document chunk
        this.indexItem({
            id: chunkId,
            metadata: {
                type: 'doc',
                filePath: '', // Unknown for legacy calls
            },
            embedding
        });
    }

    public removeChunk(chunkId: string): void {
        if (!chunkId) return;
        for (const state of this.states.values()) {
            const shardId = this.shardForId(chunkId, state.shardCount);
            state.indexes[shardId]?.remove(chunkId);
        }
    }

    public removeChunks(chunkIds: string[]): void {
        for (const chunkId of chunkIds) {
            this.removeChunk(chunkId);
        }
    }

    private resolveBackend(): VectorIndexMode {
        if (this.config.mode === "auto") return "hnsw";
        return this.config.mode;
    }

    private keyFor(provider: string, model: string): string {
        return `${provider}::${model}`;
    }

    private indexDir(provider: string, model: string): string {
        return path.join(PathManager.getVectorIndexDir(), provider, model);
    }

    private shardDir(provider: string, model: string, shardId: number): string {
        return path.join(this.indexDir(provider, model), "shards", String(shardId));
    }

    private metaPath(provider: string, model: string): string {
        return path.join(this.indexDir(provider, model), "meta.json");
    }

    private resolveShardCount(setting: VectorIndexShardSetting, maxPoints: number): number {
        if (setting === "off") return 1;
        if (typeof setting === "number") return Math.max(1, Math.floor(setting));
        // auto: conservative defaults; can be tuned as we learn more.
        if (maxPoints >= 500000) return 8;
        if (maxPoints >= 200000) return 4;
        if (maxPoints >= 100000) return 2;
        return 1;
    }

    private shardForId(id: string, shardCount: number): number {
        if (!id || shardCount <= 1) return 0;
        // FNV-1a 32-bit
        let hash = 2166136261;
        for (let i = 0; i < id.length; i += 1) {
            hash ^= id.charCodeAt(i);
            hash = Math.imul(hash, 16777619);
        }
        // >>> 0 to force uint32
        return (hash >>> 0) % shardCount;
    }

    private async ensureIndex(provider: string, model: string, options: { allowRebuild: boolean }): Promise<VectorIndexState | null> {
        const key = this.keyFor(provider, model);
        const existing = this.states.get(key);
        if (existing) return existing;
        const pending = this.loadPromises.get(key);
        if (pending) return pending;

        const loadPromise = this.loadIndex(provider, model, options.allowRebuild);
        this.loadPromises.set(key, loadPromise);
        const state = await loadPromise;
        this.loadPromises.delete(key);
        if (state) {
            this.states.set(key, state);
        }
        return state;
    }

    private async loadIndex(provider: string, model: string, allowRebuild: boolean): Promise<VectorIndexState | null> {
        if (this.config.mode === "bruteforce") return null;
        const meta = await readJson<VectorIndexMeta | null>(this.metaPath(provider, model), null);
        if (meta && meta.provider === provider && meta.model === model && meta.rootFingerprint === this.rootFingerprint) {
            try {
                const shardCount = Math.max(1, meta.shardCount ?? 1);
                const indexes: HnswVectorIndex[] = [];
                for (let shardId = 0; shardId < shardCount; shardId += 1) {
                    const maxElements = Math.ceil((this.config.maxPoints / shardCount) * 1.1);
                    const index = new HnswVectorIndex({
                        dims: meta.dims,
                        maxElements,
                        m: this.config.m,
                        efConstruction: this.config.efConstruction,
                        efSearch: this.config.efSearch
                    });
                    const dir = shardCount > 1 ? this.shardDir(provider, model, shardId) : this.indexDir(provider, model);
                    await index.load(dir);
                    indexes.push(index);
                }
                metrics.gauge("vector_index.size", indexes.reduce((sum, idx) => sum + idx.size(), 0));
                metrics.gauge("vector_index.backend", 1);
                return { key: this.keyFor(provider, model), provider, model, backend: "hnsw", dims: meta.dims, shardCount, indexes, meta };
            } catch {
                // fall through to rebuild
            }
        }

        if (!allowRebuild) return null;
        return this.buildIndex(provider, model);
    }

    private async buildIndex(provider: string, model: string): Promise<VectorIndexState | null> {
        if (this.config.mode === "bruteforce") return null;
        const stop = metrics.startTimer("vector_index.build_ms");
        try {
            let dims = 0;
            this.embeddingRepository.iterateEmbeddings(provider, model, (embedding) => {
                dims = embedding.dims;
            }, { limit: 1 });
            if (!dims) return null;
            const shardCount = this.resolveShardCount(this.config.shards, this.config.maxPoints);
            const indexes: HnswVectorIndex[] = [];
            for (let shardId = 0; shardId < shardCount; shardId += 1) {
                const maxElements = Math.ceil((this.config.maxPoints / shardCount) * 1.1);
                const index = new HnswVectorIndex({
                    dims,
                    maxElements,
                    m: this.config.m,
                    efConstruction: this.config.efConstruction,
                    efSearch: this.config.efSearch
                });
                await index.initializeEmpty();
                indexes.push(index);
            }

            const shardCounts = new Array<number>(shardCount).fill(0);
            let count = 0;
            this.embeddingRepository.iterateEmbeddings(provider, model, (embedding) => {
                if (count >= this.config.maxPoints) return;
                if (embedding.vector.length !== dims) return;
                const shardId = this.shardForId(embedding.chunkId, shardCount);
                indexes[shardId]?.upsert(embedding.chunkId, embedding.vector);
                shardCounts[shardId] += 1;
                count += 1;
            }, { limit: this.config.maxPoints });

            for (let shardId = 0; shardId < shardCount; shardId += 1) {
                const dir = shardCount > 1 ? this.shardDir(provider, model, shardId) : this.indexDir(provider, model);
                await indexes[shardId]!.save(dir);
            }
            const meta: VectorIndexMeta = {
                version: 2,
                provider,
                model,
                dims,
                count,
                rootFingerprint: this.rootFingerprint,
                backend: "hnsw",
                shardCount,
                shards: shardCounts.map((c, shardId) => ({ shardId, count: c })),
                hnsw: { m: this.config.m, efConstruction: this.config.efConstruction, efSearch: this.config.efSearch },
                updatedAt: Date.now()
            };
            await writeJson(this.metaPath(provider, model), meta);
            metrics.gauge("vector_index.size", indexes.reduce((sum, idx) => sum + idx.size(), 0));
            metrics.gauge("vector_index.backend", 1);
            return { key: this.keyFor(provider, model), provider, model, backend: "hnsw", dims, shardCount, indexes, meta };
        } finally {
            stop();
        }
    }

    private searchBruteforce(query: Float32Array, provider: string, model: string, k: number): VectorIndexResult[] {
        let dims = 0;
        this.embeddingRepository.iterateEmbeddings(provider, model, (embedding) => {
            dims = embedding.dims;
        }, { limit: 1 });
        if (!dims || query.length !== dims) return [];
        const index = new BruteforceVectorIndex(dims);
        let count = 0;
        this.embeddingRepository.iterateEmbeddings(provider, model, (embedding) => {
            if (embedding.vector.length !== dims) return;
            index.upsert(embedding.chunkId, embedding.vector);
            count++;
        }, { limit: this.config.maxPoints });
        if (count === 0) return [];
        return index.search(query, k);
    }
}

async function readJson<T>(filePath: string, fallback: T): Promise<T> {
    try {
        const raw = await fs.readFile(filePath, "utf8");
        if (!raw.trim()) return fallback;
        return JSON.parse(raw) as T;
    } catch {
        return fallback;
    }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmpPath, JSON.stringify(value));
    await fs.rename(tmpPath, filePath);
}
