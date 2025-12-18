import { CandidateCollector } from '../../../engine/search/CandidateCollector.js';
import { TrigramIndex } from '../../../engine/TrigramIndex.js';
import { SymbolIndex } from '../../../types.js';
import { jest } from '@jest/globals';

const mockTrigramIndex = {
    search: jest.fn(),
    listFiles: jest.fn(),
} as unknown as TrigramIndex;

const mockSymbolIndex = {
    getAllSymbols: jest.fn()
} as unknown as SymbolIndex;

describe('CandidateCollector', () => {
    let collector: CandidateCollector;

    beforeEach(() => {
        jest.clearAllMocks();
        collector = new CandidateCollector(
            '/root',
            mockTrigramIndex,
            mockSymbolIndex
        );
    });

    test('should collect candidates from trigram index', async () => {
        (mockTrigramIndex.search as unknown as jest.Mock<any>).mockResolvedValue([
            { filePath: 'src/a.ts' },
            { filePath: 'src/b.ts' }
        ]);
        (mockTrigramIndex.listFiles as unknown as jest.Mock<any>).mockReturnValue(['src/a.ts', 'src/b.ts', 'src/c.ts']);
        (mockSymbolIndex.getAllSymbols as unknown as jest.Mock<any>).mockResolvedValue(new Map());

        const candidates = await collector.collectHybridCandidates(['query']);
        
        expect(candidates.has('src/a.ts')).toBe(true);
        expect(candidates.has('src/b.ts')).toBe(true);
    });

    test('should collect candidates from filename matching', async () => {
        (mockTrigramIndex.search as unknown as jest.Mock<any>).mockResolvedValue([]);
        (mockTrigramIndex.listFiles as unknown as jest.Mock<any>).mockReturnValue(['src/user.ts', 'src/config.json']);
        (mockSymbolIndex.getAllSymbols as unknown as jest.Mock<any>).mockResolvedValue(new Map());

        const candidates = await collector.collectHybridCandidates(['user']);
        
        expect(candidates.has('src/user.ts')).toBe(true);
        expect(candidates.has('src/config.json')).toBe(true);
    });

    test('should fallback to all files if few candidates found', async () => {
        (mockTrigramIndex.search as unknown as jest.Mock<any>).mockResolvedValue([]);
        (mockTrigramIndex.listFiles as unknown as jest.Mock<any>).mockReturnValue(['src/a.ts', 'src/b.ts']);
        (mockSymbolIndex.getAllSymbols as unknown as jest.Mock<any>).mockResolvedValue(new Map());

        const candidates = await collector.collectHybridCandidates(['unknown']);
        
        // Should include fallback
        expect(candidates.size).toBe(2);
        expect(candidates.has('src/a.ts')).toBe(true);
    });
});
