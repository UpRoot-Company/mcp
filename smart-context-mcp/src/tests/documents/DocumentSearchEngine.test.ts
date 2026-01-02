import { describe, it, expect, beforeAll, afterAll, jest } from "@jest/globals";
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
import { SymbolIndex } from "../../ast/SymbolIndex.js";
import { SkeletonGenerator } from "../../ast/SkeletonGenerator.js";
import { EvidencePackRepository } from "../../indexing/EvidencePackRepository.js";

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

function setupWorkspaceWithCode(): string {
    const rootDir = setupWorkspace();
    fs.mkdirSync(path.join(rootDir, "src"), { recursive: true });
    fs.writeFileSync(
        path.join(rootDir, "src", "widget.ts"),
        [
            "/**",
            " * Offline install is supported when the network is unavailable.",
            " * Use the cached model artifacts if possible.",
            " */",
            "export function installOffline() {",
            "  return true;",
            "}",
            ""
        ].join("\n")
    );
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
            }),
            rootDir
        );

        const response = await documentSearchEngine.search("install", {
            maxResults: 5,
            maxVectorCandidates: 10,
            maxChunksEmbeddedPerRequest: 10,
            includeEvidence: false
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
            }),
            rootDir
        );

        const response = await documentSearchEngine.search("install", {
            embedding: { provider: "disabled" },
            maxResults: 3,
            includeEvidence: false
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
            }),
            rootDir
        );

        await documentSearchEngine.search("npm install", {
            maxResults: 3,
            maxVectorCandidates: 1,
            maxChunksEmbeddedPerRequest: 1,
            includeEvidence: false,
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

    it("can search code_comment chunks when includeComments is enabled", async () => {
        const rootDir = setupWorkspaceWithCode();
        const fileSystem = new NodeFileSystem(rootDir);
        const indexDatabase = new IndexDatabase(rootDir);
        const embeddingRepository = new EmbeddingRepository(indexDatabase);
        const documentIndexer = new DocumentIndexer(rootDir, fileSystem, indexDatabase, { embeddingRepository });

        // index markdown docs only; code comments are generated on-demand via SymbolIndex.
        await documentIndexer.indexFile("docs/guide.md");

        const skeletonGenerator = new SkeletonGenerator();
        const symbolIndex = new SymbolIndex(rootDir, skeletonGenerator, [], indexDatabase);

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
            }),
            rootDir,
            symbolIndex
        );

        const response = await documentSearchEngine.search("offline install", {
            includeComments: true,
            maxResults: 5,
            maxVectorCandidates: 10,
            maxChunksEmbeddedPerRequest: 10,
            includeEvidence: false
        });

        expect(response.results.some(r => r.filePath === "src/widget.ts")).toBe(true);

        indexDatabase.close();
        await searchEngine.dispose();
        fs.rmSync(rootDir, { recursive: true, force: true });
    });

    it("marks degraded when evidence is truncated under caps", async () => {
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
            }),
            rootDir
        );

        const response = await documentSearchEngine.search("install", {
            maxResults: 2,
            includeEvidence: true,
            snippetLength: 30,
            maxEvidenceSections: 1,
            maxEvidenceChars: 60,
            maxVectorCandidates: 5,
            maxChunksEmbeddedPerRequest: 5
        });

        expect(response.degraded).toBe(true);
        expect([response.reason, ...(response.reasons ?? [])]).toContain("evidence_truncated");
        expect(response.stats.evidenceTruncated).toBe(true);
        expect((response.evidence ?? []).length).toBeLessThanOrEqual(1);

        indexDatabase.close();
        await searchEngine.dispose();
        fs.rmSync(rootDir, { recursive: true, force: true });
    });

    it("marks degraded when embeddings are computed partially", async () => {
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
            }),
            rootDir
        );

        const response = await documentSearchEngine.search("install", {
            maxResults: 3,
            includeEvidence: false,
            maxVectorCandidates: 10,
            maxChunksEmbeddedPerRequest: 1, // force partial embedding
            maxEmbeddingTimeMs: 10_000
        });

        expect(response.degraded).toBe(true);
        expect([response.reason, ...(response.reasons ?? [])]).toContain("embedding_partial");

        indexDatabase.close();
        await searchEngine.dispose();
        fs.rmSync(rootDir, { recursive: true, force: true });
    });

    it("reuses cached results via packId (in-memory evidence pack)", async () => {
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
            }),
            rootDir
        );

        const first = await documentSearchEngine.search("install", {
            output: "compact",
            includeEvidence: false
        });
        expect(first.pack?.packId).toBeTruthy();
        expect(first.pack?.hit).toBe(false);

        const second = await documentSearchEngine.search("install", {
            output: "compact",
            includeEvidence: false,
            packId: first.pack!.packId
        });
        expect(second.pack?.hit).toBe(true);
        expect(second.results).toEqual(first.results);

        indexDatabase.close();
        await searchEngine.dispose();
        fs.rmSync(rootDir, { recursive: true, force: true });
    });

    it("reuses persisted results via packId across engine instances (SQLite evidence pack)", async () => {
        const rootDir = setupWorkspace();
        const fileSystem = new NodeFileSystem(rootDir);
        const indexDatabase = new IndexDatabase(rootDir);
        const embeddingRepository = new EmbeddingRepository(indexDatabase);
        const documentIndexer = new DocumentIndexer(rootDir, fileSystem, indexDatabase, {
            embeddingRepository
        });
        await documentIndexer.indexFile("docs/guide.md");
        await documentIndexer.indexFile("docs/faq.md");

        const packs = new EvidencePackRepository(indexDatabase);
        const searchEngine = new SearchEngine(rootDir, fileSystem);

        const engineA = new DocumentSearchEngine(
            searchEngine,
            documentIndexer,
            new DocumentChunkRepository(indexDatabase),
            embeddingRepository,
            new EmbeddingProviderFactory({
                provider: "local",
                normalize: true,
                local: { model: "hash-test", dims: 64 }
            }),
            rootDir,
            undefined,
            packs
        );

        const first = await engineA.search("install", {
            output: "compact",
            includeEvidence: false
        });
        expect(first.pack?.packId).toBeTruthy();
        expect(first.pack?.hit).toBe(false);

        // New engine instance (empty in-memory cache), same DB.
        const engineB = new DocumentSearchEngine(
            searchEngine,
            documentIndexer,
            new DocumentChunkRepository(indexDatabase),
            embeddingRepository,
            new EmbeddingProviderFactory({
                provider: "local",
                normalize: true,
                local: { model: "hash-test", dims: 64 }
            }),
            rootDir,
            undefined,
            packs
        );

        const second = await engineB.search("install", {
            output: "compact",
            includeEvidence: false,
            packId: first.pack!.packId
        });

        expect(second.pack?.hit).toBe(true);
        expect(second.results).toEqual(first.results);

        indexDatabase.close();
        await searchEngine.dispose();
        fs.rmSync(rootDir, { recursive: true, force: true });
    });

    it("stores and reuses chunk preview summaries (chunk_summaries)", async () => {
        const rootDir = setupWorkspace();
        const fileSystem = new NodeFileSystem(rootDir);
        const indexDatabase = new IndexDatabase(rootDir);
        const embeddingRepository = new EmbeddingRepository(indexDatabase);
        const documentIndexer = new DocumentIndexer(rootDir, fileSystem, indexDatabase, { embeddingRepository });
        await documentIndexer.indexFile("docs/guide.md");

        const packs = new EvidencePackRepository(indexDatabase);
        const searchEngine = new SearchEngine(rootDir, fileSystem);
        const chunkRepo = new DocumentChunkRepository(indexDatabase);
        const engine = new DocumentSearchEngine(
            searchEngine,
            documentIndexer,
            chunkRepo,
            embeddingRepository,
            new EmbeddingProviderFactory({
                provider: "local",
                normalize: true,
                local: { model: "hash-test", dims: 64 }
            }),
            rootDir,
            undefined,
            packs
        );

        const first = await engine.search("install", { output: "compact", includeEvidence: false });
        const firstChunkId = first.results[0]?.id;
        expect(firstChunkId).toBeTruthy();
        const firstHash = chunkRepo.getContentHashByChunkId(firstChunkId!);
        expect(firstHash).toBeTruthy();

        const stored = packs.getSummary(firstChunkId!, "preview", firstHash!);
        expect(stored).toBeTruthy();

        // Second query should reuse the stored preview (not assert exact content, just non-empty).
        const second = await engine.search("install", { output: "compact", includeEvidence: false });
        expect(second.results[0]?.preview).toBeTruthy();

        // Mutate the document content but keep structure stable (chunk id should remain stable, hash should change).
        const guidePath = path.join(rootDir, "docs", "guide.md");
        const beforeText = fs.readFileSync(guidePath, "utf8");
        fs.writeFileSync(guidePath, beforeText.replace("npm install", "npm ci"));
        await documentIndexer.indexFile("docs/guide.md");
        const secondHash = chunkRepo.getContentHashByChunkId(firstChunkId!);
        expect(secondHash).toBeTruthy();
        expect(secondHash).not.toBe(firstHash);

        // Cached summary should be treated as stale for the new content hash.
        const stale = packs.getSummary(firstChunkId!, "preview", secondHash!);
        expect(stale).toBeNull();

        // A new search should repopulate chunk_summaries for the updated hash.
        const third = await engine.search("install", { output: "compact", includeEvidence: false });
        const refreshedResult = third.results.find(r => r.id === firstChunkId);
        expect(refreshedResult?.preview).toBeTruthy();
        const refreshed = packs.getSummary(firstChunkId!, "preview", secondHash!);
        expect(refreshed).toBeTruthy();

        indexDatabase.close();
        await searchEngine.dispose();
        fs.rmSync(rootDir, { recursive: true, force: true });
    });

    it("treats expired packs as cache misses (TTL)", async () => {
        const rootDir = setupWorkspace();
        const fileSystem = new NodeFileSystem(rootDir);
        const indexDatabase = new IndexDatabase(rootDir);
        const embeddingRepository = new EmbeddingRepository(indexDatabase);
        const documentIndexer = new DocumentIndexer(rootDir, fileSystem, indexDatabase, { embeddingRepository });
        await documentIndexer.indexFile("docs/guide.md");

        const originalTtl = process.env.SMART_CONTEXT_EVIDENCE_PACK_TTL_MS;
        process.env.SMART_CONTEXT_EVIDENCE_PACK_TTL_MS = "10";
        const nowSpy = jest.spyOn(Date, "now");
        let now = 1_000_000;
        nowSpy.mockImplementation(() => now);

        const packs = new EvidencePackRepository(indexDatabase);
        const searchEngine = new SearchEngine(rootDir, fileSystem);
        const engine = new DocumentSearchEngine(
            searchEngine,
            documentIndexer,
            new DocumentChunkRepository(indexDatabase),
            embeddingRepository,
            new EmbeddingProviderFactory({
                provider: "local",
                normalize: true,
                local: { model: "hash-test", dims: 64 }
            }),
            rootDir,
            undefined,
            packs
        );

        const first = await engine.search("install", { output: "compact", includeEvidence: false });
        expect(first.pack?.hit).toBe(false);
        expect(first.pack?.packId).toBeTruthy();

        now += 25; // advance past TTL
        const second = await engine.search("install", { output: "compact", includeEvidence: false, packId: first.pack!.packId });
        expect(second.pack?.hit).toBe(false);

        nowSpy.mockRestore();
        if (originalTtl === undefined) delete process.env.SMART_CONTEXT_EVIDENCE_PACK_TTL_MS;
        else process.env.SMART_CONTEXT_EVIDENCE_PACK_TTL_MS = originalTtl;

        indexDatabase.close();
        await searchEngine.dispose();
        fs.rmSync(rootDir, { recursive: true, force: true });
    });

    it("treats stale packs as cache misses when chunk content_hash changes", async () => {
        const rootDir = setupWorkspace();
        const fileSystem = new NodeFileSystem(rootDir);
        const indexDatabase = new IndexDatabase(rootDir);
        const embeddingRepository = new EmbeddingRepository(indexDatabase);
        const documentIndexer = new DocumentIndexer(rootDir, fileSystem, indexDatabase, { embeddingRepository });
        await documentIndexer.indexFile("docs/guide.md");

        const packs = new EvidencePackRepository(indexDatabase);
        const searchEngine = new SearchEngine(rootDir, fileSystem);

        const engineA = new DocumentSearchEngine(
            searchEngine,
            documentIndexer,
            new DocumentChunkRepository(indexDatabase),
            embeddingRepository,
            new EmbeddingProviderFactory({
                provider: "local",
                normalize: true,
                local: { model: "hash-test", dims: 64 }
            }),
            rootDir,
            undefined,
            packs
        );

        const first = await engineA.search("install", { output: "compact", includeEvidence: false });
        expect(first.pack?.hit).toBe(false);
        const packId = first.pack!.packId;

        // Modify content, reindex so content_hash changes (chunk ids remain stable).
        const guidePath = path.join(rootDir, "docs", "guide.md");
        const beforeText = fs.readFileSync(guidePath, "utf8");
        fs.writeFileSync(guidePath, beforeText.replace("npm install", "npm ci"));
        await documentIndexer.indexFile("docs/guide.md");

        // New engine instance => no in-memory cache. Should detect staleness via snapshot mismatch and recompute.
        const engineB = new DocumentSearchEngine(
            searchEngine,
            documentIndexer,
            new DocumentChunkRepository(indexDatabase),
            embeddingRepository,
            new EmbeddingProviderFactory({
                provider: "local",
                normalize: true,
                local: { model: "hash-test", dims: 64 }
            }),
            rootDir,
            undefined,
            packs
        );

        const second = await engineB.search("install", { output: "compact", includeEvidence: false, packId });
        expect(second.pack?.hit).toBe(false);

        indexDatabase.close();
        await searchEngine.dispose();
        fs.rmSync(rootDir, { recursive: true, force: true });
    });

    it("supports output=pack_only (no previews)", async () => {
        const rootDir = setupWorkspace();
        const fileSystem = new NodeFileSystem(rootDir);
        const indexDatabase = new IndexDatabase(rootDir);
        const embeddingRepository = new EmbeddingRepository(indexDatabase);
        const documentIndexer = new DocumentIndexer(rootDir, fileSystem, indexDatabase, { embeddingRepository });
        await documentIndexer.indexFile("docs/guide.md");

        const searchEngine = new SearchEngine(rootDir, fileSystem);
        const engine = new DocumentSearchEngine(
            searchEngine,
            documentIndexer,
            new DocumentChunkRepository(indexDatabase),
            embeddingRepository,
            new EmbeddingProviderFactory({
                provider: "local",
                normalize: true,
                local: { model: "hash-test", dims: 64 }
            }),
            rootDir
        );

        const response = await engine.search("install", { output: "pack_only", includeEvidence: true });
        expect(response.results.length).toBeGreaterThan(0);
        expect(response.results[0]?.preview).toBe("");
        if (Array.isArray(response.evidence) && response.evidence.length > 0) {
            expect(response.evidence[0]?.preview).toBe("");
        }

        indexDatabase.close();
        await searchEngine.dispose();
        fs.rmSync(rootDir, { recursive: true, force: true });
    });
});
