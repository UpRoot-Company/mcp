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
import { PathManager } from "../utils/PathManager.js";

class StubConfigurationManager extends EventEmitter {
    public getIgnoreGlobs(): string[] { return []; }
    public async dispose(): Promise<void> { return Promise.resolve(); }
}

const createTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "indexer-config-test-"));

const createIndexedFile = (rootPath: string, fileName: string) => {
    const absPath = path.join(rootPath, fileName);
    fs.writeFileSync(absPath, "export const value = 1;\n");
    return absPath;
};

const createIndexer = (rootPath: string, configurationManager?: ConfigurationManager) => {
    // Initialize PathManager for tests
    PathManager.setRoot(rootPath);

    const symbolIndex = {
        isSupported: () => true,
        shouldIgnore: () => false,
        getSymbolsForFile: jest.fn(async () => []),
        restoreFromCache: jest.fn(),
        findFilesBySymbolName: jest.fn(async () => [])
    } as unknown as SymbolIndex;

    const dependencyGraph = {
        updateFileDependencies: jest.fn(async () => undefined),
        rebuildUnresolved: jest.fn(async () => undefined),
        removeFile: jest.fn(async () => undefined),
        removeDirectory: jest.fn(async () => undefined),
        restoreEdges: jest.fn(async () => undefined)
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

describe("IncrementalIndexer configuration integration", () => {
    test("구성 파일 변경은 모듈 리로드 흐름을 사용한다", async () => {
        const tempDir = createTempDir();
        const { indexer } = createIndexer(tempDir);

        const handleModuleConfigChange = jest.spyOn(indexer as any, "handleModuleConfigChange").mockResolvedValue(undefined);
        const handleIgnoreChange = jest.spyOn(indexer as any, "handleIgnoreChange").mockResolvedValue(undefined);
        const enqueuePath = jest.spyOn(indexer as any, "enqueuePath");

        const configPath = createIndexedFile(tempDir, "tsconfig.json");
        await (indexer as any).handleFileChange(configPath);

        expect(handleModuleConfigChange).toHaveBeenCalledTimes(1);
        expect(handleIgnoreChange).not.toHaveBeenCalled();
        // In current implementation, config files are also enqueued for indexing
        expect(enqueuePath).toHaveBeenCalled();
        
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test("일반 파일 변경은 우선순위 큐에 enqueue된다", async () => {
        const tempDir = createTempDir();
        const { indexer } = createIndexer(tempDir);

        const enqueuePath = jest.spyOn(indexer as any, "enqueuePath");
        const filePath = createIndexedFile(tempDir, "regular.ts");
        
        await (indexer as any).handleFileChange(filePath);

        expect(enqueuePath).toHaveBeenCalledWith(filePath, 'medium');
        
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    test("IndexerStatusSnapshot contains correct activity information", async () => {
        const tempDir = createTempDir();
        const { indexer } = createIndexer(tempDir);

        const highFile = createIndexedFile(tempDir, "high.ts");
        const lowFile = createIndexedFile(tempDir, "low.ts");

        (indexer as any).enqueuePath(highFile, 'high');
        (indexer as any).enqueuePath(lowFile, 'low');

        const snapshot = indexer.getActivitySnapshot();
        expect(snapshot.queueDepth.high).toBe(1);
        expect(snapshot.queueDepth.low).toBe(1);
        expect(snapshot.queueDepth.total).toBe(2);
        
        fs.rmSync(tempDir, { recursive: true, force: true });
    });
});
