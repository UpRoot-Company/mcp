import { EmbeddingProvider } from "../types.js";
import type { EmbeddingProviderClient } from "./EmbeddingProviderFactory.js";

export class HashEmbeddingProvider implements EmbeddingProviderClient {
    public readonly provider: EmbeddingProvider = "local";
    public readonly model: string;
    public readonly dims: number;
    public readonly normalize: boolean;

    constructor(options: { model: string; dims: number; normalize: boolean }) {
        this.model = options.model;
        this.dims = options.dims;
        this.normalize = options.normalize;
    }

    public async embed(texts: string[]): Promise<Float32Array[]> {
        return texts.map(text => {
            const vector = hashEmbed(text, this.dims);
            if (this.normalize) {
                normalizeVector(vector);
            }
            return vector;
        });
    }
}

function hashEmbed(text: string, dims: number): Float32Array {
    const vector = new Float32Array(dims);
    const tokens = tokenize(text);
    for (const token of tokens) {
        const hash = fnv1a(token);
        const idx = hash % dims;
        const sign = (hash & 1) === 0 ? 1 : -1;
        vector[idx] += sign;
    }
    return vector;
}

function tokenize(text: string): string[] {
    return text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(token => token.length > 0);
}

function fnv1a(value: string): number {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i += 1) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
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
