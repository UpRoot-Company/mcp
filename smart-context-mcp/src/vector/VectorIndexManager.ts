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
import { resolveVectorIndexConfigFromEnv, type VectorIndexConfig, type VectorIndexMode } from "./VectorIndexConfig.js";

type VectorIndexMeta = {
    version: number;
    provider: string;
    model: string;
    dims: number;
    count: number;
    rootFingerprint: string;
    backend: "hnsw" | "bruteforce";
    hnsw?: { m: number; efConstruction: number; efSearch: number };
    updatedAt: number;
};

type VectorIndexState = {
    key: string;
    provider: string;
    model: string;
    backend: "hnsw";
    dims: number;
    index: HnswVectorIndex;
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
            const results = state.index.search(query, args.k);
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

    public upsertEmbedding(chunkId: string, embedding: { provider: string; model: string; dims: number; vector: Float32Array }): void {
        if (!this.isEnabled() || this.config.mode === "off") return;
        const key = this.keyFor(embedding.provider, embedding.model);
        const state = this.states.get(key);
        if (!state) return;
        if (state.dims !== embedding.dims) return;
        state.index.upsert(chunkId, embedding.vector);
    }

    public removeChunk(chunkId: string): void {
        if (!chunkId) return;
        for (const state of this.states.values()) {
            state.index.remove(chunkId);
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

    private metaPath(provider: string, model: string): string {
        return path.join(this.indexDir(provider, model), "meta.json");
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
                const index = new HnswVectorIndex({
                    dims: meta.dims,
                    maxElements: this.config.maxPoints,
                    m: this.config.m,
                    efConstruction: this.config.efConstruction,
                    efSearch: this.config.efSearch
                });
                await index.load(this.indexDir(provider, model));
                metrics.gauge("vector_index.size", index.size());
                metrics.gauge("vector_index.backend", 1);
                return { key: this.keyFor(provider, model), provider, model, backend: "hnsw", dims: meta.dims, index, meta };
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
            const index = new HnswVectorIndex({
                dims,
                maxElements: this.config.maxPoints,
                m: this.config.m,
                efConstruction: this.config.efConstruction,
                efSearch: this.config.efSearch
            });
            await index.initializeEmpty();
            let count = 0;
            this.embeddingRepository.iterateEmbeddings(provider, model, (embedding) => {
                if (embedding.vector.length !== dims) return;
                index.upsert(embedding.chunkId, embedding.vector);
                count++;
            }, { limit: this.config.maxPoints });
            await index.save(this.indexDir(provider, model));
            const meta: VectorIndexMeta = {
                version: 1,
                provider,
                model,
                dims,
                count,
                rootFingerprint: this.rootFingerprint,
                backend: "hnsw",
                hnsw: { m: this.config.m, efConstruction: this.config.efConstruction, efSearch: this.config.efSearch },
                updatedAt: Date.now()
            };
            await writeJson(this.metaPath(provider, model), meta);
            metrics.gauge("vector_index.size", index.size());
            metrics.gauge("vector_index.backend", 1);
            return { key: this.keyFor(provider, model), provider, model, backend: "hnsw", dims, index, meta };
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
