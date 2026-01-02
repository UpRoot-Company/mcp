import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { IndexDatabase } from "../../indexing/IndexDatabase.js";
import { CommentIndexer } from "../../indexing/CommentIndexer.js";
import { DocumentChunkRepository } from "../../indexing/DocumentChunkRepository.js";

const makeTempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "smart-context-comments-"));

describe("CommentIndexer (fallback)", () => {
    let rootDir: string;
    let db: IndexDatabase | undefined;

    beforeEach(() => {
        rootDir = makeTempRoot();
        db = new IndexDatabase(rootDir);
    });

    afterEach(() => {
        db?.dispose?.();
        db?.close?.();
        fs.rmSync(rootDir, { recursive: true, force: true });
    });

    it("creates code_comment chunks from raw comment blocks when symbols are unavailable", () => {
        if (!db) throw new Error("db missing");
        const indexer = new CommentIndexer(db);
        const chunkRepo = new DocumentChunkRepository(db);

        const content = [
            "/**",
            " * Installs the widget and validates configuration.",
            " * This doc block should be searchable.",
            " */",
            "export function installWidget() {}",
            "",
            "/*",
            "  Additional notes: offline mode is supported.",
            "*/",
            "export const X = 1;",
            ""
        ].join("\n");

        indexer.upsertCommentChunksForFile("src/widget.ts", [], content);
        const chunks = chunkRepo.listChunksForFile("src/widget.ts");
        expect(chunks.length).toBeGreaterThan(0);
        expect(chunks.every(c => c.kind === "code_comment")).toBe(true);
        const joined = chunks.map(c => c.text).join("\n---\n");
        expect(joined).toContain("Installs the widget");
        expect(joined).toContain("offline mode is supported");
    });
});

