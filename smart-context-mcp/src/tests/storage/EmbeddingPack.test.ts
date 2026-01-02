import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import { PathManager } from "../../utils/PathManager.js";
import { EmbeddingPackManager, resolveEmbeddingPackConfigFromEnv } from "../../storage/EmbeddingPack.js";

let tempDir: string;
let prevFormat: string | undefined;
let prevCache: string | undefined;

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "smart-context-pack-"));
    PathManager.setRoot(tempDir);
    prevFormat = process.env.SMART_CONTEXT_EMBEDDING_PACK_FORMAT;
    prevCache = process.env.SMART_CONTEXT_VECTOR_CACHE_MB;
    process.env.SMART_CONTEXT_VECTOR_CACHE_MB = "16";
});

afterEach(() => {
    if (prevFormat === undefined) delete process.env.SMART_CONTEXT_EMBEDDING_PACK_FORMAT;
    else process.env.SMART_CONTEXT_EMBEDDING_PACK_FORMAT = prevFormat;
    if (prevCache === undefined) delete process.env.SMART_CONTEXT_VECTOR_CACHE_MB;
    else process.env.SMART_CONTEXT_VECTOR_CACHE_MB = prevCache;
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
});

