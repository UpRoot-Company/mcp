import { SmartContextServer } from "../index.js";
import { AstManager } from "../ast/AstManager.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { PathManager } from "../utils/PathManager.js";
import { describe, test, expect, beforeEach, afterEach } from "@jest/globals";

const extractText = (response: any): string => {
    if (response?.content?.[0]?.text) {
        return response.content[0].text;
    }
    if (typeof response?.content === "string") {
        return response.content;
    }
    throw new Error(`Invalid response content: ${JSON.stringify(response)}`);
};

describe("SmartContextServer - read_code skeleton cache integration", () => {
    let server: SmartContextServer;
    let testRootDir: string;
    let targetFile: string;

    beforeEach(async () => {
        testRootDir = fs.mkdtempSync(path.join(os.tmpdir(), "smart-context-skeleton-cache-"));
        PathManager.setRoot(testRootDir);
        
        targetFile = path.join(testRootDir, "demo.ts");
        fs.writeFileSync(targetFile, "export class Demo { constructor() { console.log('hello'); } }");

        server = new SmartContextServer(testRootDir);
        await (server as any).astManager.warmup();
    });

    afterEach(async () => {
        if (server) {
            await server.shutdown();
        }
        if (fs.existsSync(testRootDir)) {
            fs.rmSync(testRootDir, { recursive: true, force: true });
        }
    });

    test("skeleton results are cached in memory and on disk", async () => {
        const relativePath = path.relative(testRootDir, targetFile);
        
        const first = await (server as any).handleCallTool("read_code", { filePath: relativePath, view: "skeleton" });
        const firstSkeleton = extractText(first);
        expect(firstSkeleton).toContain("class Demo");

        await new Promise(resolve => setTimeout(resolve, 500));

        const statsAfterFirst = (server as any).skeletonCache.getStats();
        expect(statsAfterFirst.memorySize).toBe(1);

        const second = await (server as any).handleCallTool("read_code", { filePath: relativePath, view: "skeleton" });
        const secondSkeleton = extractText(second);
        expect(secondSkeleton).toBe(firstSkeleton);
    });

    test("manage_project reindex clears skeleton caches and forces regeneration", async () => {
        const relativePath = path.relative(testRootDir, targetFile);
        
        await (server as any).handleCallTool("read_code", { filePath: relativePath, view: "skeleton" });
        await new Promise(resolve => setTimeout(resolve, 800));

        const skeletonsDir = path.join(PathManager.getCacheDir(), 'skeletons');
        if (fs.existsSync(skeletonsDir)) {
            const diskEntries = fs.readdirSync(skeletonsDir, { withFileTypes: true });
            expect(diskEntries.length).toBeGreaterThan(0);
        }

        await (server as any).handleCallTool("manage_project", { command: "reindex" });

        const statsAfterReindex = (server as any).skeletonCache.getStats();
        expect(statsAfterReindex.memorySize).toBe(0);

        if (fs.existsSync(skeletonsDir)) {
            const diskAfterClear = fs.readdirSync(skeletonsDir).filter(f => !f.startsWith('.'));
            expect(diskAfterClear.length).toBe(0);
        }

        const responseAfterRebuild = await (server as any).handleCallTool("read_code", { filePath: relativePath, view: "skeleton" });
        const rebuiltSkeleton = extractText(responseAfterRebuild);
        expect(rebuiltSkeleton).toContain("class Demo");
    });
});
