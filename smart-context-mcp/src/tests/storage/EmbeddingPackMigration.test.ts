import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import { createIndexStore } from "../../storage/IndexStore.js";

let tempDir: string;
let prevRoot: string | undefined;
let prevFormat: string | undefined;
let prevRebuild: string | undefined;

function encodeVector(vector: Float32Array): string {
    const buffer = Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
    return buffer.toString("base64");
}

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "smart-context-pack-migrate-"));
    prevRoot = process.env.SMART_CONTEXT_ROOT;
    prevFormat = process.env.SMART_CONTEXT_EMBEDDING_PACK_FORMAT;
    prevRebuild = process.env.SMART_CONTEXT_EMBEDDING_PACK_REBUILD;
    process.env.SMART_CONTEXT_ROOT = tempDir;
});

afterEach(() => {
    if (prevRoot === undefined) delete process.env.SMART_CONTEXT_ROOT;
    else process.env.SMART_CONTEXT_ROOT = prevRoot;
    if (prevFormat === undefined) delete process.env.SMART_CONTEXT_EMBEDDING_PACK_FORMAT;
    else process.env.SMART_CONTEXT_EMBEDDING_PACK_FORMAT = prevFormat;
    if (prevRebuild === undefined) delete process.env.SMART_CONTEXT_EMBEDDING_PACK_REBUILD;
    else process.env.SMART_CONTEXT_EMBEDDING_PACK_REBUILD = prevRebuild;
    fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("Embedding pack migration", () => {
    it("auto migrates legacy embeddings into a pack", () => {
        const storageDir = path.join(tempDir, ".smart-context", "storage");
        fs.mkdirSync(storageDir, { recursive: true });
        const embeddingsPath = path.join(storageDir, "embeddings.json");
        const payload = {
            "chunk-1": {
                "local::test-model": {
                    provider: "local",
                    model: "test-model",
                    dims: 2,
                    vector: encodeVector(new Float32Array([1, 2]))
                }
            }
        };
        fs.writeFileSync(embeddingsPath, JSON.stringify(payload));

        process.env.SMART_CONTEXT_EMBEDDING_PACK_FORMAT = "float32";
        process.env.SMART_CONTEXT_EMBEDDING_PACK_REBUILD = "auto";

        const store = createIndexStore(tempDir);
        const embedding = store.getEmbedding("chunk-1", { provider: "local", model: "test-model" });
        expect(embedding).not.toBeNull();
        expect(Array.from(embedding!.vector)).toEqual([1, 2]);
        store.close();

        const readyPath = path.join(storageDir, "v1", "embeddings", "local", "test-model", "ready.json");
        expect(fs.existsSync(readyPath)).toBe(true);
    });
});
