import { EmbeddingConfig, EmbeddingProvider } from "../types.js";
import { resolveEmbeddingProviderEnv } from "./EmbeddingConfig.js";
import { DisabledEmbeddingProvider } from "./DisabledEmbeddingProvider.js";
import { HashEmbeddingProvider } from "./HashEmbeddingProvider.js";
import { OpenAIEmbeddingProvider } from "./OpenAIEmbeddingProvider.js";

export interface EmbeddingProviderClient {
    provider: EmbeddingProvider;
    model: string;
    dims: number;
    normalize: boolean;
    embed(texts: string[]): Promise<Float32Array[]>;
}

export class EmbeddingProviderFactory {
    private cached?: EmbeddingProviderClient;

    constructor(private readonly config: EmbeddingConfig) {}

    public async getProvider(): Promise<EmbeddingProviderClient> {
        if (this.cached) return this.cached;
        const resolved = resolveEmbeddingProviderEnv(this.config);

        if (resolved.provider === "openai" && resolved.apiKey) {
            this.cached = new OpenAIEmbeddingProvider({
                apiKey: resolved.apiKey,
                model: this.config.openai?.model ?? "text-embedding-3-small",
                normalize: this.config.normalize !== false
            });
            return this.cached;
        }

        if (resolved.provider === "local") {
            const dims = this.config.local?.dims ?? 384;
            const model = this.config.local?.model ?? "hash-embedding-v1";
            this.cached = new HashEmbeddingProvider({
                model,
                dims,
                normalize: this.config.normalize !== false
            });
            return this.cached;
        }

        this.cached = new DisabledEmbeddingProvider();
        return this.cached;
    }

    public getConfig(): EmbeddingConfig {
        return this.config;
    }
}
