import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import { PathManager } from "../../utils/PathManager.js";
import { IndexDatabase } from "../../indexing/IndexDatabase.js";
import { EmbeddingRepository } from "../../indexing/EmbeddingRepository.js";
import { VectorIndexManager } from "../../vector/VectorIndexManager.js";

let tempDir: string;
let prevStorage: string | undefined;
let prevIndex: string | undefined;
let prevRebuild: string | undefined;
let prevShards: string | undefined;

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "smart-context-vector-shards-"));
    PathManager.setRoot(tempDir);
    prevStorage = process.env.SMART_CONTEXT_STORAGE_MODE;
    prevIndex = process.env.SMART_CONTEXT_VECTOR_INDEX;
    prevRebuild = process.env.SMART_CONTEXT_VECTOR_INDEX_REBUILD;
    prevShards = process.env.SMART_CONTEXT_VECTOR_INDEX_SHARDS;
    process.env.SMART_CONTEXT_STORAGE_MODE = "memory";
});

afterEach(() => {
    if (prevStorage === undefined) delete process.env.SMART_CONTEXT_STORAGE_MODE;
    else process.env.SMART_CONTEXT_STORAGE_MODE = prevStorage;
    if (prevIndex === undefined) delete process.env.SMART_CONTEXT_VECTOR_INDEX;
    else process.env.SMART_CONTEXT_VECTOR_INDEX = prevIndex;
    if (prevRebuild === undefined) delete process.env.SMART_CONTEXT_VECTOR_INDEX_REBUILD;
    else process.env.SMART_CONTEXT_VECTOR_INDEX_REBUILD = prevRebuild;
    if (prevShards === undefined) delete process.env.SMART_CONTEXT_VECTOR_INDEX_SHARDS;
    else process.env.SMART_CONTEXT_VECTOR_INDEX_SHARDS = prevShards;
    fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("VectorIndexManager shards", () => {
    it("builds and searches across shards", async () => {
        process.env.SMART_CONTEXT_VECTOR_INDEX = "hnsw";
        process.env.SMART_CONTEXT_VECTOR_INDEX_REBUILD = "manual";
        process.env.SMART_CONTEXT_VECTOR_INDEX_SHARDS = "2";

        const indexDb = new IndexDatabase(tempDir);
        const embeddingRepo = new EmbeddingRepository(indexDb);
        embeddingRepo.upsertEmbedding("chunk-a", {
            provider: "local",
            model: "test-model",
            dims: 2,
            vector: new Float32Array([1, 0])
        });
        embeddingRepo.upsertEmbedding("chunk-b", {
            provider: "local",
            model: "test-model",
            dims: 2,
            vector: new Float32Array([0, 1])
        });

        const manager = new VectorIndexManager(tempDir, embeddingRepo);
        await manager.rebuildFromRepository("local", "test-model");

        const result = await manager.search(new Float32Array([1, 0]), {
            provider: "local",
            model: "test-model",
            k: 1
        });

        expect(result.degraded).toBe(false);
        expect(result.backend).toBe("hnsw");
        expect(result.ids[0]).toBe("chunk-a");
        indexDb.close();
    }, 30000);
});

