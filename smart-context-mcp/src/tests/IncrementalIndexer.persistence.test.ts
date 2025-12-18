import { describe, test, expect, beforeEach, afterEach, jest } from '@jest/globals';
import { IncrementalIndexer } from '../indexing/IncrementalIndexer.js';
import { ProjectIndexManager } from '../indexing/ProjectIndexManager.js';
import { SymbolIndex } from '../ast/SymbolIndex.js';
import { DependencyGraph } from '../ast/DependencyGraph.js';
import { IndexDatabase } from '../indexing/IndexDatabase.js';
import { ModuleResolver } from '../ast/ModuleResolver.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { PathManager } from '../utils/PathManager.js';

describe('Persistent Index', () => {
    let testProjectRoot: string;
    let indexer: IncrementalIndexer;
    let indexManager: ProjectIndexManager;

    beforeEach(async () => {
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smart-context-persistence-test-'));
        testProjectRoot = await fs.realpath(tempDir);
        PathManager.setRoot(testProjectRoot);
        indexManager = new ProjectIndexManager(testProjectRoot);
    });

    afterEach(async () => {
        if (indexer) {
            await indexer.stop();
        }
        await fs.rm(testProjectRoot, { recursive: true, force: true });
    });

    const createIndexer = (rootPath: string) => {
        const symbolIndex = {
            isSupported: (fp: string) => fp.endsWith('.ts') || fp.endsWith('.js'),
            shouldIgnore: () => false,
            getSymbolsForFile: jest.fn(async () => [{ name: 'TestSymbol', kind: 'class', line: 1 } as any]),
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
            listFiles: jest.fn(() => []),
            deleteFile: jest.fn(),
            getFile: jest.fn(() => undefined)
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
            undefined, 
            { watch: false, initialScan: true }
        );

        return { indexer, symbolIndex, dependencyGraph };
    };

    test('should persist index after initial build and shutdown', async () => {
        await createTestFiles(testProjectRoot, ['src/main.ts', 'src/utils.ts']);
        const { indexer: idx } = createIndexer(testProjectRoot);
        indexer = idx;

        await indexer.start();
        await indexer.waitForInitialScan();
        await sleep(500); 
        await indexer.stop();

        const index = await indexManager.loadPersistedIndex();
        expect(index).not.toBeNull();
        expect(Object.keys(index!.files).length).toBeGreaterThan(0);
    });

    test('should restore state from persisted index', async () => {
        await createTestFiles(testProjectRoot, ['src/shared.ts']);
        const { indexer: idx1 } = createIndexer(testProjectRoot);
        await idx1.start();
        await idx1.waitForInitialScan();
        await sleep(500);
        await idx1.stop();

        const { indexer: idx2, symbolIndex: sym2 } = createIndexer(testProjectRoot);
        await idx2.start();
        await idx2.waitForInitialScan();
        
        expect(sym2.restoreFromCache).toHaveBeenCalled();
        await idx2.stop();
    });

    test('should only reindex changed files after restoration', async () => {
        await createTestFiles(testProjectRoot, ['file1.ts', 'file2.ts']);
        
        const { indexer: idx1 } = createIndexer(testProjectRoot);
        await idx1.start();
        await idx1.waitForInitialScan();
        await sleep(500);
        await idx1.stop();

        await sleep(200); 
        await touchFile(path.join(testProjectRoot, 'file1.ts'));

        const { indexer: idx2, symbolIndex: sym2 } = createIndexer(testProjectRoot);
        await idx2.start();
        await idx2.waitForInitialScan();
        await sleep(500);

        const calls = (sym2.getSymbolsForFile as jest.Mock).mock.calls;
        const indexedFiles = calls.map(c => c[0] as string);
        
        expect(indexedFiles.some(f => f.endsWith('file1.ts'))).toBe(true);
        expect(indexedFiles.some(f => f.endsWith('file2.ts'))).toBe(false);

        await idx2.stop();
    });
});

async function createTestFiles(root: string, files: string[]): Promise<void> {
    for (const file of files) {
        const fullPath = path.join(root, file);
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, `// Test file: ${file}\nexport const x = 1;`, 'utf-8');
    }
}

async function touchFile(filePath: string): Promise<void> {
    const content = await fs.readFile(filePath, 'utf-8');
    await fs.writeFile(filePath, content + '\n// touched', 'utf-8');
}

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}
