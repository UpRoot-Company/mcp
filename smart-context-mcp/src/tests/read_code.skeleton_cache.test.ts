import { SmartContextServer } from "../index.js";
import { AstManager } from "../ast/AstManager.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

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
        await AstManager.getInstance().init();
        await AstManager.getInstance().warmup(["typescript", "tsx", "javascript"]);

        targetFile = path.join(testRootDir, "demo.ts");
        fs.writeFileSync(targetFile, "export function demo(x: number) { return x * 2; }\n");

        server = new SmartContextServer(testRootDir);
    });

    afterEach(async () => {
        await (server as any)?.incrementalIndexer?.stop();
        AstManager.resetForTesting();
        fs.rmSync(testRootDir, { recursive: true, force: true });
    });

    test("reuses skeletons through the cache for repeated calls", async () => {
        const relativePath = path.relative(testRootDir, targetFile);

        const first = await (server as any).handleCallTool("read_code", { filePath: relativePath, view: "skeleton" });
        const firstSkeleton = extractText(first);

        const statsAfterFirst = (server as any).skeletonCache.getStats();
        expect(statsAfterFirst.misses).toBeGreaterThanOrEqual(1);
        expect(statsAfterFirst.l1Hits).toBe(0);

        const second = await (server as any).handleCallTool("read_code", { filePath: relativePath, view: "skeleton" });
        const secondSkeleton = extractText(second);

        expect(secondSkeleton).toBe(firstSkeleton);

        const statsAfterSecond = (server as any).skeletonCache.getStats();
        expect(statsAfterSecond.l1Hits).toBeGreaterThanOrEqual(1);
        expect(statsAfterSecond.misses).toBe(statsAfterFirst.misses);
    });

    test("manage_project reindex clears skeleton caches and forces regeneration", async () => {
        const relativePath = path.relative(testRootDir, targetFile);

        await (server as any).handleCallTool("read_code", { filePath: relativePath, view: "skeleton" });
        await new Promise(resolve => setTimeout(resolve, 20));

        const statsBeforeReindex = (server as any).skeletonCache.getStats();
        expect(statsBeforeReindex.memorySize).toBeGreaterThan(0);

        const diskEntries = await fs.promises.readdir(statsBeforeReindex.diskCacheDir, { withFileTypes: true }).catch(() => []);
        expect(diskEntries.length).toBeGreaterThan(0);

        await (server as any).handleCallTool("manage_project", { command: "reindex" });

        const statsAfterReindex = (server as any).skeletonCache.getStats();
        expect(statsAfterReindex.memorySize).toBe(0);

        const diskAfterClear = await fs.promises.readdir(statsAfterReindex.diskCacheDir, { withFileTypes: true }).catch(() => []);
        expect(diskAfterClear.length).toBe(0);

        const responseAfterRebuild = await (server as any).handleCallTool("read_code", { filePath: relativePath, view: "skeleton" });
        const rebuiltSkeleton = extractText(responseAfterRebuild);
        expect(rebuiltSkeleton.length).toBeGreaterThan(0);

        const statsAfterRebuild = (server as any).skeletonCache.getStats();
        expect(statsAfterRebuild.misses).toBeGreaterThan(statsBeforeReindex.misses);
    });
});
