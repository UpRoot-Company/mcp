import { describe, it, expect } from "@jest/globals";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { IndexDatabase } from "../indexing/IndexDatabase.js";
import { SymbolInfo } from "../types.js";

const makeTempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "smart-context-store-"));

describe("IndexDatabase storage", () => {
    it("persists symbols across sessions in file mode", () => {
        const rootDir = makeTempRoot();
        const db = new IndexDatabase(rootDir);
        const symbol: SymbolInfo = {
            type: "function",
            name: "persisted",
            range: { startLine: 0, endLine: 0, startByte: 0, endByte: 9 },
            content: "function persisted() {}",
            modifiers: [],
            doc: ""
        };

        db.replaceSymbols({
            relativePath: "src/main.ts",
            lastModified: Date.now(),
            language: "typescript",
            symbols: [symbol]
        });
        db.dispose();

        const reopened = new IndexDatabase(rootDir);
        const stored = reopened.readSymbols("src/main.ts") ?? [];
        expect(stored).toHaveLength(1);
        expect(stored[0].name).toBe("persisted");
        reopened.dispose();

        fs.rmSync(rootDir, { recursive: true, force: true });
    });
});
