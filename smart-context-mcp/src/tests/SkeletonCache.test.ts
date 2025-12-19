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

        await new Promise(resolve => setTimeout(resolve, 20));

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

    test("hit/miss 집계를 getStats()로 확인할 수 있다", async () => {
        const filePath = path.join(testDir, "stats.ts");
        await fs.writeFile(filePath, "export const y = 2;\n");

        let generatorCalls = 0;
        const generator = async () => {
            generatorCalls++;
            return "stats";
        };

        // miss + L1 fill
        await cache.getSkeleton(filePath, {}, generator);
        // L1 hit
        await cache.getSkeleton(filePath, {}, generator);

        await new Promise(resolve => setTimeout(resolve, 20));

        const cache2 = new SkeletonCache(testDir, 100, 60_000);
        let generatorCalls2 = 0;
        const generator2 = async () => {
            generatorCalls2++;
            return "stats";
        };

        // L2 hit
        await cache2.getSkeleton(filePath, {}, generator2);

        const { memorySize, l1Hits, l2Hits, misses } = cache2.getStats();
        expect(memorySize).toBeGreaterThan(0);
        expect(l1Hits).toBe(0); // new instance
        expect(l2Hits).toBe(1);
        expect(misses).toBe(0);
        expect(generatorCalls).toBe(1);
        expect(generatorCalls2).toBe(0);
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

    test("clearAll()은 메모리와 디스크 캐시를 모두 비운다", async () => {
        const filePath = path.join(testDir, "clear.ts");
        await fs.writeFile(filePath, "export const z = 3;\n");

        const generator = async () => "clear";
        await cache.getSkeleton(filePath, {}, generator);

        // 저장이 완료될 시간을 잠시 준다
        await new Promise(resolve => setTimeout(resolve, 20));

        await cache.clearAll();

        const hashed = (await fs.readdir(path.join(testDir, '.smart-context', 'data', 'cache', 'skeletons'), { withFileTypes: true }).catch(() => []));
        expect(hashed.length).toBe(0);
        expect(cache.getStats().memorySize).toBe(0);
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
