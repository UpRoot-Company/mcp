import { FileVersionManager } from "../engine/FileVersionManager.js";
import { NodeFileSystem } from "../platform/FileSystem.js";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";

describe("FileVersionManager", () => {
    let tmpDir: string;
    let fileSystem: NodeFileSystem;
    let manager: FileVersionManager;

    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "smart-context-test-"));
        fileSystem = new NodeFileSystem(tmpDir);
        manager = new FileVersionManager(fileSystem);
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    describe("getVersion", () => {
        test("should initialize version info on first read", async () => {
            const filePath = path.join(tmpDir, "test.txt");
            fs.writeFileSync(filePath, "hello world");

            const info = await manager.getVersion(filePath);
            expect(info.version).toBe(1);
            expect(info.contentHash).toBeDefined();
            expect(info.lineEnding).toBe("lf");
            expect(info.encoding).toBe("utf-8");
        });

        test("should return cached version if mtime hasn't changed", async () => {
            const filePath = path.join(tmpDir, "test.txt");
            fs.writeFileSync(filePath, "hello world");

            const info1 = await manager.getVersion(filePath);
            const info2 = await manager.getVersion(filePath);

            expect(info1).toBe(info2);
            expect(info2.version).toBe(1);
        });

        test("should increment version and update hash if mtime changed", async () => {
            const filePath = path.join(tmpDir, "test.txt");
            fs.writeFileSync(filePath, "hello world");
            const info1 = await manager.getVersion(filePath);

            // Wait a bit to ensure mtime changes if the FS resolution is low
            await new Promise(resolve => setTimeout(resolve, 100));

            fs.writeFileSync(filePath, "hello updated");
            const info2 = await manager.getVersion(filePath);

            expect(info2.version).toBe(info1.version + 1);
            expect(info2.contentHash).not.toBe(info1.contentHash);
            expect(info2.lastModified).not.toBe(info1.lastModified);
        });

        test("should detect CRLF line endings", async () => {
            const filePath = path.join(tmpDir, "crlf.txt");
            fs.writeFileSync(filePath, "line1\r\nline2");

            const info = await manager.getVersion(filePath);
            expect(info.lineEnding).toBe("crlf");
        });
    });

    describe("incrementVersion", () => {
        test("should manually increment version without reading from disk", async () => {
            const filePath = path.join(tmpDir, "test.txt");
            fs.writeFileSync(filePath, "v1");
            const v1 = await manager.getVersion(filePath);

            const v2 = manager.incrementVersion(filePath, "v2");
            expect(v2.version).toBe(v1.version + 1);
            expect(v2.contentHash).toBeDefined();
            expect(v2.contentHash).not.toBe(v1.contentHash);

            // Subsequent getVersion should return the manually incremented version
            // (assuming mtime matches or we don't check disk if cached)
            const stats = fs.statSync(filePath);
            const v3 = manager.incrementVersion(filePath, "v3", stats.mtimeMs);
            const v4 = await manager.getVersion(filePath);
            expect(v4.version).toBe(v3.version);
        });
    });

    describe("validateVersion", () => {
        test("should return true for matching version and hash", async () => {
            const filePath = path.join(tmpDir, "test.txt");
            fs.writeFileSync(filePath, "hello");
            const info = await manager.getVersion(filePath);

            expect(manager.validateVersion(filePath, { expectedVersion: info.version })).toBe(true);
            expect(manager.validateVersion(filePath, { expectedHash: info.contentHash })).toBe(true);
            expect(manager.validateVersion(filePath, { expectedVersion: info.version, expectedHash: info.contentHash })).toBe(true);
        });

        test("should return false for mismatching version", async () => {
            const filePath = path.join(tmpDir, "test.txt");
            fs.writeFileSync(filePath, "hello");
            const info = await manager.getVersion(filePath);

            expect(manager.validateVersion(filePath, { expectedVersion: info.version + 1 })).toBe(false);
        });

        test("should return false for mismatching hash", async () => {
            const filePath = path.join(tmpDir, "test.txt");
            fs.writeFileSync(filePath, "hello");
            const info = await manager.getVersion(filePath);

            expect(manager.validateVersion(filePath, { expectedHash: "wrong-hash" })).toBe(false);
        });

        test("should return false if file is not tracked", () => {
            expect(manager.validateVersion("non-existent.txt", { expectedVersion: 1 })).toBe(false);
        });
    });

    describe("updateLocalVersion", () => {
        test("should manually set version info", async () => {
            const filePath = path.join(tmpDir, "manual.txt");
            const manualInfo = {
                version: 10,
                contentHash: "manual-hash",
                lastModified: Date.now(),
                encoding: "utf-8" as const,
                lineEnding: "lf" as const
            };

            manager.updateLocalVersion(filePath, manualInfo);
            
            // validateVersion should use this info
            expect(manager.validateVersion(filePath, { expectedVersion: 10, expectedHash: "manual-hash" })).toBe(true);
        });
    });

    describe("hash consistency", () => {
        test("should compute same hash for same content", async () => {
            const filePath1 = path.join(tmpDir, "1.txt");
            const filePath2 = path.join(tmpDir, "2.txt");
            const content = "consistent content";
            
            fs.writeFileSync(filePath1, content);
            fs.writeFileSync(filePath2, content);

            const info1 = await manager.getVersion(filePath1);
            const info2 = await manager.getVersion(filePath2);

            expect(info1.contentHash).toBe(info2.contentHash);
        });
    });
});
