import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import { NodeFileSystem } from "../../platform/FileSystem.js";
import { SearchEngine } from "../../engine/Search.js";
import { IndexDatabase } from "../../indexing/IndexDatabase.js";
import { DocumentIndexer } from "../../indexing/DocumentIndexer.js";
import { DocumentChunkRepository } from "../../indexing/DocumentChunkRepository.js";
import { EmbeddingRepository } from "../../indexing/EmbeddingRepository.js";
import { EmbeddingProviderFactory } from "../../embeddings/EmbeddingProviderFactory.js";
import { DocumentSearchEngine } from "../../documents/search/DocumentSearchEngine.js";
import { PathManager } from "../../utils/PathManager.js";

let tempDir: string;

beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "smart-context-doc-search-"));
});

afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
});

function setupWorkspace(): string {
    const rootDir = fs.mkdtempSync(path.join(tempDir, "run-"));
    PathManager.setRoot(rootDir);
    fs.mkdirSync(path.join(rootDir, "docs"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "docs", "guide.md"), "# Guide\n\n## Install\nRun npm install to set up.\n\n## Usage\nUse npm start to begin.");
    fs.writeFileSync(path.join(rootDir, "docs", "faq.md"), "# FAQ\n\n## Troubleshooting\nIf install fails, clear cache.");
    return rootDir;
}

describe("DocumentSearchEngine", () => {
    it("returns section results for markdown queries", async () => {
        const rootDir = setupWorkspace();
        const fileSystem = new NodeFileSystem(rootDir);
        const indexDatabase = new IndexDatabase(rootDir);
        const embeddingRepository = new EmbeddingRepository(indexDatabase);
        const documentIndexer = new DocumentIndexer(rootDir, fileSystem, indexDatabase, {
            embeddingRepository
        });
        await documentIndexer.indexFile("docs/guide.md");
        await documentIndexer.indexFile("docs/faq.md");

        const searchEngine = new SearchEngine(rootDir, fileSystem);
        const documentSearchEngine = new DocumentSearchEngine(
            searchEngine,
            documentIndexer,
            new DocumentChunkRepository(indexDatabase),
            embeddingRepository,
            new EmbeddingProviderFactory({
                provider: "local",
                normalize: true,
                local: { model: "hash-test", dims: 64 }
            })
        );

        const response = await documentSearchEngine.search("install", {
            maxResults: 5,
            maxEvidenceSections: 5,
            maxVectorCandidates: 10,
            maxChunksEmbeddedPerRequest: 10
        });

        expect(response.results.length).toBeGreaterThan(0);
        expect(response.results[0].filePath).toBe("docs/guide.md");
        expect(response.results[0].scores.bm25).toBeGreaterThan(0);
        expect(response.stats.vectorEnabled).toBe(true);

        indexDatabase.close();
        await searchEngine.dispose();
        fs.rmSync(rootDir, { recursive: true, force: true });
    });

    it("allows disabling vector search via embedding override", async () => {
        const rootDir = setupWorkspace();
        const fileSystem = new NodeFileSystem(rootDir);
        const indexDatabase = new IndexDatabase(rootDir);
        const embeddingRepository = new EmbeddingRepository(indexDatabase);
        const documentIndexer = new DocumentIndexer(rootDir, fileSystem, indexDatabase, {
            embeddingRepository
        });
        await documentIndexer.indexFile("docs/guide.md");

        const searchEngine = new SearchEngine(rootDir, fileSystem);
        const documentSearchEngine = new DocumentSearchEngine(
            searchEngine,
            documentIndexer,
            new DocumentChunkRepository(indexDatabase),
            embeddingRepository,
            new EmbeddingProviderFactory({
                provider: "local",
                normalize: true,
                local: { model: "hash-test", dims: 32 }
            })
        );

        const response = await documentSearchEngine.search("install", {
            embedding: { provider: "disabled" },
            maxResults: 3
        });

        expect(response.results.length).toBeGreaterThan(0);
        expect(response.stats.vectorEnabled).toBe(false);
        expect(response.provider).toBeNull();

        indexDatabase.close();
        await searchEngine.dispose();
        fs.rmSync(rootDir, { recursive: true, force: true });
    });

    it("uses embedding override model when generating vectors", async () => {
        const rootDir = setupWorkspace();
        const fileSystem = new NodeFileSystem(rootDir);
        const indexDatabase = new IndexDatabase(rootDir);
        const embeddingRepository = new EmbeddingRepository(indexDatabase);
        const documentIndexer = new DocumentIndexer(rootDir, fileSystem, indexDatabase, {
            embeddingRepository
        });
        await documentIndexer.indexFile("docs/guide.md");

        const chunkRepo = new DocumentChunkRepository(indexDatabase);
        const targetChunk = chunkRepo.listChunksForFile("docs/guide.md")
            .find(chunk => chunk.text.toLowerCase().includes("npm install"));
        expect(targetChunk).toBeTruthy();

        const searchEngine = new SearchEngine(rootDir, fileSystem);
        const documentSearchEngine = new DocumentSearchEngine(
            searchEngine,
            documentIndexer,
            chunkRepo,
            embeddingRepository,
            new EmbeddingProviderFactory({
                provider: "local",
                normalize: true,
                local: { model: "hash-test", dims: 32 }
            })
        );

        await documentSearchEngine.search("npm install", {
            maxResults: 3,
            maxVectorCandidates: 1,
            maxChunksEmbeddedPerRequest: 1,
            embedding: {
                provider: "local",
                normalize: false,
                local: { model: "hash-override", dims: 16 }
            }
        });

        const stored = embeddingRepository.getEmbedding(targetChunk!.id, "local", "hash-override");
        expect(stored).toBeTruthy();
        expect(stored?.dims).toBe(16);

        indexDatabase.close();
        await searchEngine.dispose();
        fs.rmSync(rootDir, { recursive: true, force: true });
    });
});
