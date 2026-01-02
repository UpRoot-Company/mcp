import { describe, it, expect } from "@jest/globals";
import Database from "better-sqlite3";
import { MigrationRunner } from "../indexing/MigrationRunner.js";

describe("MigrationRunner", () => {
    it("applies migrations and updates schema_version", () => {
        const db = new Database(":memory:");
        db.exec(`CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);

        const runner = new MigrationRunner(db);
        runner.run();

        const versionRow = db.prepare(`SELECT value FROM metadata WHERE key='schema_version'`).get() as any;
        expect(versionRow.value).toBe("6");

        const table = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='transaction_log'`).get();
        expect(table).toBeTruthy();

        const docChunks = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='document_chunks'`).get();
        expect(docChunks).toBeTruthy();

        const chunkEmbeddings = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='chunk_embeddings'`).get();
        expect(chunkEmbeddings).toBeTruthy();

        const evidencePacks = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='evidence_packs'`).get();
        expect(evidencePacks).toBeTruthy();

        const evidencePackItems = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='evidence_pack_items'`).get();
        expect(evidencePackItems).toBeTruthy();

        const chunkSummaries = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='chunk_summaries'`).get();
        expect(chunkSummaries).toBeTruthy();

        const summaryCols = db.prepare(`PRAGMA table_info(chunk_summaries)`).all() as any[];
        expect(summaryCols.some(col => col?.name === "content_hash")).toBe(true);
    });
});
