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
        const useScvx = await isScvxIndex(indexPath);
        this.index = useScvx ? new PersistedBruteforceIndex(this.space, this.dims) : await createIndex(this.space, this.dims);
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
    try {
        const module = (await import("hnswlib-wasm")) as HnswModule;
        const ctor = module?.HierarchicalNSW ?? module?.default?.HierarchicalNSW;
        if (!ctor) {
            throw new Error("Failed to load hnswlib-wasm");
        }
        return new ctor(space, dims);
    } catch {
        // Offline-first fallback: provide a pure JS brute-force index that supports persistence,
        // so the "hnsw" backend remains functional even when the optional ANN module is unavailable.
        return new PersistedBruteforceIndex(space, dims);
    }
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

async function isScvxIndex(filePath: string): Promise<boolean> {
    let handle: fs.FileHandle | null = null;
    try {
        handle = await fs.open(filePath, "r");
        const buffer = Buffer.alloc(4);
        const { bytesRead } = await handle.read(buffer, 0, 4, 0);
        if (bytesRead < 4) return false;
        return buffer.toString("ascii") === "SCVX";
    } catch {
        return false;
    } finally {
        if (handle) {
            await handle.close();
        }
    }
}

class PersistedBruteforceIndex implements HnswIndex {
    private readonly space: string;
    private readonly dims: number;
    private maxElements = 0;
    private vectors: Float32Array = new Float32Array(0);
    private norms: Float32Array = new Float32Array(0);
    private deleted: Uint8Array = new Uint8Array(0);

    constructor(space: string, dims: number) {
        this.space = space;
        this.dims = dims;
    }

    public initIndex(maxElements: number): void {
        this.maxElements = Math.max(1, Math.floor(maxElements));
        this.vectors = new Float32Array(this.maxElements * this.dims);
        this.norms = new Float32Array(this.maxElements);
        this.deleted = new Uint8Array(this.maxElements);
    }

    public addPoint(vector: Float32Array, label: number): void {
        if (!this.vectors.length) return;
        if (label < 0 || label >= this.maxElements) return;
        const base = label * this.dims;
        let norm = 0;
        for (let i = 0; i < this.dims; i += 1) {
            const v = vector[i] ?? 0;
            this.vectors[base + i] = v;
            norm += v * v;
        }
        this.norms[label] = Math.sqrt(norm);
        this.deleted[label] = 0;
    }

    public markDelete(label: number): void {
        if (label < 0 || label >= this.maxElements) return;
        this.deleted[label] = 1;
    }

    public deletePoint(label: number): void {
        this.markDelete(label);
    }

    public setEf(_ef: number): void {}

    public getCurrentCount(): number {
        if (!this.deleted.length) return 0;
        let count = 0;
        for (let i = 0; i < this.deleted.length; i += 1) {
            if (this.deleted[i] === 0 && this.norms[i] > 0) count += 1;
        }
        return count;
    }

    public searchKnn(query: Float32Array, k: number): { labels: number[]; distances: number[] } {
        if (!this.vectors.length) return { labels: [], distances: [] };
        const topK = Math.max(0, Math.floor(k));
        if (topK === 0) return { labels: [], distances: [] };

        let queryNorm = 0;
        for (let i = 0; i < this.dims; i += 1) {
            const v = query[i] ?? 0;
            queryNorm += v * v;
        }
        queryNorm = Math.sqrt(queryNorm) || 1;

        const candidates: Array<{ label: number; score: number }> = [];
        for (let label = 0; label < this.maxElements; label += 1) {
            if (this.deleted[label] === 1) continue;
            const vecNorm = this.norms[label];
            if (!vecNorm) continue;
            const base = label * this.dims;
            let dot = 0;
            for (let i = 0; i < this.dims; i += 1) {
                dot += (this.vectors[base + i] ?? 0) * (query[i] ?? 0);
            }
            let score = dot;
            if (this.space === "cosine") {
                score = dot / (vecNorm * queryNorm);
            }
            candidates.push({ label, score });
        }

        candidates.sort((a, b) => b.score - a.score);
        const labels = candidates.slice(0, topK).map(c => c.label);
        const distances = candidates.slice(0, topK).map(c => (this.space === "cosine" ? 1 - c.score : c.score));
        return { labels, distances };
    }

    public async writeIndex(filePath: string): Promise<void> {
        const header = Buffer.allocUnsafe(16);
        header.write("SCVX", 0, "ascii");
        header.writeUInt32LE(1, 4); // version
        header.writeUInt32LE(this.dims, 8);
        header.writeUInt32LE(this.maxElements, 12);
        const payload = Buffer.concat([
            header,
            Buffer.from(this.vectors.buffer, this.vectors.byteOffset, this.vectors.byteLength),
            Buffer.from(this.norms.buffer, this.norms.byteOffset, this.norms.byteLength),
            Buffer.from(this.deleted.buffer, this.deleted.byteOffset, this.deleted.byteLength)
        ]);
        await fs.writeFile(filePath, payload);
    }

    public async readIndex(filePath: string, maxElements?: number): Promise<void> {
        const raw = await fs.readFile(filePath);
        if (raw.length < 16) {
            throw new Error("Invalid vector index file");
        }
        const magic = raw.subarray(0, 4).toString("ascii");
        if (magic !== "SCVX") {
            throw new Error("Unsupported vector index format");
        }
        const version = raw.readUInt32LE(4);
        if (version !== 1) {
            throw new Error("Unsupported vector index version");
        }
        const dims = raw.readUInt32LE(8);
        const storedMax = raw.readUInt32LE(12);
        if (dims !== this.dims) {
            throw new Error("Vector dims mismatch");
        }
        const effectiveMax = Math.max(storedMax, maxElements ?? 0);
        this.initIndex(effectiveMax);

        const vecBytes = storedMax * this.dims * 4;
        const normsBytes = storedMax * 4;
        const deletedBytes = storedMax;
        const expected = 16 + vecBytes + normsBytes + deletedBytes;
        if (raw.length < expected) {
            throw new Error("Truncated vector index file");
        }
        let offset = 16;
        const vectors = new Float32Array(raw.buffer, raw.byteOffset + offset, storedMax * this.dims);
        this.vectors.set(vectors);
        offset += vecBytes;
        const norms = new Float32Array(raw.buffer, raw.byteOffset + offset, storedMax);
        this.norms.set(norms);
        offset += normsBytes;
        const deleted = new Uint8Array(raw.buffer, raw.byteOffset + offset, storedMax);
        this.deleted.set(deleted);
    }
}
