import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import { SearchEngine } from "../../../engine/Search.js";
import { NodeFileSystem } from "../../../platform/FileSystem.js";
import { PathManager } from "../../../utils/PathManager.js";

let tempDir: string;

beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "smart-context-search-"));
    PathManager.setRoot(tempDir);
    fs.mkdirSync(path.join(tempDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "src", "foo.ts"), "class Foo {}");
    fs.writeFileSync(path.join(tempDir, "src", "foobar.ts"), "class FooBar {}");
});

afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("SearchEngine symbol intent boundaries", () => {
    it("prefers exact symbol matches for symbol intent queries", async () => {
        const fileSystem = new NodeFileSystem(tempDir);
        const engine = new SearchEngine(tempDir, fileSystem);
        await engine.warmup();

        const results = await engine.scout({
            query: "class Foo",
            includeGlobs: ["src/**"],
            groupByFile: true,
            deduplicateByContent: true
        });

        expect(results[0]?.filePath).toBe("src/foo.ts");
        await engine.dispose();
    });
});
