import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import { NodeFileSystem } from "../../platform/FileSystem.js";
import { IndexDatabase } from "../../indexing/IndexDatabase.js";
import { DocumentIndexer } from "../../indexing/DocumentIndexer.js";
import { DocumentChunkRepository } from "../../indexing/DocumentChunkRepository.js";
import { EmbeddingRepository } from "../../indexing/EmbeddingRepository.js";
import { EmbeddingProviderFactory } from "../../embeddings/EmbeddingProviderFactory.js";
import { PathManager } from "../../utils/PathManager.js";

let tempDir: string;
let previousEnv: string | undefined;

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "smart-context-doc-embed-"));
    PathManager.setRoot(tempDir);
    fs.mkdirSync(path.join(tempDir, "docs"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "docs", "notes.md"), "# Notes\n\n## Intro\nEager embedding test.");
    previousEnv = process.env.SMART_CONTEXT_DOCS_EMBEDDINGS_EAGER;
    process.env.SMART_CONTEXT_DOCS_EMBEDDINGS_EAGER = "true";
});

afterEach(() => {
    if (previousEnv === undefined) {
        delete process.env.SMART_CONTEXT_DOCS_EMBEDDINGS_EAGER;
    } else {
        process.env.SMART_CONTEXT_DOCS_EMBEDDINGS_EAGER = previousEnv;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("DocumentIndexer eager embeddings", () => {
    it("stores embeddings when eager flag is enabled", async () => {
        const fileSystem = new NodeFileSystem(tempDir);
        const indexDatabase = new IndexDatabase(tempDir);
        const embeddingRepository = new EmbeddingRepository(indexDatabase);
        const embeddingFactory = new EmbeddingProviderFactory({
            provider: "local",
            normalize: true,
            local: { model: "hash-eager-test", dims: 24 }
        });
        const documentIndexer = new DocumentIndexer(tempDir, fileSystem, indexDatabase, {
            embeddingRepository,
            embeddingProviderFactory: embeddingFactory
        });

        await documentIndexer.indexFile("docs/notes.md");

        const chunkRepo = new DocumentChunkRepository(indexDatabase);
        const chunks = chunkRepo.listChunksForFile("docs/notes.md");
        expect(chunks.length).toBeGreaterThan(0);

        const stored = embeddingRepository.getEmbedding(chunks[0].id, "local", "hash-eager-test");
        expect(stored).toBeTruthy();
        expect(stored?.dims).toBe(24);

        indexDatabase.close();
    });
});
