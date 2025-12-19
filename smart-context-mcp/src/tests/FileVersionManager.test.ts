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

    test("should initialize version info on first read", async () => {
        const filePath = path.join(tmpDir, "test.txt");
        fs.writeFileSync(filePath, "hello world");

        const info = await manager.getVersion(filePath);
        expect(info.version).toBe(1);
        expect(info.contentHash).toBeDefined();
        // default to lf unless crlf detected
        expect(info.lineEnding).toBe("lf");
    });

    test("should increment version on manual update", async () => {
        const filePath = path.join(tmpDir, "test.txt");
        fs.writeFileSync(filePath, "hello");
        
        const v1 = await manager.getVersion(filePath);
        
        fs.writeFileSync(filePath, "hello world");
        const stats = fs.statSync(filePath);
        
        const v2 = manager.incrementVersion(filePath, "hello world", stats.mtimeMs);
        
        expect(v2.version).toBe(v1.version + 1);
        expect(v2.contentHash).not.toBe(v1.contentHash);
        
        // getVersion should return the updated version from memory
        const v3 = await manager.getVersion(filePath);
        expect(v3.version).toBe(v2.version);
    });

    test("should validate matching version", async () => {
        const filePath = path.join(tmpDir, "test.txt");
        fs.writeFileSync(filePath, "hello");
        const v1 = await manager.getVersion(filePath);

        const valid = manager.validateVersion(filePath, { expectedVersion: v1.version, expectedHash: v1.contentHash });
        expect(valid).toBe(true);
    });

    test("should reject mismatching version", async () => {
        const filePath = path.join(tmpDir, "test.txt");
        fs.writeFileSync(filePath, "hello");
        const v1 = await manager.getVersion(filePath);

        const invalidVersion = manager.validateVersion(filePath, { expectedVersion: 999 });
        expect(invalidVersion).toBe(false);

        const invalidHash = manager.validateVersion(filePath, { expectedHash: "wronghash" });
        expect(invalidHash).toBe(false);
    });
});
