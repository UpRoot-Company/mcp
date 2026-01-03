import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { SymbolEmbeddingIndex } from '../../indexing/SymbolEmbeddingIndex.js';
import { SymbolIndex } from '../../ast/SymbolIndex.js';
import { VectorIndexManager } from '../../vector/VectorIndexManager.js';
import type { EmbeddingProviderClient } from '../../embeddings/EmbeddingProviderFactory.js';
import type { CodeSymbol } from '../../indexing/SymbolVectorRepository.js';

describe('SymbolEmbeddingIndex - Phase 1 Smart Fuzzy Match', () => {
    let symbolEmbeddingIndex: SymbolEmbeddingIndex;
    let mockSymbolIndex: jest.Mocked<SymbolIndex>;
    let mockVectorIndexManager: jest.Mocked<VectorIndexManager>;
    let mockEmbeddingProvider: jest.Mocked<EmbeddingProviderClient>;

    beforeEach(() => {
        // Mock SymbolIndex
        mockSymbolIndex = {} as any;

        // Mock VectorIndexManager
        mockVectorIndexManager = {
            indexItem: jest.fn<any>(),
            search: jest.fn<any>(),
        } as any;

        // Mock EmbeddingProvider
        mockEmbeddingProvider = {
            provider: 'local',
            model: 'multilingual-e5-small',
            dims: 384,
            normalize: true,
            embed: jest.fn<any>(),
        } as any;

        symbolEmbeddingIndex = new SymbolEmbeddingIndex(
            mockSymbolIndex,
            mockVectorIndexManager,
            mockEmbeddingProvider,
            {
                enabled: true,
                batchSize: 5,
                minSimilarity: 0.5,
                maxResults: 10,
            }
        );
    });

    describe('Configuration', () => {
        it('should initialize with default config', () => {
            const stats = symbolEmbeddingIndex.getStats();
            expect(stats.enabled).toBe(true);
            expect(stats.config.batchSize).toBe(5);
            expect(stats.config.minSimilarity).toBe(0.5);
        });

        it('should respect disabled config', async () => {
            const disabledIndex = new SymbolEmbeddingIndex(
                mockSymbolIndex,
                mockVectorIndexManager,
                mockEmbeddingProvider,
                { enabled: false }
            );

            const symbol: CodeSymbol = {
                symbolId: 'test::func',
                name: 'func',
                type: 'function',
                filePath: 'test.ts',
                lineRange: { start: 1, end: 5 },
                range: { startByte: 0, endByte: 100 },
            };

            await disabledIndex.indexSymbol(symbol);
            
            expect(mockEmbeddingProvider.embed).not.toHaveBeenCalled();
        });
    });

    describe('indexSymbol()', () => {
        it('should index a single symbol', async () => {
            const symbol: CodeSymbol = {
                symbolId: 'Calculator::add',
                name: 'add',
                type: 'function',
                filePath: 'src/calc.ts',
                lineRange: { start: 10, end: 15 },
                range: { startByte: 100, endByte: 200 },
                signature: '(a: number, b: number): number',
            };

            mockEmbeddingProvider.embed.mockResolvedValue([
                new Float32Array(384).fill(0.5)
            ]);

            await symbolEmbeddingIndex.indexSymbol(symbol);

            expect(mockEmbeddingProvider.embed).toHaveBeenCalledWith([
                'function add (a: number, b: number): number'
            ]);
            expect(mockVectorIndexManager.indexItem).toHaveBeenCalled();

            const stats = symbolEmbeddingIndex.getStats();
            expect(stats.indexedSymbolCount).toBe(1);
        });

        it('should handle symbols without signature', async () => {
            const symbol: CodeSymbol = {
                symbolId: 'MyClass',
                name: 'MyClass',
                type: 'class',
                filePath: 'src/class.ts',
                range: { startByte: 0, endByte: 500 },
                lineRange: { start: 1, end: 50 },
            };

            mockEmbeddingProvider.embed.mockResolvedValue([
                new Float32Array(384).fill(0.7)
            ]);

            await symbolEmbeddingIndex.indexSymbol(symbol);

            expect(mockEmbeddingProvider.embed).toHaveBeenCalledWith(['class MyClass']);
            expect(mockVectorIndexManager.indexItem).toHaveBeenCalled();
        });
    });

    describe('batchIndex()', () => {
        it('should batch index multiple symbols efficiently', async () => {
            const symbols: CodeSymbol[] = [
                {
                    symbolId: 'func1',
                    name: 'func1',
                    type: 'function',
                    filePath: 'a.ts',
                    lineRange: { start: 1, end: 5 },                    range: { startByte: 0, endByte: 100 },                },
                {
                    symbolId: 'func2',
                    name: 'func2',
                    type: 'function',
                    filePath: 'b.ts',
                    lineRange: { start: 1, end: 5 },                    range: { startByte: 100, endByte: 200 },                },
                {
                    symbolId: 'func3',
                    name: 'func3',
                    type: 'function',
                    filePath: 'c.ts',
                    lineRange: { start: 1, end: 5 },                    range: { startByte: 200, endByte: 300 },                },
            ];

            mockEmbeddingProvider.embed.mockResolvedValue(
                symbols.map(() => new Float32Array(384).fill(0.6))
            );

            await symbolEmbeddingIndex.batchIndex(symbols);

            // Should call embed once per batch (batchSize=5, so 1 batch)
            expect(mockEmbeddingProvider.embed).toHaveBeenCalledTimes(1);
            expect(mockVectorIndexManager.indexItem).toHaveBeenCalledTimes(3);

            const stats = symbolEmbeddingIndex.getStats();
            expect(stats.indexedSymbolCount).toBe(3);
        });

        it('should handle empty symbol array', async () => {
            await symbolEmbeddingIndex.batchIndex([]);
            
            expect(mockEmbeddingProvider.embed).not.toHaveBeenCalled();
        });
    });

    describe('searchSymbols()', () => {
        it('should search symbols by natural language query', async () => {
            const queryEmbedding = new Float32Array(384).fill(0.8);
            mockEmbeddingProvider.embed.mockResolvedValue([queryEmbedding]);

            mockVectorIndexManager.search.mockResolvedValue({
                ids: ['Calculator::add', 'Math::sum'],
                scores: new Map([
                    ['Calculator::add', 0.95],
                    ['Math::sum', 0.85],
                ]),
                degraded: false,
            });

            const results = await symbolEmbeddingIndex.searchSymbols(
                'function that adds numbers',
                { topK: 5, minSimilarity: 0.5 }
            );

            expect(mockEmbeddingProvider.embed).toHaveBeenCalledWith([
                'function that adds numbers'
            ]);
            expect(results).toHaveLength(2);
            expect(results[0].symbol.symbolId).toBe('Calculator::add');
            expect(results[0].similarity).toBe(0.95);
            expect(results[0].relevanceScore).toBeGreaterThan(0);
        });

        it('should filter by minimum similarity threshold', async () => {
            mockEmbeddingProvider.embed.mockResolvedValue([
                new Float32Array(384).fill(0.7)
            ]);

            mockVectorIndexManager.search.mockResolvedValue({
                ids: ['weak::match', 'strong::match'],
                scores: new Map([
                    ['weak::match', 0.3],  // Below threshold
                    ['strong::match', 0.9],
                ]),
                degraded: false,
            });

            const results = await symbolEmbeddingIndex.searchSymbols('test query', {
                minSimilarity: 0.5,
            });

            // Only strong match should pass
            expect(results).toHaveLength(1);
            expect(results[0].symbol.symbolId).toBe('strong::match');
        });

        it('should return empty array when disabled', async () => {
            const disabledIndex = new SymbolEmbeddingIndex(
                mockSymbolIndex,
                mockVectorIndexManager,
                mockEmbeddingProvider,
                { enabled: false }
            );

            const results = await disabledIndex.searchSymbols('test query');
            
            expect(results).toEqual([]);
            expect(mockEmbeddingProvider.embed).not.toHaveBeenCalled();
        });
    });

    describe('Relevance Scoring', () => {
        it('should boost exact name matches', async () => {
            mockEmbeddingProvider.embed.mockResolvedValue([
                new Float32Array(384).fill(0.7)
            ]);

            mockVectorIndexManager.search.mockResolvedValue({
                ids: ['calculate', 'calculateSum'],
                scores: new Map([
                    ['calculate', 0.8],
                    ['calculateSum', 0.8],  // Same similarity
                ]),
                degraded: false,
            });

            const results = await symbolEmbeddingIndex.searchSymbols('calculate');

            // Exact match 'calculate' should have higher relevance score
            expect(results[0].symbol.name).toBe('calculate');
            expect(results[0].relevanceScore).toBeGreaterThan(results[1].relevanceScore);
        });

        it('should cap relevance score at 1.0', async () => {
            mockEmbeddingProvider.embed.mockResolvedValue([
                new Float32Array(384).fill(0.9)
            ]);

            mockVectorIndexManager.search.mockResolvedValue({
                ids: ['perfectMatch'],
                scores: new Map([['perfectMatch', 1.0]]),
                degraded: false,
            });

            const results = await symbolEmbeddingIndex.searchSymbols('perfectMatch');

            expect(results[0].relevanceScore).toBeLessThanOrEqual(1.0);
        });
    });

    describe('Integration with SymbolVectorRepository', () => {
        it('should pass correct parameters to SymbolVectorRepository', async () => {
            const symbol: CodeSymbol = {
                symbolId: 'test::symbol',
                name: 'symbol',
                type: 'method',
                filePath: 'test.ts',
                lineRange: { start: 5, end: 10 },
                range: { startByte: 100, endByte: 200 },
                signature: '(): void',
            };

            mockEmbeddingProvider.embed.mockResolvedValue([
                new Float32Array(384).fill(0.5)
            ]);

            await symbolEmbeddingIndex.indexSymbol(symbol);

            // Verify VectorIndexManager.indexItem was called with correct structure
            expect(mockVectorIndexManager.indexItem).toHaveBeenCalledWith(
                expect.objectContaining({
                    id: 'test::symbol',
                    metadata: expect.objectContaining({
                        type: 'symbol',
                        filePath: 'test.ts',
                        symbolType: 'method',
                    }),
                    embedding: expect.objectContaining({
                        provider: 'local',
                        model: 'multilingual-e5-small',
                        dims: 384,
                    }),
                })
            );
        });
    });
});
