import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { IntentToSymbolMapper } from '../../engine/IntentToSymbolMapper.js';
import { SymbolEmbeddingIndex } from '../../indexing/SymbolEmbeddingIndex.js';
import type { SymbolSearchResult } from '../../indexing/SymbolEmbeddingIndex.js';

describe('IntentToSymbolMapper - Phase 1 Smart Fuzzy Match', () => {
    let mapper: IntentToSymbolMapper;
    let mockSymbolEmbeddingIndex: jest.Mocked<SymbolEmbeddingIndex>;

    beforeEach(() => {
        // Mock SymbolEmbeddingIndex
        mockSymbolEmbeddingIndex = {
            searchSymbols: jest.fn<any>(),
            getStats: jest.fn<any>(),
        } as any;

        mapper = new IntentToSymbolMapper(mockSymbolEmbeddingIndex, {
            maxResults: 10,
            minConfidence: 0.3,
            enableExpansion: true,
        });
    });

    describe('parseIntent()', () => {
        it('should detect function type from query', () => {
            const intent = mapper.parseIntent('function that calculates total price');

            expect(intent.symbolTypes).toContain('function');
            expect(intent.keywords).toContain('calculates');
            expect(intent.keywords).toContain('total');
            expect(intent.keywords).toContain('price');
            expect(intent.confidence).toBeGreaterThan(0.5);
        });

        it('should detect class type from query', () => {
            const intent = mapper.parseIntent('class for user authentication');

            expect(intent.symbolTypes).toContain('class');
            expect(intent.keywords).toContain('user');
            expect(intent.keywords).toContain('authentication');
        });

        it('should detect method type from query', () => {
            const intent = mapper.parseIntent('method to validate email address');

            expect(intent.symbolTypes).toContain('method');
            expect(intent.keywords).toContain('validate');
            expect(intent.keywords).toContain('email');
        });

        it('should detect interface type from query', () => {
            const intent = mapper.parseIntent('interface for data repository');

            expect(intent.symbolTypes).toContain('interface');
            expect(intent.keywords).toContain('data');
            expect(intent.keywords).toContain('repository');
        });

        it('should handle queries without symbol type hints', () => {
            const intent = mapper.parseIntent('calculate tax amount');

            expect(intent.symbolTypes).toEqual(['any']);
            expect(intent.keywords).toContain('calculate');
            expect(intent.keywords).toContain('tax');
            expect(intent.keywords).toContain('amount');
        });

        it('should filter out stop words from keywords', () => {
            const intent = mapper.parseIntent('the function that is used for calculating the total');

            expect(intent.keywords).not.toContain('the');
            expect(intent.keywords).not.toContain('that');
            expect(intent.keywords).not.toContain('is');
            expect(intent.keywords).toContain('calculating');
            expect(intent.keywords).toContain('total');
        });

        it('should boost confidence when action verbs are present', () => {
            const withVerb = mapper.parseIntent('function that calculates price');
            const withoutVerb = mapper.parseIntent('price total sum');

            expect(withVerb.confidence).toBeGreaterThan(withoutVerb.confidence);
        });

        it('should penalize very short queries', () => {
            const shortQuery = mapper.parseIntent('calculate');
            const normalQuery = mapper.parseIntent('function to calculate total price');

            expect(shortQuery.confidence).toBeLessThan(normalQuery.confidence);
        });
    });

    describe('mapToSymbols()', () => {
        it('should map query to symbol search with correct parameters', async () => {
            const mockResults: SymbolSearchResult[] = [
                {
                    symbol: {
                        symbolId: 'Calculator::add',
                        name: 'add',
                        type: 'function',
                        filePath: 'calc.ts',
                        lineRange: { start: 1, end: 5 },
                    },
                    similarity: 0.9,
                    relevanceScore: 0.9,
                },
            ];

            mockSymbolEmbeddingIndex.searchSymbols.mockResolvedValue(mockResults);

            const results = await mapper.mapToSymbols('function that adds numbers');

            expect(mockSymbolEmbeddingIndex.searchSymbols).toHaveBeenCalled();
            expect(results).toHaveLength(1);
            expect(results[0].symbol.name).toBe('add');
        });

        it('should filter results by symbol type', async () => {
            mockSymbolEmbeddingIndex.searchSymbols.mockResolvedValue([]);

            await mapper.mapToSymbols('class for user management');

            // Verify searchSymbols was called with symbolTypes filter
            expect(mockSymbolEmbeddingIndex.searchSymbols).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    symbolTypes: ['class'],
                })
            );
        });

        it('should return empty array for low confidence queries', async () => {
            const results = await mapper.mapToSymbols('a b c', {
                minConfidence: 0.5,
            });

            expect(results).toEqual([]);
            expect(mockSymbolEmbeddingIndex.searchSymbols).not.toHaveBeenCalled();
        });

        it('should re-rank results based on keyword matching', async () => {
            const mockResults: SymbolSearchResult[] = [
                {
                    symbol: {
                        symbolId: 'calc1',
                        name: 'calculate',
                        type: 'function',
                        filePath: 'a.ts',
                        lineRange: { start: 1, end: 5 },
                    },
                    similarity: 0.8,
                    relevanceScore: 0.8,
                },
                {
                    symbol: {
                        symbolId: 'calc2',
                        name: 'calculateTotalPrice',
                        type: 'function',
                        filePath: 'b.ts',
                        lineRange: { start: 1, end: 5 },
                    },
                    similarity: 0.75,
                    relevanceScore: 0.75,
                },
            ];

            mockSymbolEmbeddingIndex.searchSymbols.mockResolvedValue(mockResults);

            const results = await mapper.mapToSymbols('calculate total price');

            // calculateTotalPrice should be ranked higher due to keyword matching
            expect(results[0].symbol.name).toBe('calculateTotalPrice');
        });

        it('should limit results to maxResults', async () => {
            const mockResults: SymbolSearchResult[] = Array.from({ length: 50 }, (_, i) => ({
                symbol: {
                    symbolId: `sym${i}`,
                    name: `symbol${i}`,
                    type: 'function',
                    filePath: 'test.ts',
                    lineRange: { start: 1, end: 5 },
                },
                similarity: 0.9 - i * 0.01,
                relevanceScore: 0.9 - i * 0.01,
            }));

            mockSymbolEmbeddingIndex.searchSymbols.mockResolvedValue(mockResults);

            const results = await mapper.mapToSymbols('test query', {
                maxResults: 5,
            });

            expect(results).toHaveLength(5);
        });
    });

    describe('Query Enhancement', () => {
        it('should enhance query with symbol type prefix when enabled', async () => {
            mockSymbolEmbeddingIndex.searchSymbols.mockResolvedValue([]);

            await mapper.mapToSymbols('function that validates input');

            // Check if searchSymbols was called with enhanced query
            const callArgs = mockSymbolEmbeddingIndex.searchSymbols.mock.calls[0];
            const enhancedQuery = callArgs[0] as string;

            expect(enhancedQuery).toContain('function');
        });

        it('should not enhance query when expansion is disabled', async () => {
            const mapperNoExpansion = new IntentToSymbolMapper(
                mockSymbolEmbeddingIndex,
                { enableExpansion: false }
            );

            mockSymbolEmbeddingIndex.searchSymbols.mockResolvedValue([]);

            await mapperNoExpansion.mapToSymbols('function that validates input');

            const callArgs = mockSymbolEmbeddingIndex.searchSymbols.mock.calls[0];
            const query = callArgs[0] as string;

            expect(query).toBe('function that validates input');
        });
    });

    describe('Multiple Symbol Types', () => {
        it('should detect multiple symbol types in one query', () => {
            const intent = mapper.parseIntent('class or interface for user model');

            expect(intent.symbolTypes).toContain('class');
            expect(intent.symbolTypes).toContain('interface');
        });

        it('should pass all detected types to search', async () => {
            mockSymbolEmbeddingIndex.searchSymbols.mockResolvedValue([]);

            await mapper.mapToSymbols('method or function to parse data');

            expect(mockSymbolEmbeddingIndex.searchSymbols).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({
                    symbolTypes: expect.arrayContaining(['method', 'function']),
                })
            );
        });
    });

    describe('Edge Cases', () => {
        it('should handle empty query', async () => {
            const results = await mapper.mapToSymbols('');

            expect(results).toEqual([]);
        });

        it('should handle query with only stop words', () => {
            const intent = mapper.parseIntent('the a an is are');

            expect(intent.keywords).toHaveLength(0);
            expect(intent.confidence).toBeLessThan(0.5);
        });

        it('should handle very long queries', async () => {
            const longQuery = 'function that calculates the total price including tax and discount for multiple items in the shopping cart based on user preferences and current promotions';
            
            mockSymbolEmbeddingIndex.searchSymbols.mockResolvedValue([]);
            
            const results = await mapper.mapToSymbols(longQuery);

            expect(mockSymbolEmbeddingIndex.searchSymbols).toHaveBeenCalled();
        });
    });

    describe('Configuration', () => {
        it('should return current configuration', () => {
            const config = mapper.getConfig();

            expect(config.maxResults).toBe(10);
            expect(config.minConfidence).toBe(0.3);
            expect(config.enableExpansion).toBe(true);
        });

        it('should respect custom configuration', async () => {
            const customMapper = new IntentToSymbolMapper(
                mockSymbolEmbeddingIndex,
                {
                    maxResults: 5,
                    minConfidence: 0.6,
                }
            );

            mockSymbolEmbeddingIndex.searchSymbols.mockResolvedValue([]);

            // Low confidence query should be rejected
            const results = await customMapper.mapToSymbols('test', {
                minConfidence: 0.6,
            });

            expect(results).toEqual([]);
        });
    });

    describe('Real-world Query Examples', () => {
        it('should handle "function to calculate tax"', () => {
            const intent = mapper.parseIntent('function to calculate tax');

            expect(intent.symbolTypes).toContain('function');
            expect(intent.keywords).toContain('calculate');
            expect(intent.keywords).toContain('tax');
            expect(intent.confidence).toBeGreaterThan(0.5);
        });

        it('should handle "class that manages user sessions"', () => {
            const intent = mapper.parseIntent('class that manages user sessions');

            expect(intent.symbolTypes).toContain('class');
            expect(intent.keywords).toContain('manages');
            expect(intent.keywords).toContain('user');
            expect(intent.keywords).toContain('sessions');
        });

        it('should handle "validate email method"', () => {
            const intent = mapper.parseIntent('validate email method');

            expect(intent.symbolTypes).toContain('method');
            expect(intent.keywords).toContain('validate');
            expect(intent.keywords).toContain('email');
        });

        it('should handle "parser for JSON data"', () => {
            const intent = mapper.parseIntent('parser for JSON data');

            expect(intent.keywords).toContain('parser');
            expect(intent.keywords).toContain('json');
            expect(intent.keywords).toContain('data');
        });
    });
});
