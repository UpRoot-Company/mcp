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
let mammothAvailable = true;
let xlsxAvailable = true;
let pdfAvailable = true;
const SAMPLE_DOCX_BASE64 = "UEsDBBQAAAAIAG9+n1udxYoq8gAAALkBAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbH2QzU7DMBCE73kKy1eUOHBACCXpgZ8jcCgPsLI3iVV7bXnd0r49TgtFQpSjNfPNrKdb7b0TO0xsA/XyummlQNLBWJp6+b5+ru+k4AxkwAXCXh6Q5WqouvUhIosCE/dyzjneK8V6Rg/chIhUlDEkD7k806Qi6A1MqG7a9lbpQBkp13nJkEMlRPeII2xdFk/7opxuSehYioeTd6nrJcTorIZcdLUj86uo/ippCnn08GwjXxWDVJdKFvFyxw/6WiZK1qB4g5RfwBej+gjJKBP01he4+T/pj2vDOFqNZ35JiyloZC7be9ecFQ+Wvn/RqePwQ/UJUEsDBBQAAAAIAG9+n1tAoFMJsgAAAC8BAAALAAAAX3JlbHMvLnJlbHONz7sOgjAUBuCdp2jOLgUHYwyFxZiwGnyApj2URnpJWy+8vR0cxDg4ntt38jfd08zkjiFqZxnUZQUErXBSW8XgMpw2eyAxcSv57CwyWDBC1xbNGWee8k2ctI8kIzYymFLyB0qjmNDwWDqPNk9GFwxPuQyKei6uXCHdVtWOhk8D2oKQFUt6ySD0sgYyLB7/4d04aoFHJ24Gbfrx5WsjyzwoTAweLkgq3+0ys0BzSrqK2RYvUEsDBBQAAAAIAG9+n1vuW4Vu3wAAAF8BAAARAAAAd29yZC9kb2N1bWVudC54bWx1kM9OxCAQxu99igl3S7dRs2la9qbxZvzzAFjGlgQGAlRcn15odm96+fIN8Jv5mPH0bQ18YYja0cQObccAaXZK0zKx97eHmyODmCQpaRzhxM4Y2Uk0Yx6UmzeLlKB0oDjkia0p+YHzOK9oZWydRyp3ny5YmUoZFp5dUD64GWMsA6zhfdfdcys1MdEAlK4fTp2r3QsvioQqSTxRiWEMPG5a4cjrUdWwq/8TedkIyFvQFzQ5iJhg8+3/fMQ5Pe+8X15/INd/Hfr+tuwlD2vxd8fi+U5d3tbg/Jq8uutmRPMLUEsBAhQDFAAAAAgAb36fW53FiiryAAAAuQEAABMAAAAAAAAAAAAAAIABAAAAAFtDb250ZW50X1R5cGVzXS54bWxQSwECFAMUAAAACABvfp9bQKBTCbIAAAAvAQAACwAAAAAAAAAAAAAAgAEjAQAAX3JlbHMvLnJlbHNQSwECFAMUAAAACABvfp9b7luFbt8AAABfAQAAEQAAAAAAAAAAAAAAgAH+AQAAd29yZC9kb2N1bWVudC54bWxQSwUGAAAAAAMAAwC5AAAADAMAAAAA";

beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "smart-context-doc-search-"));
});

beforeAll(async () => {
    try {
        await import("mammoth");
    } catch {
        mammothAvailable = false;
    }
});

beforeAll(async () => {
    try {
        await import("xlsx");
    } catch {
        xlsxAvailable = false;
    }
});

beforeAll(async () => {
    try {
        await import("pdfjs-dist/legacy/build/pdf.js");
    } catch {
        pdfAvailable = false;
    }
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

function setupWorkspaceWithLog(): string {
    const rootDir = setupWorkspace();
    fs.mkdirSync(path.join(rootDir, "logs"), { recursive: true });
    fs.writeFileSync(
        path.join(rootDir, "logs", "app.log"),
        [
            "2025-12-31T00:00:00Z INFO Booting service",
            "2025-12-31T00:00:02Z ERROR install failed: missing dependency",
            ""
        ].join("\n")
    );
    return rootDir;
}

function setupWorkspaceWithMetrics(): string {
    const rootDir = setupWorkspace();
    fs.mkdirSync(path.join(rootDir, "metrics"), { recursive: true });
    fs.writeFileSync(path.join(rootDir, "metrics", "latency.csv"), "latency 250\n");
    fs.writeFileSync(path.join(rootDir, "docs", "latency.md"), "latency 250\n");
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

function buildSamplePdfBuffer(text: string): Buffer {
    const escapePdfText = (value: string) =>
        value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

    const content = `BT\n/F1 12 Tf\n72 720 Td\n(${escapePdfText(text)}) Tj\nET`;
    const objects = [
        "",
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        `<< /Length ${Buffer.byteLength(content, "utf8")} >>\nstream\n${content}\nendstream`,
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
    ];

    const parts: string[] = ["%PDF-1.4\n"];
    const offsets: number[] = [0];
    let offset = Buffer.byteLength(parts[0], "utf8");

    for (let i = 1; i < objects.length; i += 1) {
        offsets[i] = offset;
        const obj = `${i} 0 obj\n${objects[i]}\nendobj\n`;
        parts.push(obj);
        offset += Buffer.byteLength(obj, "utf8");
    }

    let xref = "xref\n0 6\n0000000000 65535 f \n";
    for (let i = 1; i < offsets.length; i += 1) {
        xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
    }

    const trailer = `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF`;
    const pdf = parts.join("") + xref + trailer;
    return Buffer.from(pdf, "utf8");
}

async function buildSampleXlsxBuffer(): Promise<Buffer> {
    const xlsx = await import("xlsx");
    const workbook = xlsx.utils.book_new();
    const rows = [
        ["Error", "Message"],
        ["E001", "Install failed: missing dependency"],
        ["E002", "Install failed: network timeout"]
    ];
    const sheet = xlsx.utils.aoa_to_sheet(rows);
    xlsx.utils.book_append_sheet(workbook, sheet, "Errors");
    return xlsx.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
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

    it("indexes .log files as text documents", async () => {
        const rootDir = setupWorkspaceWithLog();
        const fileSystem = new NodeFileSystem(rootDir);
        const indexDatabase = new IndexDatabase(rootDir);
        const embeddingRepository = new EmbeddingRepository(indexDatabase);
        const documentIndexer = new DocumentIndexer(rootDir, fileSystem, indexDatabase, { embeddingRepository });
        await documentIndexer.indexFile("logs/app.log");
        const chunkRepo = new DocumentChunkRepository(indexDatabase);
        const logChunks = chunkRepo.listChunksForFile("logs/app.log");
        expect(logChunks.length).toBeGreaterThan(1);
        expect(logChunks.some(chunk => chunk.text.includes("install failed"))).toBe(true);

        const searchEngine = new SearchEngine(rootDir, fileSystem);
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
            rootDir
        );

        const response = await engine.search("install failed", { output: "compact", includeEvidence: false });
        const match = response.results.find(r => r.filePath === "logs/app.log");
        expect(match).toBeTruthy();

        indexDatabase.close();
        await searchEngine.dispose();
        fs.rmSync(rootDir, { recursive: true, force: true });
    });

    it("boosts metrics files when includeMetrics is enabled", async () => {
        const rootDir = setupWorkspaceWithMetrics();
        const fileSystem = new NodeFileSystem(rootDir);
        const indexDatabase = new IndexDatabase(rootDir);
        const embeddingRepository = new EmbeddingRepository(indexDatabase);
        const documentIndexer = new DocumentIndexer(rootDir, fileSystem, indexDatabase, { embeddingRepository });
        await documentIndexer.indexFile("metrics/latency.csv");
        await documentIndexer.indexFile("docs/latency.md");

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

        const originalBoost = process.env.SMART_CONTEXT_METRICS_SCORE_BOOST;
        process.env.SMART_CONTEXT_METRICS_SCORE_BOOST = "0.5";
        try {
            const response = await engine.search("latency 250", {
                output: "compact",
                includeEvidence: false,
                includeMetrics: true,
                scope: "docs",
                embedding: { provider: "disabled" }
            });
            expect(response.results[0]?.filePath).toBe("metrics/latency.csv");
        } finally {
            if (originalBoost === undefined) {
                delete process.env.SMART_CONTEXT_METRICS_SCORE_BOOST;
            } else {
                process.env.SMART_CONTEXT_METRICS_SCORE_BOOST = originalBoost;
            }
        }

        indexDatabase.close();
        await searchEngine.dispose();
        fs.rmSync(rootDir, { recursive: true, force: true });
    });

    it("indexes .docx files when parser is available", async () => {
        if (!mammothAvailable) {
            return;
        }
        const rootDir = setupWorkspace();
        const fileSystem = new NodeFileSystem(rootDir);
        const indexDatabase = new IndexDatabase(rootDir);
        const embeddingRepository = new EmbeddingRepository(indexDatabase);
        const documentIndexer = new DocumentIndexer(rootDir, fileSystem, indexDatabase, { embeddingRepository });

        const docxPath = path.join(rootDir, "docs", "sample.docx");
        fs.writeFileSync(docxPath, Buffer.from(SAMPLE_DOCX_BASE64, "base64"));

        await documentIndexer.indexFile("docs/sample.docx");

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

        const response = await engine.search("Install Guide", { output: "compact", includeEvidence: false });
        const match = response.results.find(r => r.filePath === "docs/sample.docx");
        expect(match).toBeTruthy();

        indexDatabase.close();
        await searchEngine.dispose();
        fs.rmSync(rootDir, { recursive: true, force: true });
    });

    it("indexes .xlsx files when parser is available", async () => {
        if (!xlsxAvailable) {
            return;
        }
        const rootDir = setupWorkspace();
        const fileSystem = new NodeFileSystem(rootDir);
        const indexDatabase = new IndexDatabase(rootDir);
        const embeddingRepository = new EmbeddingRepository(indexDatabase);
        const documentIndexer = new DocumentIndexer(rootDir, fileSystem, indexDatabase, { embeddingRepository });

        const xlsxPath = path.join(rootDir, "docs", "errors.xlsx");
        const xlsxBuffer = await buildSampleXlsxBuffer();
        fs.writeFileSync(xlsxPath, xlsxBuffer);

        await documentIndexer.indexFile("docs/errors.xlsx");

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

        const response = await engine.search("Install failed", { output: "compact", includeEvidence: false });
        const match = response.results.find(r => r.filePath === "docs/errors.xlsx");
        expect(match).toBeTruthy();

        indexDatabase.close();
        await searchEngine.dispose();
        fs.rmSync(rootDir, { recursive: true, force: true });
    });

    it("indexes .pdf files when parser is available", async () => {
        if (!pdfAvailable) {
            return;
        }
        const rootDir = setupWorkspace();
        const fileSystem = new NodeFileSystem(rootDir);
        const indexDatabase = new IndexDatabase(rootDir);
        const embeddingRepository = new EmbeddingRepository(indexDatabase);
        const documentIndexer = new DocumentIndexer(rootDir, fileSystem, indexDatabase, { embeddingRepository });

        const pdfPath = path.join(rootDir, "docs", "manual.pdf");
        const pdfBuffer = buildSamplePdfBuffer("Install failed: missing dependency");
        fs.writeFileSync(pdfPath, pdfBuffer);

        await documentIndexer.indexFile("docs/manual.pdf");

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

        const response = await engine.search("Install failed", { output: "compact", includeEvidence: false });
        const match = response.results.find(r => r.filePath === "docs/manual.pdf");
        expect(match).toBeTruthy();

        indexDatabase.close();
        await searchEngine.dispose();
        fs.rmSync(rootDir, { recursive: true, force: true });
    });
});
