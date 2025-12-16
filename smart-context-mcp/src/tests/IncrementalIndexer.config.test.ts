import fs from "fs";
import os from "os";
import path from "path";
import { EventEmitter } from "events";
import { jest } from "@jest/globals";
import { IncrementalIndexer } from "../indexing/IncrementalIndexer.js";
import { SymbolIndex } from "../ast/SymbolIndex.js";
import { DependencyGraph } from "../ast/DependencyGraph.js";
import { IndexDatabase } from "../indexing/IndexDatabase.js";
import { ModuleResolver } from "../ast/ModuleResolver.js";
import { ConfigurationManager } from "../config/ConfigurationManager.js";

describe("IncrementalIndexer configuration integration", () => {
    class StubConfigurationManager extends EventEmitter {
        public getIgnoreGlobs(): string[] { return []; }
        public dispose(): Promise<void> { return Promise.resolve(); }
    }

    const createTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "indexer-config-test-"));

    const createIndexedFile = (rootPath: string, fileName: string) => {
        const absPath = path.join(rootPath, fileName);
        fs.writeFileSync(absPath, "export const value = 1;\n");
        return absPath;
    };

    const createIndexer = (rootPath: string, configurationManager?: ConfigurationManager) => {
        const symbolIndex = {
            isSupported: () => true,
            shouldIgnore: () => false,
            getSymbolsForFile: jest.fn(async () => [])
        } as unknown as SymbolIndex;

        const dependencyGraph = {
            updateFileDependencies: jest.fn(async () => undefined),
            rebuildUnresolved: jest.fn(async () => undefined),
            removeFile: jest.fn(async () => undefined),
            removeDirectory: jest.fn(async () => undefined)
        } as unknown as DependencyGraph;

        const indexDatabase = {
            listFiles: () => [],
            deleteFile: () => undefined,
            getFile: () => undefined
        } as unknown as IndexDatabase;

        const moduleResolver = {
            reloadConfig: jest.fn()
        } as unknown as ModuleResolver;

        const manager = configurationManager ?? (new StubConfigurationManager() as unknown as ConfigurationManager);
        const indexer = new IncrementalIndexer(
            rootPath,
            symbolIndex,
            dependencyGraph,
            indexDatabase,
            moduleResolver,
            manager,
            { watch: false, initialScan: false }
        );

        return { indexer, symbolIndex, dependencyGraph, indexDatabase, moduleResolver, configurationManager: manager };
    };

    test("ConfigurationManager 이벤트가 모듈 리로드와 unresolved 재빌드를 트리거한다", async () => {
        const tempDir = createTempDir();
        const stubManager = new StubConfigurationManager() as unknown as ConfigurationManager;
        const { indexer, dependencyGraph, moduleResolver } = createIndexer(tempDir, stubManager);

        await indexer.start();
        (stubManager as unknown as EventEmitter).emit("tsconfigChanged", { filePath: path.join(tempDir, "tsconfig.json") });
        // Wait for async event handler and all microtasks to complete
        await new Promise(resolve => setTimeout(resolve, 500));

        expect(moduleResolver.reloadConfig).toHaveBeenCalledTimes(1);
        expect((dependencyGraph.rebuildUnresolved as jest.Mock)).toHaveBeenCalledTimes(1);
        await indexer.stop();
    });

    test("우선순위 큐 스냅샷이 high/low 대기열 상태를 구분한다", () => {
        const tempDir = createTempDir();
        const { indexer } = createIndexer(tempDir);
        const highFile = createIndexedFile(tempDir, "high.ts");
        const lowFile = createIndexedFile(tempDir, "low.ts");

        (indexer as any).enqueuePath(highFile, "high");
        (indexer as any).enqueuePath(lowFile, "low");

        const snapshot = indexer.getActivitySnapshot();
        expect(snapshot.queueDepth.high).toBe(1);
        expect(snapshot.queueDepth.low).toBe(1);
        expect(snapshot.queueDepth.medium).toBe(0);
        expect(snapshot.queueDepth.total).toBe(2);
    });
});
