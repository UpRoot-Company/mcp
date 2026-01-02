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

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "smart-context-vector-"));
    PathManager.setRoot(tempDir);
    prevStorage = process.env.SMART_CONTEXT_STORAGE_MODE;
    prevIndex = process.env.SMART_CONTEXT_VECTOR_INDEX;
    prevRebuild = process.env.SMART_CONTEXT_VECTOR_INDEX_REBUILD;
    process.env.SMART_CONTEXT_STORAGE_MODE = "memory";
});

afterEach(() => {
    if (prevStorage === undefined) {
        delete process.env.SMART_CONTEXT_STORAGE_MODE;
    } else {
        process.env.SMART_CONTEXT_STORAGE_MODE = prevStorage;
    }
    if (prevIndex === undefined) {
        delete process.env.SMART_CONTEXT_VECTOR_INDEX;
    } else {
        process.env.SMART_CONTEXT_VECTOR_INDEX = prevIndex;
    }
    if (prevRebuild === undefined) {
        delete process.env.SMART_CONTEXT_VECTOR_INDEX_REBUILD;
    } else {
        process.env.SMART_CONTEXT_VECTOR_INDEX_REBUILD = prevRebuild;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("VectorIndexManager", () => {
    it("falls back to bruteforce when auto+manual and no index exists", async () => {
        process.env.SMART_CONTEXT_VECTOR_INDEX = "auto";
        process.env.SMART_CONTEXT_VECTOR_INDEX_REBUILD = "manual";

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
        const result = await manager.search(new Float32Array([1, 0]), {
            provider: "local",
            model: "test-model",
            k: 1
        });

        expect(result.backend).toBe("bruteforce");
        expect(result.ids[0]).toBe("chunk-a");
        indexDb.close();
    });

    it("returns unavailable when hnsw+manual and no index exists", async () => {
        process.env.SMART_CONTEXT_VECTOR_INDEX = "hnsw";
        process.env.SMART_CONTEXT_VECTOR_INDEX_REBUILD = "manual";

        const indexDb = new IndexDatabase(tempDir);
        const embeddingRepo = new EmbeddingRepository(indexDb);
        const manager = new VectorIndexManager(tempDir, embeddingRepo);

        const result = await manager.search(new Float32Array([1, 0]), {
            provider: "local",
            model: "test-model",
            k: 1
        });

        expect(result.ids).toHaveLength(0);
        expect(result.degraded).toBe(true);
        expect(result.reason).toBe("vector_index_unavailable");
        indexDb.close();
    });
});
