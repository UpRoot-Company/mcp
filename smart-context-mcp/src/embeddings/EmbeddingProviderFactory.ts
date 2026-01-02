import { EmbeddingConfig, EmbeddingProvider } from "../types.js";
import { resolveEmbeddingProviderEnv } from "./EmbeddingConfig.js";
import { DisabledEmbeddingProvider } from "./DisabledEmbeddingProvider.js";
import { HashEmbeddingProvider } from "./HashEmbeddingProvider.js";
import { OpenAIEmbeddingProvider } from "./OpenAIEmbeddingProvider.js";
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

        if (resolved.provider === "openai" && resolved.apiKey) {
            this.cached = new OpenAIEmbeddingProvider({
                apiKey: resolved.apiKey,
                model: this.config.openai?.model ?? "text-embedding-3-small",
                normalize: this.config.normalize !== false,
                timeoutMs: this.config.timeoutMs
            });
            return this.cached;
        }

        if (resolved.provider === "local") {
            const model = this.config.local?.model ?? "Xenova/all-MiniLM-L6-v2";
            if (isHashModel(model)) {
                const dims = this.config.local?.dims ?? 384;
                this.cached = new HashEmbeddingProvider({
                    model,
                    dims,
                    normalize: this.config.normalize !== false
                });
            } else {
                const queue = this.getQueue();
                this.cached = new TransformersEmbeddingProvider({
                    model,
                    dims: this.config.local?.dims,
                    normalize: this.config.normalize !== false,
                    timeoutMs: this.config.timeoutMs,
                    queue,
                    modelCacheDir: this.config.modelCacheDir
                });
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
