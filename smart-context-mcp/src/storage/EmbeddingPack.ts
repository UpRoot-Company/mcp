import * as fs from "fs";
import * as path from "path";
import { LRUCache } from "lru-cache";
import type { EmbeddingKey, StoredEmbedding } from "./IndexStore.js";
import { PathManager } from "../utils/PathManager.js";

export type EmbeddingPackFormat = "float32" | "q8" | "both";

export type EmbeddingPackMeta = {
    version: 1;
    provider: string;
    model: string;
    dims: number;
    format: EmbeddingPackFormat;
    count: number;
    createdAt: string;
    updatedAt: string;
};

export type EmbeddingPackIndexV1 = {
    version: 1;
    provider: string;
    model: string;
    dims: number;
    format: EmbeddingPackFormat;
    f32?: Record<string, number>;
    q8?: Record<string, number>;
};

export type EmbeddingPackConfig = {
    enabled: boolean;
    format: EmbeddingPackFormat;
    rebuild: "auto" | "on_start" | "manual";
    index: "json" | "bin";
    cacheBytes: number;
};

export function resolveEmbeddingPackConfigFromEnv(): EmbeddingPackConfig {
    const rawFormat = (process.env.SMART_CONTEXT_EMBEDDING_PACK_FORMAT ?? "").trim().toLowerCase();
    const format: EmbeddingPackFormat = rawFormat === "q8" ? "q8" : (rawFormat === "both" ? "both" : "float32");
    const enabled = rawFormat.length > 0;

    const rebuildRaw = (process.env.SMART_CONTEXT_EMBEDDING_PACK_REBUILD ?? "auto").trim().toLowerCase();
    const rebuild = rebuildRaw === "on_start" ? "on_start" : (rebuildRaw === "manual" ? "manual" : "auto");

    const indexRaw = (process.env.SMART_CONTEXT_EMBEDDING_PACK_INDEX ?? "json").trim().toLowerCase();
    const index = indexRaw === "bin" ? "bin" : "json";

    const cacheMbRaw = (process.env.SMART_CONTEXT_VECTOR_CACHE_MB ?? "128").trim();
    const cacheMb = cacheMbRaw.length > 0 ? Number.parseInt(cacheMbRaw, 10) : 128;
    const cacheBytes = Number.isFinite(cacheMb) && cacheMb > 0 ? cacheMb * 1024 * 1024 : 128 * 1024 * 1024;

    return { enabled, format, rebuild, index, cacheBytes };
}

export function resolveEmbeddingPackDir(key: EmbeddingKey): string {
    return path.join(PathManager.getStorageDir(), "v1", "embeddings", key.provider, key.model);
}

type PackPaths = {
    dir: string;
    metaPath: string;
    indexPath: string;
    tombstonesPath: string;
    readyPath: string;
    indexBinPath: string;
    f32Path: string;
    q8Path: string;
};

function getPackPaths(key: EmbeddingKey): PackPaths {
    const dir = resolveEmbeddingPackDir(key);
    return {
        dir,
        metaPath: path.join(dir, "meta.json"),
        indexPath: path.join(dir, "embeddings.index.json"),
        tombstonesPath: path.join(dir, "tombstones.json"),
        readyPath: path.join(dir, "ready.json"),
        indexBinPath: path.join(dir, "embeddings.index.bin"),
        f32Path: path.join(dir, "embeddings.f32.bin"),
        q8Path: path.join(dir, "embeddings.q8.bin")
    };
}

function readJson<T>(filePath: string, fallback: T): T {
    try {
        if (!fs.existsSync(filePath)) return fallback;
        const raw = fs.readFileSync(filePath, "utf8");
        if (!raw.trim()) return fallback;
        return JSON.parse(raw) as T;
    } catch {
        return fallback;
    }
}

function writeJsonAtomic(filePath: string, value: unknown): void {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmpPath, JSON.stringify(value));
    fs.renameSync(tmpPath, filePath);
}

export function quantizeQ8(vector: Float32Array): { q: Int8Array; scale: number } {
    let maxAbs = 0;
    for (let i = 0; i < vector.length; i++) {
        const v = Math.abs(vector[i]);
        if (v > maxAbs) maxAbs = v;
    }
    const scale = maxAbs > 0 ? maxAbs / 127 : 1;
    const q = new Int8Array(vector.length);
    for (let i = 0; i < vector.length; i++) {
        const scaled = vector[i] / scale;
        const rounded = Math.round(scaled);
        const clamped = Math.max(-127, Math.min(127, rounded));
        q[i] = clamped;
    }
    return { q, scale };
}

export function dequantizeQ8(q: Int8Array, scale: number): Float32Array {
    const out = new Float32Array(q.length);
    for (let i = 0; i < q.length; i++) {
        out[i] = q[i] * scale;
    }
    return out;
}

export class EmbeddingPackManager {
    private readonly key: EmbeddingKey;
    private readonly config: EmbeddingPackConfig;
    private readonly paths: PackPaths;
    private meta: EmbeddingPackMeta | null = null;
    private index: EmbeddingPackIndexV1 | null = null;
    private tombstones: Set<string> | null = null;
    private f32Fd: number | null = null;
    private q8Fd: number | null = null;
    private f32Size = 0;
    private q8Size = 0;
    private dirtyIndex = false;
    private dirtyMeta = false;
    private flushTimer: NodeJS.Timeout | null = null;

    private readonly cache: LRUCache<string, StoredEmbedding>;

    constructor(key: EmbeddingKey, config: EmbeddingPackConfig) {
        this.key = key;
        this.config = config;
        this.paths = getPackPaths(key);
        this.cache = new LRUCache<string, StoredEmbedding>({
            maxSize: config.cacheBytes,
            sizeCalculation: (value) => value.vector.byteLength + 256
        });
    }

    public isEnabled(): boolean {
        return this.config.enabled;
    }

    public hasPackOnDisk(): boolean {
        return fs.existsSync(this.paths.metaPath) && (fs.existsSync(this.paths.f32Path) || fs.existsSync(this.paths.q8Path));
    }

    public isReadyOnDisk(): boolean {
        return fs.existsSync(this.paths.readyPath);
    }

    public markReady(): void {
        if (this.isReadyOnDisk()) return;
        writeJsonAtomic(this.paths.readyPath, { readyAt: new Date().toISOString(), version: 1 });
    }

    public ensureLoaded(dimsHint?: number): void {
        if (!this.config.enabled) return;
        fs.mkdirSync(this.paths.dir, { recursive: true });

        if (!this.meta) {
            const meta = readJson<EmbeddingPackMeta | null>(this.paths.metaPath, null);
            if (meta && meta.version === 1 && meta.provider === this.key.provider && meta.model === this.key.model) {
                this.meta = meta;
            } else if (dimsHint && dimsHint > 0) {
                const now = new Date().toISOString();
                this.meta = {
                    version: 1,
                    provider: this.key.provider,
                    model: this.key.model,
                    dims: dimsHint,
                    format: this.config.format,
                    count: 0,
                    createdAt: now,
                    updatedAt: now
                };
                this.dirtyMeta = true;
            }
        }

        if (!this.index) {
            const loaded = this.loadIndexFromDisk(dimsHint);
            if (loaded) {
                this.index = loaded;
            } else {
                this.index = {
                    version: 1,
                    provider: this.key.provider,
                    model: this.key.model,
                    dims: this.meta?.dims ?? (dimsHint ?? 0),
                    format: this.config.format,
                    f32: this.config.format === "q8" ? undefined : {},
                    q8: this.config.format === "float32" ? undefined : {}
                };
                this.dirtyIndex = true;
            }
        }

        if (!this.tombstones) {
            const list = readJson<string[]>(this.paths.tombstonesPath, []);
            this.tombstones = new Set(list.filter(Boolean));
        }

        if (this.f32Fd === null && this.config.format !== "q8") {
            this.f32Fd = fs.openSync(this.paths.f32Path, "a+");
            this.f32Size = fs.existsSync(this.paths.f32Path) ? fs.statSync(this.paths.f32Path).size : 0;
        }
        if (this.q8Fd === null && this.config.format !== "float32") {
            this.q8Fd = fs.openSync(this.paths.q8Path, "a+");
            this.q8Size = fs.existsSync(this.paths.q8Path) ? fs.statSync(this.paths.q8Path).size : 0;
        }
    }

    public upsertEmbedding(chunkId: string, embedding: { dims: number; vector: Float32Array; norm?: number }): void {
        if (!this.config.enabled) return;
        this.ensureLoaded(embedding.dims);
        if (!this.meta || !this.index) return;
        if (this.meta.dims && embedding.dims !== this.meta.dims) {
            return;
        }

        const now = new Date().toISOString();
        this.meta.updatedAt = now;
        this.dirtyMeta = true;

        const idBuf = Buffer.from(chunkId, "utf8");
        this.tombstones?.delete(chunkId);

        if (this.config.format !== "q8") {
            const fd = this.f32Fd;
            if (fd === null) throw new Error("f32 pack not open");
            const recordSize = 4 + idBuf.length + 4 + (this.meta.dims * 4);
            const buf = Buffer.allocUnsafe(recordSize);
            let off = 0;
            buf.writeUInt32LE(idBuf.length, off); off += 4;
            idBuf.copy(buf, off); off += idBuf.length;
            buf.writeFloatLE(embedding.norm ?? 0, off); off += 4;
            const vecBytes = Buffer.from(embedding.vector.buffer, embedding.vector.byteOffset, embedding.vector.byteLength);
            vecBytes.copy(buf, off); off += vecBytes.length;
            const offset = this.f32Size;
            fs.writeSync(fd, buf);
            this.f32Size += buf.length;
            if (!this.index.f32) this.index.f32 = {};
            this.index.f32[chunkId] = offset;
            this.dirtyIndex = true;
        }

        if (this.config.format !== "float32") {
            const fd = this.q8Fd;
            if (fd === null) throw new Error("q8 pack not open");
            const { q, scale } = quantizeQ8(embedding.vector);
            const recordSize = 4 + idBuf.length + 4 + this.meta.dims;
            const buf = Buffer.allocUnsafe(recordSize);
            let off = 0;
            buf.writeUInt32LE(idBuf.length, off); off += 4;
            idBuf.copy(buf, off); off += idBuf.length;
            buf.writeFloatLE(scale, off); off += 4;
            const qBuf = Buffer.from(q.buffer, q.byteOffset, q.byteLength);
            qBuf.copy(buf, off); off += qBuf.length;
            const offset = this.q8Size;
            fs.writeSync(fd, buf);
            this.q8Size += buf.length;
            if (!this.index.q8) this.index.q8 = {};
            this.index.q8[chunkId] = offset;
            this.dirtyIndex = true;
        }

        this.cache.delete(chunkId);
        this.scheduleFlush();
    }

    public deleteEmbedding(chunkId: string): void {
        if (!this.config.enabled) return;
        this.ensureLoaded();
        if (!this.index || !this.tombstones) return;
        this.tombstones.add(chunkId);
        if (this.index.f32) delete this.index.f32[chunkId];
        if (this.index.q8) delete this.index.q8[chunkId];
        this.dirtyIndex = true;
        this.cache.delete(chunkId);
        this.scheduleFlush();
    }

    public getEmbedding(chunkId: string): StoredEmbedding | null {
        if (!this.config.enabled) return null;
        this.ensureLoaded();
        if (this.tombstones?.has(chunkId)) return null;
        const cached = this.cache.get(chunkId);
        if (cached) return { ...cached, vector: new Float32Array(cached.vector) };
        if (!this.meta || !this.index) return null;

        const prefersF32 = this.config.format !== "q8";
        const result = prefersF32
            ? (this.readF32Embedding(chunkId) ?? this.readQ8Embedding(chunkId))
            : (this.readQ8Embedding(chunkId) ?? this.readF32Embedding(chunkId));

        if (!result) return null;
        this.cache.set(chunkId, result);
        return { ...result, vector: new Float32Array(result.vector) };
    }

    public listEmbeddings(limit?: number): StoredEmbedding[] {
        if (!this.config.enabled) return [];
        this.ensureLoaded();
        if (!this.meta || !this.index) return [];
        const max = Number.isFinite(limit) && (limit as number) > 0 ? Math.floor(limit as number) : undefined;
        const results: StoredEmbedding[] = [];
        const preferF32 = this.config.format !== "q8";
        const map = preferF32 ? (this.index.f32 ?? {}) : (this.index.q8 ?? {});
        for (const chunkId of Object.keys(map)) {
            if (this.tombstones?.has(chunkId)) continue;
            const embedding = this.getEmbedding(chunkId);
            if (!embedding) continue;
            results.push(embedding);
            if (max && results.length >= max) break;
        }
        return results;
    }

    public iterateEmbeddings(
        visitor: (embedding: StoredEmbedding) => void,
        options?: { limit?: number }
    ): void {
        if (!this.config.enabled) return;
        this.ensureLoaded();
        if (!this.meta) return;
        const limit = options?.limit && options.limit > 0 ? Math.floor(options.limit) : undefined;
        const preferF32 = this.config.format !== "q8";
        if (preferF32 && fs.existsSync(this.paths.f32Path)) {
            this.scanF32(visitor, limit);
            return;
        }
        if (fs.existsSync(this.paths.q8Path)) {
            this.scanQ8(visitor, limit);
        }
    }

    public flush(): void {
        if (!this.config.enabled) return;
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        if (this.meta && this.index) {
            const count = this.index.f32
                ? Object.keys(this.index.f32).length
                : (this.index.q8 ? Object.keys(this.index.q8).length : 0);
            this.meta.count = count;
        }
        if (this.dirtyIndex && this.index) {
            if (this.config.index === "bin") {
                this.writeIndexBin(this.index);
            } else {
                writeJsonAtomic(this.paths.indexPath, this.index);
            }
            this.dirtyIndex = false;
        }
        if (this.tombstones) {
            writeJsonAtomic(this.paths.tombstonesPath, Array.from(this.tombstones));
        }
        if (this.dirtyMeta && this.meta) {
            writeJsonAtomic(this.paths.metaPath, this.meta);
            this.dirtyMeta = false;
        }
    }

    public close(): void {
        this.flush();
        if (this.f32Fd !== null) {
            try { fs.closeSync(this.f32Fd); } catch { /* ignore */ }
            this.f32Fd = null;
        }
        if (this.q8Fd !== null) {
            try { fs.closeSync(this.q8Fd); } catch { /* ignore */ }
            this.q8Fd = null;
        }
    }

    private scheduleFlush(): void {
        if (this.flushTimer) return;
        this.flushTimer = setTimeout(() => {
            this.flush();
        }, 500);
    }

    private loadIndexFromDisk(dimsHint?: number): EmbeddingPackIndexV1 | null {
        const dims = this.meta?.dims ?? dimsHint ?? 0;
        if (this.config.index === "bin") {
            const binIndex = this.readIndexBin(dims);
            if (binIndex) return binIndex;
        }
        const index = readJson<EmbeddingPackIndexV1 | null>(this.paths.indexPath, null);
        if (index && index.version === 1 && index.provider === this.key.provider && index.model === this.key.model) {
            return index;
        }
        return null;
    }

    private readIndexBin(dims: number): EmbeddingPackIndexV1 | null {
        if (!fs.existsSync(this.paths.indexBinPath)) return null;
        try {
            const raw = fs.readFileSync(this.paths.indexBinPath);
            if (raw.length < 16) return null;
            const magic = raw.subarray(0, 4).toString("ascii");
            if (magic !== "SCIX") return null;
            const version = raw.readUInt32LE(4);
            if (version !== 1) return null;
            const flags = raw.readUInt32LE(8);
            const recordCount = raw.readUInt32LE(12);
            const index: EmbeddingPackIndexV1 = {
                version: 1,
                provider: this.key.provider,
                model: this.key.model,
                dims,
                format: flags === 3 ? "both" : (flags === 2 ? "q8" : "float32"),
                f32: (flags & 1) ? {} : undefined,
                q8: (flags & 2) ? {} : undefined
            };
            let offset = 16;
            for (let i = 0; i < recordCount; i += 1) {
                if (offset + 4 > raw.length) break;
                const keyLen = raw.readUInt32LE(offset);
                offset += 4;
                if (offset + keyLen + 12 > raw.length) break;
                const key = raw.subarray(offset, offset + keyLen).toString("utf8");
                offset += keyLen;
                const kind = raw.readUInt8(offset);
                offset += 1;
                offset += 1; // reserved
                offset += 2; // reserved
                const off64 = raw.readBigUInt64LE(offset);
                offset += 8;
                if (off64 > BigInt(Number.MAX_SAFE_INTEGER)) {
                    continue;
                }
                const offNum = Number(off64);
                if (kind === 0) {
                    if (!index.f32) index.f32 = {};
                    index.f32[key] = offNum;
                } else if (kind === 1) {
                    if (!index.q8) index.q8 = {};
                    index.q8[key] = offNum;
                }
            }
            return index;
        } catch {
            return null;
        }
    }

    private writeIndexBin(index: EmbeddingPackIndexV1): void {
        const dir = path.dirname(this.paths.indexBinPath);
        fs.mkdirSync(dir, { recursive: true });
        const tmpPath = `${this.paths.indexBinPath}.tmp-${process.pid}-${Date.now()}`;
        const fd = fs.openSync(tmpPath, "w");
        try {
            const formatFlags = index.format === "both" ? 3 : (index.format === "q8" ? 2 : 1);
            const f32Keys = index.f32 ? Object.keys(index.f32) : [];
            const q8Keys = index.q8 ? Object.keys(index.q8) : [];
            const recordCount = f32Keys.length + q8Keys.length;
            const header = Buffer.allocUnsafe(16);
            header.write("SCIX", 0, "ascii");
            header.writeUInt32LE(1, 4);
            header.writeUInt32LE(formatFlags, 8);
            header.writeUInt32LE(recordCount, 12);
            fs.writeSync(fd, header);

            const writeRecord = (key: string, kind: number, offsetValue: number) => {
                const keyBuf = Buffer.from(key, "utf8");
                const buf = Buffer.allocUnsafe(4 + keyBuf.length + 1 + 1 + 2 + 8);
                let off = 0;
                buf.writeUInt32LE(keyBuf.length, off); off += 4;
                keyBuf.copy(buf, off); off += keyBuf.length;
                buf.writeUInt8(kind, off); off += 1;
                buf.writeUInt8(0, off); off += 1;
                buf.writeUInt16LE(0, off); off += 2;
                const offset64 = BigInt(Math.max(0, Math.floor(offsetValue)));
                buf.writeBigUInt64LE(offset64, off);
                fs.writeSync(fd, buf);
            };

            for (const key of f32Keys) {
                const offsetValue = index.f32?.[key];
                if (typeof offsetValue !== "number") continue;
                writeRecord(key, 0, offsetValue);
            }
            for (const key of q8Keys) {
                const offsetValue = index.q8?.[key];
                if (typeof offsetValue !== "number") continue;
                writeRecord(key, 1, offsetValue);
            }
        } finally {
            try { fs.closeSync(fd); } catch { /* ignore */ }
        }
        fs.renameSync(tmpPath, this.paths.indexBinPath);
    }

    private readF32Embedding(chunkId: string): StoredEmbedding | null {
        if (!this.meta || !this.index?.f32) return null;
        const offset = this.index.f32[chunkId];
        if (!Number.isFinite(offset)) return null;
        const fd = this.f32Fd ?? fs.openSync(this.paths.f32Path, "r");
        const idLenBuf = Buffer.allocUnsafe(4);
        fs.readSync(fd, idLenBuf, 0, 4, offset);
        const idLen = idLenBuf.readUInt32LE(0);
        const idBuf = Buffer.allocUnsafe(idLen);
        fs.readSync(fd, idBuf, 0, idLen, offset + 4);
        const normBuf = Buffer.allocUnsafe(4);
        fs.readSync(fd, normBuf, 0, 4, offset + 4 + idLen);
        const norm = normBuf.readFloatLE(0);
        const vecBuf = Buffer.allocUnsafe(this.meta.dims * 4);
        fs.readSync(fd, vecBuf, 0, vecBuf.length, offset + 4 + idLen + 4);
        const vector = new Float32Array(vecBuf.buffer, vecBuf.byteOffset, this.meta.dims);
        return {
            chunkId,
            provider: this.key.provider,
            model: this.key.model,
            dims: this.meta.dims,
            vector: new Float32Array(vector),
            norm: norm || undefined
        };
    }

    private readQ8Embedding(chunkId: string): StoredEmbedding | null {
        if (!this.meta || !this.index?.q8) return null;
        const offset = this.index.q8[chunkId];
        if (!Number.isFinite(offset)) return null;
        const fd = this.q8Fd ?? fs.openSync(this.paths.q8Path, "r");
        const idLenBuf = Buffer.allocUnsafe(4);
        fs.readSync(fd, idLenBuf, 0, 4, offset);
        const idLen = idLenBuf.readUInt32LE(0);
        const idBuf = Buffer.allocUnsafe(idLen);
        fs.readSync(fd, idBuf, 0, idLen, offset + 4);
        const scaleBuf = Buffer.allocUnsafe(4);
        fs.readSync(fd, scaleBuf, 0, 4, offset + 4 + idLen);
        const scale = scaleBuf.readFloatLE(0);
        const qBuf = Buffer.allocUnsafe(this.meta.dims);
        fs.readSync(fd, qBuf, 0, qBuf.length, offset + 4 + idLen + 4);
        const q = new Int8Array(qBuf.buffer, qBuf.byteOffset, this.meta.dims);
        const vector = dequantizeQ8(q, scale);
        return {
            chunkId,
            provider: this.key.provider,
            model: this.key.model,
            dims: this.meta.dims,
            vector
        };
    }

    private scanF32(visitor: (embedding: StoredEmbedding) => void, limit?: number): void {
        if (!this.meta) return;
        if (!fs.existsSync(this.paths.f32Path)) return;
        const fd = fs.openSync(this.paths.f32Path, "r");
        try {
            const size = fs.statSync(this.paths.f32Path).size;
            let offset = 0;
            let count = 0;
            const idLenBuf = Buffer.allocUnsafe(4);
            const normBuf = Buffer.allocUnsafe(4);
            while (offset < size) {
                if (limit && count >= limit) break;
                fs.readSync(fd, idLenBuf, 0, 4, offset);
                const idLen = idLenBuf.readUInt32LE(0);
                const idBuf = Buffer.allocUnsafe(idLen);
                fs.readSync(fd, idBuf, 0, idLen, offset + 4);
                const chunkId = idBuf.toString("utf8");
                if (this.tombstones?.has(chunkId)) {
                    offset += 4 + idLen + 4 + (this.meta.dims * 4);
                    continue;
                }
                fs.readSync(fd, normBuf, 0, 4, offset + 4 + idLen);
                const norm = normBuf.readFloatLE(0);
                const vecBuf = Buffer.allocUnsafe(this.meta.dims * 4);
                fs.readSync(fd, vecBuf, 0, vecBuf.length, offset + 4 + idLen + 4);
                const vector = new Float32Array(vecBuf.buffer, vecBuf.byteOffset, this.meta.dims);
                visitor({
                    chunkId,
                    provider: this.key.provider,
                    model: this.key.model,
                    dims: this.meta.dims,
                    vector: new Float32Array(vector),
                    norm: norm || undefined
                });
                offset += 4 + idLen + 4 + vecBuf.length;
                count++;
            }
        } finally {
            try { fs.closeSync(fd); } catch { /* ignore */ }
        }
    }

    private scanQ8(visitor: (embedding: StoredEmbedding) => void, limit?: number): void {
        if (!this.meta) return;
        if (!fs.existsSync(this.paths.q8Path)) return;
        const fd = fs.openSync(this.paths.q8Path, "r");
        try {
            const size = fs.statSync(this.paths.q8Path).size;
            let offset = 0;
            let count = 0;
            const idLenBuf = Buffer.allocUnsafe(4);
            const scaleBuf = Buffer.allocUnsafe(4);
            while (offset < size) {
                if (limit && count >= limit) break;
                fs.readSync(fd, idLenBuf, 0, 4, offset);
                const idLen = idLenBuf.readUInt32LE(0);
                const idBuf = Buffer.allocUnsafe(idLen);
                fs.readSync(fd, idBuf, 0, idLen, offset + 4);
                const chunkId = idBuf.toString("utf8");
                if (this.tombstones?.has(chunkId)) {
                    offset += 4 + idLen + 4 + this.meta.dims;
                    continue;
                }
                fs.readSync(fd, scaleBuf, 0, 4, offset + 4 + idLen);
                const scale = scaleBuf.readFloatLE(0);
                const qBuf = Buffer.allocUnsafe(this.meta.dims);
                fs.readSync(fd, qBuf, 0, qBuf.length, offset + 4 + idLen + 4);
                const q = new Int8Array(qBuf.buffer, qBuf.byteOffset, this.meta.dims);
                visitor({
                    chunkId,
                    provider: this.key.provider,
                    model: this.key.model,
                    dims: this.meta.dims,
                    vector: dequantizeQ8(q, scale)
                });
                offset += 4 + idLen + 4 + qBuf.length;
                count++;
            }
        } finally {
            try { fs.closeSync(fd); } catch { /* ignore */ }
        }
    }
}
