import fs from "fs";
import path from "path";
import os from "os";
import { ConfigurationManager } from "../config/ConfigurationManager.js";

describe("ConfigurationManager", () => {
    const createTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "cfg-manager-test-"));

    test("초기 ignore 패턴을 .gitignore/.mcpignore에서 모두 로드한다", async () => {
        const tempDir = createTempDir();
        const gitignorePath = path.join(tempDir, ".gitignore");
        const mcpignorePath = path.join(tempDir, ".mcpignore");
        fs.writeFileSync(gitignorePath, "dist\ncoverage\n");
        fs.writeFileSync(mcpignorePath, "tmp\n.mcp-cache\n");

        const manager = new ConfigurationManager(tempDir);
        const patterns = manager.getIgnoreGlobs();
        expect(patterns).toEqual(expect.arrayContaining(["dist", "coverage", "tmp", ".mcp-cache"]));
        await manager.dispose();
    });

    test(".gitignore 수정 시 ignoreChanged 이벤트를 발생시킨다", async () => {
        const tempDir = createTempDir();
        const gitignorePath = path.join(tempDir, ".gitignore");
        fs.writeFileSync(gitignorePath, "dist\n");
        const manager = new ConfigurationManager(tempDir);
        const waitForEvent = new Promise<{ filePath: string; patterns: string[] }>(resolve => {
            manager.once("ignoreChanged", payload => resolve(payload));
        });

        await fs.promises.writeFile(gitignorePath, "node_modules\n");
        (manager as any).handleConfigChange(gitignorePath);
        const payload = await waitForEvent;
        expect(payload.filePath).toBe(gitignorePath);
        expect(payload.patterns).toContain("node_modules");
        await manager.dispose();
    });
});
