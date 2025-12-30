import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { IndexDatabase } from "../indexing/IndexDatabase.js";
import { DocumentChunkRepository } from "../indexing/DocumentChunkRepository.js";
import { EmbeddingRepository } from "../indexing/EmbeddingRepository.js";

const makeTempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "smart-context-emb-"));

describe("EmbeddingRepository", () => {
    let rootDir: string;
    let db: IndexDatabase | undefined;

    beforeEach(() => {
        rootDir = makeTempRoot();
        db = new IndexDatabase(rootDir);
    });

    afterEach(() => {
        db?.dispose();
        fs.rmSync(rootDir, { recursive: true, force: true });
    });

    it("round-trips embeddings", () => {
        if (!db) throw new Error("db missing");
        const chunkRepo = new DocumentChunkRepository(db);
        const embRepo = new EmbeddingRepository(db);

        chunkRepo.upsertChunksForFile("docs/readme.md", [
            {
                id: "chunk-1",
                filePath: "docs/readme.md",
                kind: "markdown",
                sectionPath: ["README"],
                heading: "README",
                headingLevel: 1,
                range: { startLine: 1, endLine: 1, startByte: 0, endByte: 8 },
                text: "# README",
                contentHash: "hash-1",
                updatedAt: Date.now()
            }
        ]);

        const vector = new Float32Array([0.1, 0.2, 0.3]);
        embRepo.upsertEmbedding("chunk-1", {
            provider: "local",
            model: "test-model",
            dims: 3,
            vector,
            norm: 1
        });

        const stored = embRepo.getEmbedding("chunk-1", "local", "test-model");
        expect(stored).not.toBeNull();
        expect(stored?.dims).toBe(3);
        const values = Array.from(stored?.vector ?? []);
        expect(values).toHaveLength(3);
        expect(values[0]).toBeCloseTo(0.1, 6);
        expect(values[1]).toBeCloseTo(0.2, 6);
        expect(values[2]).toBeCloseTo(0.3, 6);
    });
});
