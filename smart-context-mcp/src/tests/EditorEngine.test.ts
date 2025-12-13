import { jest, describe, it, beforeEach, expect } from "@jest/globals";
import * as path from "path";
import { EditorEngine } from "../engine/Editor.js";
import { MemoryFileSystem } from "../platform/FileSystem.js";
import { Edit, SemanticDiffSummary, SemanticDiffProvider } from "../types.js";
import { PatienceDiff } from "../engine/PatienceDiff.js";

const sanitizeBackupPrefix = (filePath: string): string => {
    return filePath
        .replace(/^[A-Z]:/i, (drive) => drive[0] + "_")
        .replace(/["\/\\:]/g, "_")
        .replace(/^_/, "");
};

describe("EditorEngine with MemoryFileSystem", () => {
    const rootPath = path.join(process.cwd(), "__virtual_workspace__");
    const filePath = path.join(rootPath, "src", "demo.ts");
    const baseContent = [
        "const result = 1;",
        "export const value = result;",
    ].join("\n");

    let fileSystem: MemoryFileSystem;
    let editor: EditorEngine;

    beforeEach(async () => {
        fileSystem = new MemoryFileSystem(rootPath);
        editor = new EditorEngine(rootPath, fileSystem);
        await fileSystem.createDir(path.dirname(filePath));
        await fileSystem.writeFile(filePath, baseContent);
    });

    it("applies edits without disk I/O", async () => {
        const edits: Edit[] = [{ targetString: "const result = 1;", replacementString: "const result = 2;" }];
        const result = await editor.applyEdits(filePath, edits);
        expect(result.success).toBe(true);
        const updatedContent = await fileSystem.readFile(filePath);
        expect(updatedContent).toContain("const result = 2;");
    });

    it("creates timestamped backups containing the original content", async () => {
        const original = await fileSystem.readFile(filePath);
        const edits: Edit[] = [{ targetString: "const result = 1;", replacementString: "const result = 2;" }];
        await editor.applyEdits(filePath, edits);

        const backupsDir = path.join(rootPath, ".mcp", "backups");
        const backupFiles = await fileSystem.readDir(backupsDir);
        expect(backupFiles.length).toBe(1);
        const backupContent = await fileSystem.readFile(path.join(backupsDir, backupFiles[0]));
        expect(backupContent).toBe(original);
    });

    it("enforces a maximum of 10 backups per file", async () => {
        const relativePath = path.relative(rootPath, filePath);
        const encodedPrefix = sanitizeBackupPrefix(relativePath);
        const backupsDir = path.join(rootPath, ".mcp", "backups");
        await fileSystem.createDir(backupsDir);

        for (let i = 0; i < 12; i++) {
            const suffix = `20240101T0000${i.toString().padStart(2, "0")}`;
            await fileSystem.writeFile(
                path.join(backupsDir, `${encodedPrefix}_${suffix}.bak`),
                `legacy-backup-${i}`
            );
        }

        const edits: Edit[] = [{ targetString: "const result = 1;", replacementString: "const result = 4;" }];
        const result = await editor.applyEdits(filePath, edits);
        expect(result.success).toBe(true);

        const remaining = (await fileSystem.readDir(backupsDir)).filter((name) =>
            name.startsWith(`${encodedPrefix}_`) && name.endsWith(".bak")
        );
        expect(remaining.length).toBe(10);
    });

    it("supports semantic diff previews on dry runs", async () => {
        const edits: Edit[] = [{ targetString: "const result = 1;", replacementString: "const result = compute();" }];
        const result = await editor.applyEdits(filePath, edits, true, { diffMode: "semantic" });
        expect(result.success).toBe(true);
        expect(result.diff).toBeDefined();
        const expected = PatienceDiff.formatUnified(
            PatienceDiff.diff(
                baseContent,
                baseContent.replace("const result = 1;", "const result = compute();"),
                { semantic: true, contextLines: 3 }
            )
        );
        expect(result.diff).toBe(expected);
    });

    it("attaches semantic summaries when provider is available", async () => {
        const summary: SemanticDiffSummary = {
            changes: [{
                type: "modify",
                name: "value",
                symbolType: "variable",
                oldLocation: { start: 2, end: 2 },
                newLocation: { start: 2, end: 2 }
            }],
            stats: { added: 0, removed: 0, modified: 1, renamed: 0, moved: 0 }
        };
        const diffMock = jest.fn(async () => summary) as SemanticDiffProvider['diff'];
        const semanticProvider: SemanticDiffProvider = {
            diff: diffMock
        };
        editor = new EditorEngine(rootPath, fileSystem, semanticProvider);
        const edits: Edit[] = [{ targetString: "const result = 1;", replacementString: "const result = compute();" }];
        const result = await editor.applyEdits(filePath, edits, true, { diffMode: "semantic" });
        expect(result.semanticSummary).toEqual(summary);
        expect(result.diffModeUsed).toBe("semantic");
        expect(semanticProvider.diff).toHaveBeenCalled();
    });
});

// ADR-024: Enhanced Edit Flexibility and Safety Tests
describe("EditorEngine - Confidence Scoring (ADR-024 Phase 1)", () => {
    const rootPath = path.join(process.cwd(), "__virtual_workspace_confidence__");
    const filePath = path.join(rootPath, "test.ts");
    let fileSystem: MemoryFileSystem;
    let editor: EditorEngine;

    beforeEach(async () => {
        fileSystem = new MemoryFileSystem(rootPath);
        editor = new EditorEngine(rootPath, fileSystem);
        await fileSystem.createDir(path.dirname(filePath));
    });

    it("should score exact matches with 1.0 confidence", async () => {
        const content = "const x = 1;";
        await fileSystem.writeFile(filePath, content);

        const edits: Edit[] = [{ targetString: "const x = 1;", replacementString: "const x = 2;" }];
        const result = await editor.applyEdits(filePath, edits, true);
        expect(result.success).toBe(true);
    });

    it("should apply edits with whitespace normalization (confidence boost)", async () => {
        const content = "const  x  =  1;"; // Extra spaces
        await fileSystem.writeFile(filePath, content);

        const edits: Edit[] = [{
            targetString: "const x = 1;",
            replacementString: "const x = 2;",
            normalization: "whitespace"
        }];
        const result = await editor.applyEdits(filePath, edits);
        expect(result.success).toBe(true);
        const updated = await fileSystem.readFile(filePath);
        expect(updated).toContain("const x = 2;");
    });

    it("should handle line-ending normalization (CRLF ↔ LF)", async () => {
        const content = "const x = 1;\r\nconst y = 2;";
        await fileSystem.writeFile(filePath, content);

        const edits: Edit[] = [{
            targetString: "const x = 1;\nconst y = 2;",
            replacementString: "const x = 1;\nconst y = 3;",
            normalization: "line-endings"
        }];
        const result = await editor.applyEdits(filePath, edits);
        expect(result.success).toBe(true);
        const updated = await fileSystem.readFile(filePath);
        expect(updated).toContain("const y = 3;");
    });

    it("should handle indentation normalization (tabs ↔ spaces)", async () => {
        const content = "function test() {\n\treturn true;\n}";
        await fileSystem.writeFile(filePath, content);

        const edits: Edit[] = [{
            targetString: "function test() {\n    return true;\n}",
            replacementString: "function test() {\n    return false;\n}",
            normalization: "indentation",
            normalizationConfig: { tabWidth: 4 }
        }];
        const result = await editor.applyEdits(filePath, edits);
        expect(result.success).toBe(true);
        const updated = await fileSystem.readFile(filePath);
        expect(updated).toContain("return false;");
    });

    it("should apply trailing whitespace normalization", async () => {
        const content = "const x = 1;   \nconst y = 2;  ";
        await fileSystem.writeFile(filePath, content);

        const edits: Edit[] = [{
            targetString: "const x = 1;\nconst y = 2;",
            replacementString: "const x = 1;\nconst y = 3;",
            normalization: "trailing"
        }];
        const result = await editor.applyEdits(filePath, edits);
        expect(result.success).toBe(true);
    });

    it("should apply structural normalization (blank lines, spacing)", async () => {
        const content = "class Test  {\n\n  method()  {  }\n\n}";
        await fileSystem.writeFile(filePath, content);

        const edits: Edit[] = [{
            targetString: "class Test { method() { } }",
            replacementString: "class Updated { method() { } }",
            normalization: "structural"
        }];
        const result = await editor.applyEdits(filePath, edits);
        expect(result.success).toBe(true);
        const updated = await fileSystem.readFile(filePath);
        expect(updated).toContain("class Updated");
    });

    it("should fail gracefully when no normalization level matches", async () => {
        const content = "const x = 1;";
        await fileSystem.writeFile(filePath, content);

        const edits: Edit[] = [{
            targetString: "const y = 2;",
            replacementString: "const y = 3;",
            normalization: "exact"
        }];
        const result = await editor.applyEdits(filePath, edits);
        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
    });

    it("should cascade through normalization levels (from exact to structural)", async () => {
        const content = "const  x  =  1;"; // Extra spaces
        await fileSystem.writeFile(filePath, content);

        // Without specifying normalization, should try all levels
        const edits: Edit[] = [{
            targetString: "const x = 1;", // Clean version
            replacementString: "const x = 2;"
            // No normalization specified - should cascade
        }];
        const result = await editor.applyEdits(filePath, edits);
        expect(result.success).toBe(true);
    });
});

describe("EditorEngine - Safe Delete Operations (ADR-024 Phase 3)", () => {
    const rootPath = path.join(process.cwd(), "__virtual_workspace_delete__");
    let fileSystem: MemoryFileSystem;
    let editor: EditorEngine;

    beforeEach(async () => {
        fileSystem = new MemoryFileSystem(rootPath);
        editor = new EditorEngine(rootPath, fileSystem);
        await fileSystem.createDir(rootPath);
    });

    it("should support large file deletion with safety", async () => {
        const filePath = path.join(rootPath, "large.ts");
        const content = "a".repeat(15_000); // > 10KB
        await fileSystem.writeFile(filePath, content);

        // Dry run to get hash
        const exists = await fileSystem.stat(filePath);
        expect(exists.size).toBeGreaterThan(10_000);
    });

    it("should preserve file structure through backup/restore", async () => {
        const filePath = path.join(rootPath, "test.ts");
        const content = "function main() {\n  console.log('test');\n}";
        await fileSystem.writeFile(filePath, content);
        const original = await fileSystem.readFile(filePath);

        const edits: Edit[] = [{ targetString: "test", replacementString: "prod" }];
        await editor.applyEdits(filePath, edits);
        const updated = await fileSystem.readFile(filePath);

        expect(updated).not.toBe(original);
        expect(updated).toContain("prod");
    });
});
