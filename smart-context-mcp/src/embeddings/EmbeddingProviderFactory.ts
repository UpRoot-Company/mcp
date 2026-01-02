import { EmbeddingConfig, EmbeddingProvider } from "../types.js";
import { resolveEmbeddingProviderEnv } from "./EmbeddingConfig.js";
import { DisabledEmbeddingProvider } from "./DisabledEmbeddingProvider.js";
import { HashEmbeddingProvider } from "./HashEmbeddingProvider.js";
import { TransformersEmbeddingProvider } from "./TransformersEmbeddingProvider.js";
import { EmbeddingQueue } from "./EmbeddingQueue.js";

export interface EmbeddingProviderClient {
    provider: EmbeddingProvider;
    model: string;
    dims: number;
    normalize: boolean;
    embed(texts: string[]): Promise<Float32Array[]>;
}

export class EmbeddingProviderFactory {
    private cached?: EmbeddingProviderClient;
    private queue?: EmbeddingQueue;

    constructor(private readonly config: EmbeddingConfig) {}

    public async getProvider(): Promise<EmbeddingProviderClient> {
        if (this.cached) return this.cached;
        const resolved = resolveEmbeddingProviderEnv(this.config);

        if (resolved.provider === "local") {
            const model = this.config.local?.model ?? "multilingual-e5-small";
            if (isHashModel(model)) {
                const dims = this.config.local?.dims ?? 384;
                this.cached = new HashEmbeddingProvider({
                    model,
                    dims,
                    normalize: this.config.normalize !== false
                });
            } else {
                const queue = this.getQueue();
                const primary = new TransformersEmbeddingProvider({
                    model,
                    dims: this.config.local?.dims,
                    normalize: this.config.normalize !== false,
                    timeoutMs: this.config.timeoutMs,
                    queue,
                    modelCacheDir: this.config.modelCacheDir,
                    modelDir: this.config.modelDir
                });
                const fallback = createFallbackProvider(this.config);
                this.cached = new FallbackEmbeddingProvider(primary, fallback);
            }
            return this.cached;
        }

        this.cached = new DisabledEmbeddingProvider();
        return this.cached;
    }

    public getConfig(): EmbeddingConfig {
        return this.config;
    }

    private getQueue(): EmbeddingQueue {
        if (!this.queue) {
            this.queue = new EmbeddingQueue({
                concurrency: this.config.concurrency ?? 1,
                defaultTimeoutMs: this.config.timeoutMs,
                maxQueueSize: this.config.maxQueueSize
            });
        }
        return this.queue;
    }
}

function isHashModel(model: string): boolean {
    const normalized = model.trim().toLowerCase();
    return normalized.startsWith("hash-") || normalized === "hash";
}

function createFallbackProvider(config: EmbeddingConfig): EmbeddingProviderClient {
    const dims = config.local?.dims ?? 384;
    return new HashEmbeddingProvider({
        model: "hash",
        dims,
        normalize: config.normalize !== false
    });
}

class FallbackEmbeddingProvider implements EmbeddingProviderClient {
    public provider: EmbeddingProvider;
    public model: string;
    public dims: number;
    public normalize: boolean;

    private active: EmbeddingProviderClient;
    private hasFallenBack = false;

    constructor(
        private readonly primary: EmbeddingProviderClient,
        private readonly fallback: EmbeddingProviderClient
    ) {
        this.active = primary;
        this.provider = primary.provider;
        this.model = primary.model;
        this.dims = primary.dims;
        this.normalize = primary.normalize;
    }

    public async embed(texts: string[]): Promise<Float32Array[]> {
        try {
            const vectors = await this.active.embed(texts);
            this.dims = this.active.dims;
            return vectors;
        } catch (error) {
            if (!this.hasFallenBack) {
                this.hasFallenBack = true;
                this.active = this.fallback;
                this.provider = this.fallback.provider;
                this.model = this.fallback.model;
                this.dims = this.fallback.dims;
                this.normalize = this.fallback.normalize;
                console.warn("[Embedding] Primary model failed; falling back to hash embeddings.");
                return this.active.embed(texts);
            }
            throw error;
        }
    }
}
