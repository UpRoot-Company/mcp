import { ResultProcessor } from '../../../engine/search/ResultProcessor.js';
import { FileSearchResult } from '../../../types.js';

describe('ResultProcessor', () => {
    let processor: ResultProcessor;

    beforeEach(() => {
        processor = new ResultProcessor();
    });

    test('should filter by file type', () => {
        const results: FileSearchResult[] = [
            { filePath: 'test.ts', lineNumber: 1, preview: '' },
            { filePath: 'test.js', lineNumber: 1, preview: '' },
            { filePath: 'readme.md', lineNumber: 1, preview: '' }
        ];

        const processed = processor.postProcessResults(results, {
            fileTypes: ['ts', '.js'],
            snippetLength: 100
        });

        expect(processed).toHaveLength(2);
        expect(processed.some(r => r.filePath === 'test.ts')).toBe(true);
        expect(processed.some(r => r.filePath === 'test.js')).toBe(true);
        expect(processed.some(r => r.filePath === 'readme.md')).toBe(false);
    });

    test('should deduplicate by content', () => {
        const results: FileSearchResult[] = [
            { filePath: 'a.ts', lineNumber: 1, preview: 'content match' },
            { filePath: 'b.ts', lineNumber: 5, preview: 'content match' },
            { filePath: 'c.ts', lineNumber: 1, preview: 'other match' }
        ];

        const processed = processor.postProcessResults(results, {
            deduplicateByContent: true,
            snippetLength: 100
        });

        expect(processed).toHaveLength(2);
        // Should keep first occurrence of 'content match'
        expect(processed.find(r => r.preview === 'content match')).toBeDefined();
        expect(processed.find(r => r.preview === 'other match')).toBeDefined();
    });

    test('should group results by file', () => {
        const results: FileSearchResult[] = [
            { filePath: 'a.ts', lineNumber: 1, preview: 'match 1', score: 10 },
            { filePath: 'a.ts', lineNumber: 5, preview: 'match 2', score: 5 },
            { filePath: 'b.ts', lineNumber: 1, preview: 'match 3', score: 8 }
        ];

        const processed = processor.postProcessResults(results, {
            groupByFile: true,
            snippetLength: 100
        });

        expect(processed).toHaveLength(2);
        
        const fileA = processed.find(r => r.filePath === 'a.ts');
        expect(fileA).toBeDefined();
        expect(fileA!.groupedMatches).toHaveLength(2);
        expect(fileA!.matchCount).toBe(2);
        // Should use highest score for the group representative
        expect(fileA!.score).toBe(10);
    });
});
