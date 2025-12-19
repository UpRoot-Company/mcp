import fs from "fs";
import os from "os";
import path from "path";
import { jest } from "@jest/globals";
import { IncrementalIndexer } from "../indexing/IncrementalIndexer.js";
import { SymbolIndex } from "../ast/SymbolIndex.js";
import { DependencyGraph } from "../ast/DependencyGraph.js";
import { IndexDatabase } from "../indexing/IndexDatabase.js";
import { ModuleResolver } from "../ast/ModuleResolver.js";
import type { ProjectIndex } from "../indexing/ProjectIndex.js";

const createTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "indexer-coldstart-"));

const createIndexer = (rootPath: string) => {
    const symbolIndex = {
        isSupported: jest.fn(() => true),
        shouldIgnore: jest.fn(() => false),
        getSymbolsForFile: jest.fn(async () => []),
        restoreFromCache: jest.fn()
    } as unknown as SymbolIndex;

    const dependencyGraph = {
        updateFileDependencies: jest.fn(async () => undefined),
        restoreEdges: jest.fn(async () => undefined),
        removeFile: jest.fn(async () => undefined),
        removeDirectory: jest.fn(async () => undefined)
    } as unknown as DependencyGraph;

    const indexDatabase = {
        listFiles: () => [],
        deleteFile: () => undefined,
        getFile: () => undefined
    } as unknown as IndexDatabase;

    const moduleResolver = { reloadConfig: jest.fn() } as unknown as ModuleResolver;

    const indexer = new IncrementalIndexer(
        rootPath,
        symbolIndex,
        dependencyGraph,
        indexDatabase,
        moduleResolver,
        undefined,
        { watch: false, initialScan: false }
    );

    return { indexer, symbolIndex, dependencyGraph };
};

describe("IncrementalIndexer cold start optimizations", () => {
    test("enqueueInitialScan batches shouldReindex calls in parallel", async () => {
        const tempDir = createTempDir();
        const files = Array.from({ length: 5 }).map((_, index) => {
            const filePath = path.join(tempDir, `file-${index}.ts`);
            fs.writeFileSync(filePath, "export const value = 1;\n");
            return filePath;
        });

        const { indexer } = createIndexer(tempDir);

        let active = 0;
        let maxActive = 0;
        const shouldReindexMock = jest
            .spyOn(indexer as any, "shouldReindex")
            .mockImplementation(async () => {
                active += 1;
                maxActive = Math.max(maxActive, active);
                await new Promise(resolve => setTimeout(resolve, 20));
                active -= 1;
                return true;
            });

        await (indexer as any).enqueueInitialScan();

        expect(shouldReindexMock).toHaveBeenCalledTimes(files.length);
        expect(maxActive).toBeGreaterThan(1);

        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test("shouldReindex uses async realpath and falls back gracefully", async () => {
        const tempDir = createTempDir();
        const filePath = path.join(tempDir, "file.ts");
        fs.writeFileSync(filePath, "export const value = 1;\n");
        const { indexer } = createIndexer(tempDir);

        const resolved = path.resolve(filePath);
        (indexer as any).currentIndex = {
            version: "1",
            projectRoot: tempDir,
            lastUpdate: Date.now(),
            files: {
                [resolved]: {
                    mtime: 100,
                    symbols: [],
                    imports: [],
                    exports: [],
                    trigrams: { wordCount: 0, uniqueTrigramCount: 0 }
                }
            },
            symbolIndex: {},
            reverseImports: {}
        } as ProjectIndex;

        const realpathSpy = jest.spyOn(fs.promises, "realpath").mockRejectedValueOnce(new Error("failure"));
        const statSpy = jest.spyOn(fs.promises, "stat").mockResolvedValue({ mtimeMs: 100 } as fs.Stats);

        const needsReindex = await (indexer as any).shouldReindex(filePath);

        expect(realpathSpy).toHaveBeenCalledTimes(1);
        expect(statSpy).toHaveBeenCalledTimes(1);
        expect(needsReindex).toBe(false);

        realpathSpy.mockRestore();
        statSpy.mockRestore();
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test("restoreFromPersistedIndex restores symbols and dependencies in parallel", async () => {
        const tempDir = createTempDir();
        const { indexer, symbolIndex, dependencyGraph } = createIndexer(tempDir);
        const fileA = path.join(tempDir, "a.ts");
        const fileB = path.join(tempDir, "b.ts");

        const projectIndex: ProjectIndex = {
            version: "1",
            projectRoot: tempDir,
            lastUpdate: Date.now(),
            files: {
                [fileA]: {
                    mtime: 1,
                    symbols: [],
                    imports: [
                        {
                            specifier: "./b",
                            resolvedPath: fileB,
                            what: ["foo"],
                            line: 1,
                            importType: "named"
                        }
                    ],
                    exports: [],
                    trigrams: { wordCount: 0, uniqueTrigramCount: 0 }
                },
                [fileB]: {
                    mtime: 2,
                    symbols: [],
                    imports: [
                        {
                            specifier: "./a",
                            resolvedPath: fileA,
                            what: ["bar"],
                            line: 1,
                            importType: "named"
                        }
                    ],
                    exports: [],
                    trigrams: { wordCount: 0, uniqueTrigramCount: 0 }
                }
            },
            symbolIndex: {},
            reverseImports: {}
        };

        let active = 0;
        let maxActive = 0;
        (dependencyGraph.restoreEdges as jest.Mock).mockImplementation(async () => {
            active += 1;
            maxActive = Math.max(maxActive, active);
            await new Promise(resolve => setTimeout(resolve, 20));
            active -= 1;
        });

        await (indexer as any).restoreFromPersistedIndex(projectIndex);

        expect((symbolIndex.restoreFromCache as jest.Mock)).toHaveBeenCalledTimes(2);
        expect((dependencyGraph.restoreEdges as jest.Mock)).toHaveBeenCalledTimes(2);
        expect(maxActive).toBeGreaterThan(1);

        fs.rmSync(tempDir, { recursive: true, force: true });
    });
});
