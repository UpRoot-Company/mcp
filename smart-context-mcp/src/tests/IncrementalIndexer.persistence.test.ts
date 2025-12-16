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

describe('Persistent Index', () => {
  let testProjectRoot: string;
  let indexer: IncrementalIndexer;
  let indexManager: ProjectIndexManager;
  
  beforeEach(async () => {
    // Create temp project directory
    testProjectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'smart-context-persistence-test-'));
    indexManager = new ProjectIndexManager(testProjectRoot);
  });
  
  afterEach(async () => {
    // Cleanup
    if (indexer) await indexer.stop();
    await fs.rm(testProjectRoot, { recursive: true, force: true });
  });

  const createIndexer = (rootPath: string) => {
      // Mock dependencies
      const symbolIndex = {
          isSupported: () => true,
          shouldIgnore: () => false,
          getSymbolsForFile: jest.fn(async () => []),
          restoreFromCache: jest.fn()
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

      // We don't provide ConfigurationManager here to simplify
      const indexer = new IncrementalIndexer(
          rootPath,
          symbolIndex,
          dependencyGraph,
          indexDatabase,
          moduleResolver,
          undefined, // ConfigurationManager
          { watch: true, initialScan: true }
      );

      return { indexer, symbolIndex, dependencyGraph };
  };
  
  test('should persist index after initial build and shutdown', async () => {
    // Create test files
    await createTestFiles(testProjectRoot, [
      'src/a.ts',
      'src/b.ts',
      'src/c.ts'
    ]);
    
    // Build index
    const result = createIndexer(testProjectRoot);
    indexer = result.indexer;
    
    await indexer.start();
    await waitForIndexing();
    await indexer.stop();
    
    // Verify index file exists
    const indexPath = path.join(testProjectRoot, '.smart-context-index', 'index.json');
    try {
        await fs.access(indexPath);
    } catch {
        throw new Error(`Index file not found at ${indexPath}`);
    }
    
    // Verify index content
    const index = await indexManager.loadPersistedIndex();
    expect(index).not.toBeNull();
    // Since we mocked symbolIndex to return empty arrays, we expect entries but empty content
    // Also IncrementalIndexer.processFile updates the indexManager
    // But we need to ensure processFile was actually called.
    // enqueueInitialScan works by scanning directory.
    
    // We should expect 3 files in index
    expect(Object.keys(index!.files).length).toBe(3);
  });
  
  test('should load persisted index and restore cache', async () => {
    // Step 1: Initial build
    await createTestFiles(testProjectRoot, [
      'src/a.ts'
    ]);
    
    const result1 = createIndexer(testProjectRoot);
    const indexer1 = result1.indexer;
    await indexer1.start();
    await waitForIndexing();
    await indexer1.stop();
    
    // Step 2: Restart indexer
    const result2 = createIndexer(testProjectRoot);
    const indexer2 = result2.indexer;
    const symbolIndex2 = result2.symbolIndex;
    
    await indexer2.start();
    
    // It should have restored from cache
    // We can verify if symbolIndex.restoreFromCache was called
    expect(symbolIndex2.restoreFromCache).toHaveBeenCalled();
    
    await indexer2.stop();
  });
  
  test('should detect changes via mtime', async () => {
    // 1. Create file and index
    await createTestFiles(testProjectRoot, ['src/a.ts']);
    let result = createIndexer(testProjectRoot);
    await result.indexer.start();
    await waitForIndexing();
    await result.indexer.stop();
    
    // 2. Modify file
    await sleep(100); 
    await touchFile(path.join(testProjectRoot, 'src/a.ts'));
    
    // 3. Re-index
    // We want to check if it queues the file for processing.
    // We can spy on enqueuePath? It's private.
    // But if it queues, it calls symbolIndex.getSymbolsForFile.
    
    result = createIndexer(testProjectRoot);
    await result.indexer.start();
    await waitForIndexing();
    
    // Since it changed, shouldReindex should return true, and enqueuePath called.
    // processQueue should call symbolIndex.getSymbolsForFile
    expect(result.symbolIndex.getSymbolsForFile).toHaveBeenCalledWith(expect.stringContaining('src/a.ts'));
    
    await result.indexer.stop();
  });

  test('should skip unchanged files', async () => {
    // 1. Create file and index
    await createTestFiles(testProjectRoot, ['src/a.ts']);
    let result = createIndexer(testProjectRoot);
    await result.indexer.start();
    await waitForIndexing();
    await result.indexer.stop();
    
    // 2. Do NOT modify file
    
    // 3. Re-index
    result = createIndexer(testProjectRoot);
    await result.indexer.start();
    await waitForIndexing();
    
    // It should load from persisted index and NOT queue it for processing (except maybe 'medium' queue for 'add' event but skipped inside handler?)
    // In start():
    // this.watcher.on('add', async file => { const needs = await shouldReindex(file); if(needs) ... else log skipping })
    // So getSymbolsForFile should NOT be called if skipped.
    
    expect(result.symbolIndex.getSymbolsForFile).not.toHaveBeenCalled();
    
    await result.indexer.stop();
  });
});

// Helper functions
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

function waitForIndexing(): Promise<void> {
  return sleep(1000); // Wait for async indexing to complete
}
