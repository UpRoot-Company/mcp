import { describe, test, expect, beforeEach } from '@jest/globals';
import { SearchEngine } from '../engine/Search.js';
import { MemoryFileSystem } from '../platform/FileSystem.js';
import * as path from 'path';

describe('Hybrid Search', () => {
  const rootPath = path.resolve('/test-project'); // Use absolute path for MemoryFileSystem
  let fileSystem: MemoryFileSystem;
  let search: SearchEngine;
  
  beforeEach(async () => {
    fileSystem = new MemoryFileSystem();
    await fileSystem.createDir(rootPath);
    
    // Initialize search engine
    search = new SearchEngine(rootPath, fileSystem);
  });
  
  test('should find file by filename match even if trigram misses', async () => {
    const workerPath = path.join(rootPath, 'worker.js');
    await fileSystem.writeFile(workerPath, 'const x = 1;');
    
    // Index the file (SearchEngine doesn't auto-index)
    await search.invalidateFile(workerPath);
    
    const results = await search.scout({ query: 'worker' });
    
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].filePath).toBe('worker.js');
    expect(results[0].scoreDetails?.type).toContain('filename');
  });
  
  test('should boost results with symbol name matches', async () => {
    const fileA = path.join(rootPath, 'a.ts');
    const fileB = path.join(rootPath, 'b.ts');
    
    await fileSystem.writeFile(fileA, 'export class QPSO { }');
    await fileSystem.writeFile(fileB, 'const x = 1; // unrelated');
    
    // Need to mock SymbolIndex if we want to test symbol scoring
    const mockSymbolIndex = {
      getSymbolsForFile: async (fp: string) => {
        if (fp === fileA) return [{ name: 'QPSO', kind: 'class', line: 1, range: { startLine: 0, endLine: 0 } } as any];
        return [];
      },
      getAllSymbols: async () => new Map([
        [fileA, [{ name: 'QPSO', kind: 'class', line: 1, range: { startLine: 0, endLine: 0 } } as any]]
      ]),
      findFilesBySymbolName: async (keywords: string[]) => {
        if (keywords.some(k => k.toLowerCase().includes('qpso'))) return [fileA];
        return [];
      }
    };
    
    search = new SearchEngine(rootPath, fileSystem, [], { symbolIndex: mockSymbolIndex as any });

    await search.invalidateFile(fileA);
    await search.invalidateFile(fileB);

    const results = await search.scout({ query: 'QPSO' });
    
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].filePath).toBe('a.ts');
    expect(results[0].scoreDetails?.type).toContain('symbol');
  });
  
  test('should match keywords in comments', async () => {
    const filePath = path.join(rootPath, 'test.ts');
    await fileSystem.writeFile(filePath, `
// Worker 데이터 처리
// QPSO 알고리즘 초기화
const x = 1;
    `);
    
    await search.invalidateFile(filePath);
    
    const results = await search.scout({ query: 'Worker QPSO' });
    
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].scoreDetails?.type).toContain('comment');
  });
  
  test('should handle the exact user scenario', async () => {
    const workerPath = path.join(rootPath, 'worker.js');
    await fileSystem.writeFile(workerPath, `
// Worker 데이터
const { name, conf, option, data = workerData;

// QPSO 알고리즘 초기화
class QPSO {
  constructor(config) {
    this.config = config;
  }
}

// 학습 진행 (training)
async function train() {
  const qpso = new QPSO({ particleCount: 10 });
  const result = await qpso.optimize(data);
  return result;
}
    `);
    
    const mockSymbolIndex = {
        getSymbolsForFile: async (fp: string) => {
            if (fp === workerPath) {
                return [
                    { name: 'QPSO', kind: 'class', line: 6 },
                    { name: 'train', kind: 'function', line: 12 }
                ] as any;
            }
            return [];
        },
        getAllSymbols: async () => new Map([
            [workerPath, [
                { name: 'QPSO', kind: 'class', line: 6 },
                { name: 'train', kind: 'function', line: 12 }
            ] as any]
        ]),
        findFilesBySymbolName: async (keywords: string[]) => {
            if (keywords.some(k => k.toLowerCase().includes('qpso'))) return [workerPath];
            if (keywords.some(k => k.toLowerCase().includes('train'))) return [workerPath];
            return [];
        }
    };

    search = new SearchEngine(rootPath, fileSystem, [], { symbolIndex: mockSymbolIndex as any });
    await search.invalidateFile(workerPath);
    
    const results = await search.scout({ 
      query: 'Worker QPSO training' 
    });
    
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].filePath).toBe('worker.js');
    
    const types = results[0].scoreDetails?.type || '';
    expect(types).toContain('filename');
    expect(types).toContain('symbol');
    expect(types).toContain('comment');
  });
});
