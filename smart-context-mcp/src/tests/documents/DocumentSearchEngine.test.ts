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
    PathManager.setRoot(tempDir);
    fs.mkdirSync(path.join(tempDir, "docs"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "docs", "guide.md"), "# Guide\n\n## Install\nRun npm install to set up.\n\n## Usage\nUse npm start to begin.");
    fs.writeFileSync(path.join(tempDir, "docs", "faq.md"), "# FAQ\n\n## Troubleshooting\nIf install fails, clear cache.");
});

afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("DocumentSearchEngine", () => {
    it("returns section results for markdown queries", async () => {
        const fileSystem = new NodeFileSystem(tempDir);
        const indexDatabase = new IndexDatabase(tempDir);
        const embeddingRepository = new EmbeddingRepository(indexDatabase);
        const documentIndexer = new DocumentIndexer(tempDir, fileSystem, indexDatabase, {
            embeddingRepository
        });
        await documentIndexer.indexFile("docs/guide.md");
        await documentIndexer.indexFile("docs/faq.md");

        const searchEngine = new SearchEngine(tempDir, fileSystem);
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
    });
});
