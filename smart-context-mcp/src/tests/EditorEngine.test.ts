import { jest, describe, it, beforeEach, expect, afterEach } from "@jest/globals";
import * as path from "path";
import { EditorEngine } from "../engine/Editor.js";
import { MemoryFileSystem } from "../platform/FileSystem.js";
import { Edit, SemanticDiffSummary, SemanticDiffProvider } from "../types.js";
import { PatienceDiff } from "../engine/PatienceDiff.js";
import { PathManager } from "../utils/PathManager.js";

const sanitizeBackupPrefix = (filePath: string): string => {
    return filePath
        .replace(/^[A-Z]:/i, (drive) => drive[0] + "_")
        .replace(/["\/\\:]/g, "_")
        .replace(/^_/, "");
}

describe("EditorEngine with MemoryFileSystem", () => {
    const rootPath = path.resolve("/__virtual_workspace__");
    const filePath = path.join(rootPath, "src", "demo.ts");
    const baseContent = [
        "const result = 1;",
        "export const value = result;",
    ].join("\n");

    let fileSystem: MemoryFileSystem;
    let editor: EditorEngine;

    beforeEach(async () => {
        PathManager.setRoot(rootPath);
        fileSystem = new MemoryFileSystem(rootPath);
        await fileSystem.createDir(rootPath);
        await fileSystem.createDir(path.dirname(filePath));
        await fileSystem.writeFile(filePath, baseContent);
        editor = new EditorEngine(rootPath, fileSystem);
    });

    it("applies basic string replacements", async () => {
        const edits: Edit[] = [{ targetString: "const result = 1;", replacementString: "const result = 2;" }];
        const result = await editor.applyEdits(filePath, edits);

        expect(result.success).toBe(true);
        const updatedContent = await fileSystem.readFile(filePath);
        expect(updatedContent).toBe(baseContent.replace("1", "2"));
    });

    it("supports semantic diff previews on dry runs", async () => {
        const edits: Edit[] = [{ targetString: "const result = 1;", replacementString: "const result = compute();" }];
        const result = await editor.applyEdits(filePath, edits, true, { diffMode: "semantic" });

        expect(result.success).toBe(true);
        expect(result.message).toBeDefined();
        expect(result.message).toContain("+const result = compute();");
    });
});

describe("EditorEngine - Confidence Scoring (ADR-024 Phase 1)", () => {
    const rootPath = path.resolve("/__virtual_workspace_confidence__");
    const filePath = path.join(rootPath, "test.ts");
    let fileSystem: MemoryFileSystem;
    let editor: EditorEngine;

    beforeEach(async () => {
        PathManager.setRoot(rootPath);
        fileSystem = new MemoryFileSystem(rootPath);
        await fileSystem.createDir(rootPath);
        editor = new EditorEngine(rootPath, fileSystem);
    });

    it("handles whitespace-tolerant matching", async () => {
        const content = "const  x  =  1;";
        await fileSystem.writeFile(filePath, content);

        const edits: Edit[] = [{
            targetString: "const x = 1;",
            replacementString: "const x = 2;",
            normalization: "whitespace"
        }];
        const result = await editor.applyEdits(filePath, edits);

        expect(result.success).toBe(true);
        const updated = await fileSystem.readFile(filePath);
        expect(updated).toBe("const x = 2;");
    });

    it("handles structural normalization (AST-like)", async () => {
        // Source has some structure
        const content = "function foo() { return 1; }";
        await fileSystem.writeFile(filePath, content);

        const edits: Edit[] = [{
            // Target is very differently formatted but same content
            targetString: "function foo ( ) { return 1 ; }",
            replacementString: "function bar() { return 1; }",
            normalization: "structural"
        }];
        const result = await editor.applyEdits(filePath, edits);

        expect(result.success).toBe(true);
        const updated = await fileSystem.readFile(filePath);
        expect(updated).toContain("function bar");
    });
});

describe("EditorEngine - Context fuzziness & smart inserts (ADR-025 Phase 1)", () => {
    const rootPath = path.resolve("/__context_fuzziness_workspace__");
    const filePath = path.join(rootPath, "module.ts");
    let fileSystem: MemoryFileSystem;
    let editor: EditorEngine;

    beforeEach(async () => {
        PathManager.setRoot(rootPath);
        fileSystem = new MemoryFileSystem(rootPath);
        await fileSystem.createDir(rootPath);
        editor = new EditorEngine(rootPath, fileSystem);
    });

    it("performs smart insert after anchor", async () => {
        const content = [
            "const anchor = 1;",
            "const target = 2;"
        ].join("\n");
        await fileSystem.writeFile(filePath, content);

        const edits: Edit[] = [{
            targetString: "const anchor = 1;",
            replacementString: "console.log('after');\n",
            insertMode: "after"
        }];

        const result = await editor.applyEdits(filePath, edits);
        expect(result.success).toBe(true);
        const updated = await fileSystem.readFile(filePath);
        expect(updated).toContain("console.log('after');");
    });
});
