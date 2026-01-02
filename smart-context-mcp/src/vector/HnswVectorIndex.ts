import * as fs from "fs/promises";
import * as path from "path";
import type { VectorIndex, VectorIndexResult } from "./VectorIndex.js";

type HnswModule = {
    HierarchicalNSW?: new (space: string, dims: number) => HnswIndex;
    default?: { HierarchicalNSW?: new (space: string, dims: number) => HnswIndex };
};

type HnswIndex = {
    initIndex?: (maxElements: number, m?: number, efConstruction?: number) => void;
    addPoint?: (vector: Float32Array, label: number, replaceDeleted?: boolean) => void;
    searchKnn?: (vector: Float32Array, k: number) => any;
    writeIndex?: (filePath: string) => void;
    writeIndexSync?: (filePath: string) => void;
    readIndex?: (filePath: string, maxElements?: number) => void;
    readIndexSync?: (filePath: string, maxElements?: number) => void;
    setEf?: (ef: number) => void;
    markDelete?: (label: number) => void;
    deletePoint?: (label: number) => void;
    getCurrentCount?: () => number;
};

export class HnswVectorIndex implements VectorIndex {
    public readonly backend = "hnsw" as const;
    public readonly dims: number;

    private readonly maxElements: number;
    private readonly m: number;
    private readonly efConstruction: number;
    private readonly efSearch: number;
    private readonly space: string;
    private index?: HnswIndex;
    private idToLabel = new Map<string, number>();
    private labelToId = new Map<number, string>();
    private deletedLabels = new Set<number>();
    private nextLabel = 0;

    constructor(options: { dims: number; maxElements: number; m: number; efConstruction: number; efSearch: number; space?: string }) {
        this.dims = options.dims;
        this.maxElements = options.maxElements;
        this.m = options.m;
        this.efConstruction = options.efConstruction;
        this.efSearch = options.efSearch;
        this.space = options.space ?? "cosine";
    }

    public size(): number {
        if (this.index?.getCurrentCount) {
            return this.index.getCurrentCount();
        }
        return this.idToLabel.size;
    }

    public upsert(id: string, vector: Float32Array): void {
        if (!this.index || !id || vector.length !== this.dims) return;
        const label = this.getOrCreateLabel(id);
        if (label < 0) return;
        const addPoint = this.index.addPoint;
        if (!addPoint) return;
        try {
            addPoint.call(this.index, vector, label, true);
        } catch {
            try {
                if (this.index?.markDelete) {
                    this.index.markDelete(label);
                } else if (this.index?.deletePoint) {
                    this.index.deletePoint(label);
                }
                addPoint.call(this.index, vector, label, true);
            } catch {
                // ignore add failures
            }
        }
    }

    public remove(id: string): void {
        if (!this.index || !id) return;
        const label = this.idToLabel.get(id);
        if (label === undefined) return;
        this.deletedLabels.add(label);
        this.idToLabel.delete(id);
        this.labelToId.delete(label);
        if (this.index.markDelete) {
            try {
                this.index.markDelete(label);
            } catch {
                // ignore delete failures
            }
        } else if (this.index.deletePoint) {
            try {
                this.index.deletePoint(label);
            } catch {
                // ignore delete failures
            }
        }
    }

    public search(query: Float32Array, k: number): VectorIndexResult[] {
        if (!this.index || !query || query.length !== this.dims) return [];
        const searchKnn = this.index.searchKnn;
        if (!searchKnn) return [];
        let raw: any;
        try {
            raw = searchKnn.call(this.index, query, Math.max(0, k));
        } catch {
            return [];
        }

        const { labels, distances } = normalizeSearchOutput(raw);
        if (!labels || labels.length === 0) return [];
        const results: VectorIndexResult[] = [];
        for (let i = 0; i < labels.length; i += 1) {
            const label = labels[i];
            const id = this.labelToId.get(label);
            if (!id) continue;
            if (this.deletedLabels.has(label)) continue;
            const distance = distances?.[i];
            const score = typeof distance === "number" ? 1 - distance : 0;
            results.push({ id, score });
        }
        return results;
    }

    public async save(dir: string): Promise<void> {
        if (!this.index) return;
        await fs.mkdir(dir, { recursive: true });
        const indexPath = path.join(dir, "index.bin");
        const idsPath = path.join(dir, "ids.json");
        const writeIndex = this.index.writeIndexSync ?? this.index.writeIndex;
        if (typeof writeIndex !== "function") {
            throw new Error("hnsw index does not support serialization");
        }
        await Promise.resolve(writeIndex.call(this.index, indexPath));
        const ids: Array<string | null> = [];
        for (const [label, id] of this.labelToId.entries()) {
            ids[label] = id;
        }
        await fs.writeFile(idsPath, JSON.stringify(ids));
    }

    public async load(dir: string): Promise<void> {
        await fs.mkdir(dir, { recursive: true });
        const indexPath = path.join(dir, "index.bin");
        const idsPath = path.join(dir, "ids.json");
        const idsRaw = await readJson<Array<string | null>>(idsPath, []);
        this.idToLabel = new Map();
        this.labelToId = new Map();
        this.deletedLabels = new Set();
        for (let i = 0; i < idsRaw.length; i += 1) {
            const id = idsRaw[i];
            if (!id) continue;
            this.idToLabel.set(id, i);
            this.labelToId.set(i, id);
        }
        this.nextLabel = idsRaw.length;
        this.index = await createIndex(this.space, this.dims);
        const readIndex = this.index.readIndexSync ?? this.index.readIndex;
        if (typeof readIndex !== "function") {
            throw new Error("hnsw index does not support deserialization");
        }
        await Promise.resolve(readIndex.call(this.index, indexPath, this.maxElements));
        this.applySearchParams(this.index);
    }

    public async initializeEmpty(): Promise<void> {
        this.index = await createIndex(this.space, this.dims);
        this.initIndex(this.index);
        this.applySearchParams(this.index);
    }

    private applySearchParams(index: HnswIndex): void {
        if (index.setEf) {
            index.setEf(this.efSearch);
        }
    }

    private initIndex(index: HnswIndex): void {
        if (index.initIndex) {
            try {
                index.initIndex(this.maxElements, this.m, this.efConstruction);
            } catch {
                try {
                    index.initIndex(this.maxElements);
                } catch {
                    // ignore init failures
                }
            }
        }
    }

    private getOrCreateLabel(id: string): number {
        const existing = this.idToLabel.get(id);
        if (existing !== undefined) return existing;
        if (this.nextLabel >= this.maxElements) {
            return -1;
        }
        const label = this.nextLabel;
        this.nextLabel += 1;
        this.idToLabel.set(id, label);
        this.labelToId.set(label, id);
        return label;
    }
}

async function createIndex(space: string, dims: number): Promise<HnswIndex> {
    const module = (await import("hnswlib-wasm")) as HnswModule;
    const ctor = module?.HierarchicalNSW ?? module?.default?.HierarchicalNSW;
    if (!ctor) {
        throw new Error("Failed to load hnswlib-wasm");
    }
    return new ctor(space, dims);
}

function normalizeSearchOutput(raw: any): { labels: number[]; distances: number[] } {
    if (!raw) return { labels: [], distances: [] };
    if (Array.isArray(raw) && raw.length >= 2) {
        return { labels: Array.from(raw[0] ?? []), distances: Array.from(raw[1] ?? []) };
    }
    const labels = raw.labels ?? raw.neighbors ?? raw.ids ?? raw[0];
    const distances = raw.distances ?? raw.scores ?? raw[1];
    return {
        labels: Array.isArray(labels) ? labels : Array.from(labels ?? []),
        distances: Array.isArray(distances) ? distances : Array.from(distances ?? [])
    };
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
