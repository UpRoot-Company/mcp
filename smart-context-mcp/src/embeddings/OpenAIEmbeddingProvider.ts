import { EmbeddingProvider } from "../types.js";
import type { EmbeddingProviderClient } from "./EmbeddingProviderFactory.js";

export class OpenAIEmbeddingProvider implements EmbeddingProviderClient {
    public readonly provider: EmbeddingProvider = "openai";
    public readonly model: string;
    public dims: number;
    public readonly normalize: boolean;

    constructor(options: { apiKey: string; model: string; normalize: boolean }) {
        this.apiKey = options.apiKey;
        this.model = options.model;
        this.normalize = options.normalize;
        this.dims = 0;
    }

    private readonly apiKey: string;

    public async embed(texts: string[]): Promise<Float32Array[]> {
        const response = await fetch("https://api.openai.com/v1/embeddings", {
            method: "POST",
            headers: {
                "Authorization": `Bearer ${this.apiKey}`,
                "Content-Type": "application/json"
            },
            body: JSON.stringify({ model: this.model, input: texts })
        });

        if (!response.ok) {
            const message = await response.text();
            throw new Error(`OpenAI embedding failed: ${response.status} ${message}`);
        }

        const payload = await response.json() as { data?: Array<{ embedding: number[] }> };
        const vectors = (payload.data ?? []).map(item => new Float32Array(item.embedding));
        if (vectors.length > 0) {
            this.dims = vectors[0].length;
        }
        if (this.normalize) {
            for (const vector of vectors) {
                normalizeVector(vector);
            }
        }
        return vectors;
    }
}

function normalizeVector(vector: Float32Array): void {
    let sum = 0;
    for (const v of vector) {
        sum += v * v;
    }
    const norm = Math.sqrt(sum);
    if (norm === 0) return;
    for (let i = 0; i < vector.length; i += 1) {
        vector[i] /= norm;
    }
}
