import type { VectorIndex, VectorIndexResult } from "./VectorIndex.js";

export class BruteforceVectorIndex implements VectorIndex {
    public readonly backend = "bruteforce" as const;
    public readonly dims: number;
    private readonly vectors = new Map<string, Float32Array>();

    constructor(dims: number) {
        this.dims = dims;
    }

    public size(): number {
        return this.vectors.size;
    }

    public upsert(id: string, vector: Float32Array): void {
        if (!id) return;
        if (vector.length !== this.dims) return;
        this.vectors.set(id, vector);
    }

    public remove(id: string): void {
        if (!id) return;
        this.vectors.delete(id);
    }

    public search(query: Float32Array, k: number): VectorIndexResult[] {
        if (!query || query.length !== this.dims) return [];
        const results: VectorIndexResult[] = [];
        for (const [id, vector] of this.vectors.entries()) {
            const score = cosineSimilarity(query, vector);
            results.push({ id, score });
        }
        results.sort((a, b) => b.score - a.score);
        return results.slice(0, Math.max(0, k));
    }

    public async save(_dir: string): Promise<void> {}

    public async load(_dir: string): Promise<void> {}

    public dispose(): void {
        this.vectors.clear();
    }
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i += 1) {
        const av = a[i];
        const bv = b[i];
        dot += av * bv;
        normA += av * av;
        normB += bv * bv;
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
