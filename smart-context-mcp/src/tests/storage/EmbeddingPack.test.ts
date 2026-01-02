import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import { PathManager } from "../../utils/PathManager.js";
import { EmbeddingPackManager, resolveEmbeddingPackConfigFromEnv } from "../../storage/EmbeddingPack.js";

let tempDir: string;
let prevFormat: string | undefined;
let prevCache: string | undefined;
let prevIndex: string | undefined;

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "smart-context-pack-"));
    PathManager.setRoot(tempDir);
    prevFormat = process.env.SMART_CONTEXT_EMBEDDING_PACK_FORMAT;
    prevCache = process.env.SMART_CONTEXT_VECTOR_CACHE_MB;
    prevIndex = process.env.SMART_CONTEXT_EMBEDDING_PACK_INDEX;
    process.env.SMART_CONTEXT_VECTOR_CACHE_MB = "16";
});

afterEach(() => {
    if (prevFormat === undefined) delete process.env.SMART_CONTEXT_EMBEDDING_PACK_FORMAT;
    else process.env.SMART_CONTEXT_EMBEDDING_PACK_FORMAT = prevFormat;
    if (prevCache === undefined) delete process.env.SMART_CONTEXT_VECTOR_CACHE_MB;
    else process.env.SMART_CONTEXT_VECTOR_CACHE_MB = prevCache;
    if (prevIndex === undefined) delete process.env.SMART_CONTEXT_EMBEDDING_PACK_INDEX;
    else process.env.SMART_CONTEXT_EMBEDDING_PACK_INDEX = prevIndex;
    fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("EmbeddingPackManager", () => {
    it("roundtrips float32 embeddings", () => {
        process.env.SMART_CONTEXT_EMBEDDING_PACK_FORMAT = "float32";
        const config = resolveEmbeddingPackConfigFromEnv();
        const pack = new EmbeddingPackManager({ provider: "local", model: "test-model" }, config);

        pack.upsertEmbedding("chunk-1", { dims: 3, vector: new Float32Array([1, 2, 3]) });
        const got = pack.getEmbedding("chunk-1");
        expect(got).not.toBeNull();
        expect(Array.from(got!.vector)).toEqual([1, 2, 3]);

        pack.deleteEmbedding("chunk-1");
        expect(pack.getEmbedding("chunk-1")).toBeNull();
        pack.close();
    });

    it("roundtrips q8 embeddings with tolerance", () => {
        process.env.SMART_CONTEXT_EMBEDDING_PACK_FORMAT = "q8";
        const config = resolveEmbeddingPackConfigFromEnv();
        const pack = new EmbeddingPackManager({ provider: "local", model: "test-model" }, config);

        const vec = new Float32Array([0.1, -0.2, 0.3, -0.4]);
        pack.upsertEmbedding("chunk-a", { dims: 4, vector: vec });
        const got = pack.getEmbedding("chunk-a");
        expect(got).not.toBeNull();
        const diff = got!.vector.map((v, i) => Math.abs(v - vec[i]));
        expect(Math.max(...diff)).toBeLessThan(0.01);
        pack.close();
    });

    it("iterates q8 embeddings with limit", () => {
        process.env.SMART_CONTEXT_EMBEDDING_PACK_FORMAT = "q8";
        const config = resolveEmbeddingPackConfigFromEnv();
        const pack = new EmbeddingPackManager({ provider: "local", model: "iter-model" }, config);

        pack.upsertEmbedding("chunk-1", { dims: 2, vector: new Float32Array([1, 2]) });
        pack.upsertEmbedding("chunk-2", { dims: 2, vector: new Float32Array([3, 4]) });
        pack.upsertEmbedding("chunk-3", { dims: 2, vector: new Float32Array([5, 6]) });
        pack.markReady();
        pack.close();

        const reopened = new EmbeddingPackManager({ provider: "local", model: "iter-model" }, config);
        const limited: string[] = [];
        reopened.iterateEmbeddings((embedding) => {
            limited.push(embedding.chunkId);
        }, { limit: 2 });
        expect(limited.length).toBe(2);
        for (const id of limited) {
            expect(["chunk-1", "chunk-2", "chunk-3"]).toContain(id);
        }

        const all: string[] = [];
        reopened.iterateEmbeddings((embedding) => {
            all.push(embedding.chunkId);
        });
        expect(all.length).toBe(3);
        reopened.close();
    });

    it("persists index in binary format", () => {
        process.env.SMART_CONTEXT_EMBEDDING_PACK_FORMAT = "float32";
        process.env.SMART_CONTEXT_EMBEDDING_PACK_INDEX = "bin";
        const config = resolveEmbeddingPackConfigFromEnv();
        const pack = new EmbeddingPackManager({ provider: "local", model: "bin-model" }, config);
        pack.upsertEmbedding("chunk-x", { dims: 2, vector: new Float32Array([1, 0]) });
        pack.markReady();
        pack.close();

        const reopened = new EmbeddingPackManager({ provider: "local", model: "bin-model" }, config);
        const got = reopened.getEmbedding("chunk-x");
        expect(got).not.toBeNull();
        expect(Array.from(got!.vector)).toEqual([1, 0]);
        reopened.close();
    });
});
