import { describe, test, expect, beforeEach, afterEach } from "@jest/globals";
import * as fs from "fs/promises";
import * as path from "path";
import * as os from "os";
import { SkeletonCache } from "../ast/SkeletonCache.js";

const createTempDir = async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "skeleton-cache-test-"));
    return dir;
};

describe("SkeletonCache", () => {
    let testDir: string;
    let cache: SkeletonCache;

    beforeEach(async () => {
        testDir = await createTempDir();
        cache = new SkeletonCache(testDir, 100, 60_000);
    });

    afterEach(async () => {
        await fs.rm(testDir, { recursive: true, force: true });
    });

    test("메모리 캐시(L1)를 통해 반복 호출 시 재생성을 피한다", async () => {
        const filePath = path.join(testDir, "test.ts");
        await fs.writeFile(filePath, "export const x = 1;\n");

        let generatorCalls = 0;
        const mockGenerator = async (_path: string, _opts: any) => {
            generatorCalls++;
            return "skeleton-1";
        };

        await cache.getSkeleton(filePath, {}, mockGenerator);
        await cache.getSkeleton(filePath, {}, mockGenerator);

        expect(generatorCalls).toBe(1);
    });

    test("디스크 캐시(L2)를 사용해 프로세스 재시작 후에도 재사용한다", async () => {
        const filePath = path.join(testDir, "test.ts");
        await fs.writeFile(filePath, "export const x = 1;\n");

        const mockSkeleton = "cached";
        const generator = async (_path: string, _opts: any) => mockSkeleton;

        const first = await cache.getSkeleton(filePath, {}, generator);
        expect(first).toBe(mockSkeleton);

        const cache2 = new SkeletonCache(testDir, 100, 60_000);
        let generatorCalled = false;
        const secondGenerator = async (_path: string, _opts: any) => {
            generatorCalled = true;
            return mockSkeleton;
        };

        const second = await cache2.getSkeleton(filePath, {}, secondGenerator);
        expect(generatorCalled).toBe(false);
        expect(second).toBe(mockSkeleton);
    });

    test("파일 mtime이 변경되면 캐시를 무효화한다", async () => {
        const filePath = path.join(testDir, "test.ts");
        await fs.writeFile(filePath, "export const x = 1;\n");

        let generatorCalls = 0;
        const generator = async (_path: string, _opts: any) => {
            generatorCalls++;
            return `value-${generatorCalls}`;
        };

        await cache.getSkeleton(filePath, {}, generator);
        await new Promise(resolve => setTimeout(resolve, 50));
        await fs.writeFile(filePath, "export const x = 2;\n");
        await cache.getSkeleton(filePath, {}, generator);

        expect(generatorCalls).toBe(2);
    });

    test("옵션 조합이 다르면 별도 캐시 엔트리를 유지한다", async () => {
        const filePath = path.join(testDir, "test.ts");
        await fs.writeFile(filePath, "export const x = 1;\n");

        let generatorCalls = 0;
        const generator = async (_path: string, opts: any) => {
            generatorCalls++;
            return `detail-${opts.detailLevel}`;
        };

        await cache.getSkeleton(filePath, { detailLevel: "minimal" }, generator);
        await cache.getSkeleton(filePath, { detailLevel: "standard" }, generator);
        await cache.getSkeleton(filePath, { detailLevel: "minimal" }, generator);

        expect(generatorCalls).toBe(2);
    });
});
