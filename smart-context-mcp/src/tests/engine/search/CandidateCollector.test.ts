import { CandidateCollector } from '../../../engine/search/CandidateCollector.js';
import { TrigramIndex } from '../../../engine/TrigramIndex.js';
import { SymbolIndex } from '../../../types.js';
import { jest, beforeEach, describe, test, expect } from '@jest/globals';

const mockTrigramIndex = {
    search: jest.fn(),
    listFiles: jest.fn().mockReturnValue([]),
} as unknown as TrigramIndex;

const mockSymbolIndex = {
    getAllSymbols: jest.fn(),
    getSymbolsForFile: jest.fn(),
    findFilesBySymbolName: jest.fn()
} as unknown as SymbolIndex;

describe('CandidateCollector', () => {
    const testRoot = '/unique-test-root';

    let collector: CandidateCollector;

    beforeEach(() => {
        collector = new CandidateCollector(
            testRoot,
            mockTrigramIndex,
            mockSymbolIndex
        );
        jest.clearAllMocks();
        (mockTrigramIndex.listFiles as jest.Mock).mockReturnValue([]);
    });

    test('should collect candidates from trigram index', async () => {
        (mockTrigramIndex.search as jest.Mock<any>).mockResolvedValue([
            { filePath: 'alpha.ts', score: 0.8 },
            { filePath: 'beta.ts', score: 0.5 }
        ]);
        (mockSymbolIndex.findFilesBySymbolName as jest.Mock<any>).mockResolvedValue([]);

        const candidates = await collector.collectHybridCandidates(['query']);

        expect(candidates.has('alpha.ts')).toBe(true);
        expect(candidates.has('beta.ts')).toBe(true);
    });

    test('should prioritize filename matches over fallback', async () => {
        (mockTrigramIndex.search as jest.Mock<any>).mockResolvedValue([]);
        (mockTrigramIndex.listFiles as jest.Mock<any>).mockReturnValue([
            'src/match.ts',
            'src/other1.ts',
            'src/other2.ts',
            'src/other3.ts',
            'src/other4.ts',
            'src/other5.ts'
        ]);
        (mockSymbolIndex.findFilesBySymbolName as jest.Mock<any>).mockResolvedValue([]);

        const candidates = await collector.collectHybridCandidates(['match']);

        // Must include the explicit match
        expect(candidates.has('src/match.ts')).toBe(true);
        // Size should be at least 1, and might contain others due to fallback
        expect(candidates.size).toBeGreaterThan(0);
    });
});
