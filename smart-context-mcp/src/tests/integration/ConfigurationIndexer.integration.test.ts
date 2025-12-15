import fs from "fs";
import os from "os";
import path from "path";
import { jest } from "@jest/globals";
import { ConfigurationManager } from "../../config/ConfigurationManager.js";
import { IncrementalIndexer } from "../../indexing/IncrementalIndexer.js";
import { SymbolIndex } from "../../ast/SymbolIndex.js";
import { DependencyGraph } from "../../ast/DependencyGraph.js";
import { IndexDatabase } from "../../indexing/IndexDatabase.js";
import { ModuleResolver } from "../../ast/ModuleResolver.js";

const waitFor = async (assertFn: () => void, timeoutMs = 5000) => {
    const start = Date.now();
    while (true) {
        try {
            assertFn();
            return;
        } catch (error) {
            if (Date.now() - start > timeoutMs) {
                throw error;
            }
            await new Promise(resolve => setTimeout(resolve, 25));
        }
    }
};

describe("ConfigurationManager ↔ IncrementalIndexer integration", () => {
    const createTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "cfg-integration-"));

    const createIndexerWithManager = (rootPath: string, manager: ConfigurationManager) => {
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

        const indexer = new IncrementalIndexer(
            rootPath,
            symbolIndex,
            dependencyGraph,
            indexDatabase,
            moduleResolver,
            manager,
            { watch: false, initialScan: false }
        );

        return { indexer, dependencyGraph, moduleResolver };
    };

    test("tsconfig.json 변경이 실제 파일 시스템 이벤트를 통해 모듈 리로드와 unresolved 재빌드를 유발한다", async () => {
        const tempDir = createTempDir();
        const tsconfigPath = path.join(tempDir, "tsconfig.json");
        fs.writeFileSync(tsconfigPath, JSON.stringify({ compilerOptions: { strict: true } }, null, 2));

        const manager = new ConfigurationManager(tempDir);
        const { indexer, dependencyGraph, moduleResolver } = createIndexerWithManager(tempDir, manager);

        indexer.start();
        // chokidar가 초기화될 시간을 조금 준다.
        await new Promise(resolve => setTimeout(resolve, 200));

        fs.writeFileSync(tsconfigPath, JSON.stringify({ compilerOptions: { strict: false } }, null, 2));
        manager.emit("tsconfigChanged", { filePath: tsconfigPath });

        await waitFor(() => {
            expect(moduleResolver.reloadConfig).toHaveBeenCalledTimes(1);
            expect(dependencyGraph.rebuildUnresolved).toHaveBeenCalledTimes(1);
        });

        await indexer.stop();
        await manager.dispose();
    }, 15000);
});
