import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { IndexDatabase } from "../indexing/IndexDatabase.js";
import { DocumentChunkRepository } from "../indexing/DocumentChunkRepository.js";

const makeTempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "smart-context-docs-"));

describe("DocumentChunkRepository", () => {
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

    it("stores and reads document chunks per file", () => {
        if (!db) throw new Error("db missing");
        const repo = new DocumentChunkRepository(db);
        repo.upsertChunksForFile("docs/readme.md", [
            {
                id: "chunk-1",
                filePath: "docs/readme.md",
                kind: "markdown",
                sectionPath: ["README"],
                heading: "README",
                headingLevel: 1,
                range: { startLine: 1, endLine: 3, startByte: 0, endByte: 25 },
                text: "# README\nhello\nworld",
                contentHash: "hash-1",
                updatedAt: Date.now()
            }
        ]);

        const stored = repo.listChunksForFile("docs/readme.md");
        expect(stored).toHaveLength(1);
        expect(stored[0].id).toBe("chunk-1");
        expect(stored[0].sectionPath).toEqual(["README"]);

        repo.deleteChunksForFile("docs/readme.md");
        expect(repo.listChunksForFile("docs/readme.md")).toHaveLength(0);
    });
});
