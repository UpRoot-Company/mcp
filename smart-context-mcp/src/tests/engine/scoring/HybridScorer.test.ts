import { HybridScorer } from '../../../engine/scoring/HybridScorer.js';
import { TrigramIndex } from '../../../engine/TrigramIndex.js';
import { BM25FRanking } from '../../../engine/Ranking.js';
import { IFileSystem } from '../../../platform/FileSystem.js';
import { SymbolIndex } from '../../../types.js';
import { jest } from '@jest/globals';

// Mock dependencies
const mockFileSystem: IFileSystem = {
    readFile: jest.fn(),
    writeFile: jest.fn(),
    exists: jest.fn(),
    mkdir: jest.fn(),
    deleteFile: jest.fn(),
    rename: jest.fn(),
    readDir: jest.fn(),
    stat: jest.fn(),
    listFiles: jest.fn(),
    watch: jest.fn(),
    createDir: jest.fn()
} as any;

const mockTrigramIndex = {
    search: jest.fn(),
    listFiles: jest.fn(),
    ensureReady: jest.fn(),
    rebuild: jest.fn(),
    updateIgnoreGlobs: jest.fn(),
    refreshFile: jest.fn(),
    refreshDirectory: jest.fn()
} as unknown as TrigramIndex;

const mockBM25Ranking = {
    rank: jest.fn()
} as unknown as BM25FRanking;

const mockSymbolIndex = {
    getSymbolsForFile: jest.fn(),
    getAllSymbols: jest.fn()
} as unknown as SymbolIndex;

describe('HybridScorer', () => {
    let scorer: HybridScorer;

    beforeEach(() => {
        jest.clearAllMocks();
        scorer = new HybridScorer(
            '/root',
            mockFileSystem,
            mockTrigramIndex,
            mockBM25Ranking,
            mockSymbolIndex
        );
    });

    test('should calculate scores from multiple signals', async () => {
        // Setup mocks
        const content = 'function test() { return true; }';
        (mockFileSystem.readFile as unknown as jest.Mock<any>).mockResolvedValue(content);
        (mockSymbolIndex.getSymbolsForFile as unknown as jest.Mock<any>).mockResolvedValue([
            { name: 'test', type: 'function' }
        ]);
        (mockFileSystem.stat as unknown as jest.Mock<any>).mockResolvedValue({ mtime: Date.now() } as any);

        const result = await scorer.scoreFile(
            '/root/src/test.ts',
            content,
            ['test'],
            'test',
            10, // contentScoreRaw
            'code'
        );

        expect(result.total).toBeGreaterThan(0);
        expect(result.signals).toContain('content');
        expect(result.signals).toContain('filename'); // 'test' in 'test.ts'
        expect(result.signals).toContain('symbol');
    });

    test('should handle missing symbol index', async () => {
        const scorerWithoutSymbols = new HybridScorer(
            '/root',
            mockFileSystem,
            mockTrigramIndex,
            mockBM25Ranking
        );

        const content = 'some content';
        (mockFileSystem.readFile as unknown as jest.Mock<any>).mockResolvedValue(content);
        (mockFileSystem.stat as unknown as jest.Mock<any>).mockResolvedValue({ mtime: Date.now() } as any);

        const result = await scorerWithoutSymbols.scoreFile(
            '/root/doc.md',
            content,
            ['doc'],
            'doc',
            5,
            'file'
        );

        expect(result.signals).not.toContain('symbol');
        expect(result.breakdown.symbol).toBe(0);
    });
});
