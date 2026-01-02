export type VectorIndexBackend = "bruteforce" | "hnsw";

export interface VectorIndexResult {
    id: string;
    score: number;
}

export interface VectorIndex {
    backend: VectorIndexBackend;
    dims: number;
    size(): number;
    upsert(id: string, vector: Float32Array): void;
    remove(id: string): void;
    search(query: Float32Array, k: number): VectorIndexResult[];
    save(dir: string): Promise<void>;
    load(dir: string): Promise<void>;
}
