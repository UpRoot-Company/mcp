import * as path from "path";
import { EditorEngine } from "../engine/Editor.js";
import { MemoryFileSystem } from "../platform/FileSystem.js";
import { Edit } from "../types.js";
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
});
