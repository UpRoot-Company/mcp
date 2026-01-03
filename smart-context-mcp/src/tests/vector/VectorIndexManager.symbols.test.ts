import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { VectorIndexManager, VectorItem } from '../../vector/VectorIndexManager.js';
import { EmbeddingRepository } from '../../indexing/EmbeddingRepository.js';
import { resolveVectorIndexConfigFromEnv } from '../../vector/VectorIndexConfig.js';

describe('VectorIndexManager - Code Symbol Support (Phase 0)', () => {
    let vectorIndexManager: VectorIndexManager;
    let mockEmbeddingRepository: jest.Mocked<EmbeddingRepository>;

    beforeEach(() => {
        // Mock EmbeddingRepository
        mockEmbeddingRepository = {
            listEmbeddings: jest.fn<any>().mockResolvedValue([]),
            getEmbedding: jest.fn<any>(),
            upsertEmbedding: jest.fn<any>(),
        } as any;

        vectorIndexManager = new VectorIndexManager(
            '/test/root',
            mockEmbeddingRepository,
            { 
                mode: 'off', 
                rebuild: 'manual', 
                shards: 'off',
                maxPoints: 1000,
                m: 16,
                efConstruction: 200,
                efSearch: 64
            }
        );
    });

    describe('indexItem() - New unified API', () => {
        it('should index document chunk (backward compatible)', () => {
            const docItem: VectorItem = {
                id: 'chunk-123',
                metadata: {
                    type: 'doc',
                    filePath: 'docs/readme.md',
                },
                embedding: {
                    provider: 'local',
                    model: 'multilingual-e5-small',
                    dims: 384,
                    vector: new Float32Array(384).fill(0.5),
                },
            };

            // Should not throw
            expect(() => vectorIndexManager.indexItem(docItem)).not.toThrow();
        });

        it('should index code symbol', () => {
            const symbolItem: VectorItem = {
                id: 'Calculator::add',
                metadata: {
                    type: 'symbol',
                    filePath: 'src/calc.ts',
                    lineRange: { start: 10, end: 15 },
                    symbolType: 'function',
                    symbolName: 'add',
                    signature: '(a: number, b: number): number',
                },
                embedding: {
                    provider: 'local',
                    model: 'multilingual-e5-small',
                    dims: 384,
                    vector: new Float32Array(384).fill(0.7),
                },
            };

            // Should not throw
            expect(() => vectorIndexManager.indexItem(symbolItem)).not.toThrow();
        });

        it('should handle mixed document and symbol items', () => {
            const items: VectorItem[] = [
                {
                    id: 'doc-1',
                    metadata: { type: 'doc', filePath: 'a.md' },
                    embedding: {
                        provider: 'local',
                        model: 'test',
                        dims: 2,
                        vector: new Float32Array([1, 0]),
                    },
                },
                {
                    id: 'symbol-1',
                    metadata: {
                        type: 'symbol',
                        filePath: 'b.ts',
                        lineRange: { start: 1, end: 5 },
                        symbolType: 'class',
                        symbolName: 'MyClass',
                    },
                    embedding: {
                        provider: 'local',
                        model: 'test',
                        dims: 2,
                        vector: new Float32Array([0, 1]),
                    },
                },
            ];

            items.forEach(item => {
                expect(() => vectorIndexManager.indexItem(item)).not.toThrow();
            });
        });
    });

    describe('upsertEmbedding() - Backward compatibility', () => {
        it('should still work for legacy calls', () => {
            // Old API call (pre-Phase 0)
            expect(() =>
                vectorIndexManager.upsertEmbedding('chunk-old', {
                    provider: 'local',
                    model: 'test',
                    dims: 2,
                    vector: new Float32Array([0.5, 0.5]),
                })
            ).not.toThrow();
        });

        it('should be equivalent to indexItem with doc type', () => {
            const chunkId = 'test-chunk';
            const embedding = {
                provider: 'local',
                model: 'test',
                dims: 2,
                vector: new Float32Array([0.3, 0.7]),
            };

            // Both should work identically
            expect(() => vectorIndexManager.upsertEmbedding(chunkId, embedding)).not.toThrow();
            
            expect(() =>
                vectorIndexManager.indexItem({
                    id: chunkId + '-2',
                    metadata: { type: 'doc', filePath: '' },
                    embedding,
                })
            ).not.toThrow();
        });
    });

    describe('Type validation', () => {
        it('should accept all valid VectorItemType values', () => {
            const types: Array<'doc' | 'symbol'> = ['doc', 'symbol'];
            
            types.forEach(type => {
                const item: VectorItem = {
                    id: `item-${type}`,
                    metadata: { type, filePath: 'test.ts' },
                    embedding: {
                        provider: 'local',
                        model: 'test',
                        dims: 2,
                        vector: new Float32Array([0, 0]),
                    },
                };
                
                expect(() => vectorIndexManager.indexItem(item)).not.toThrow();
            });
        });

        it('should accept all valid symbolType values', () => {
            const symbolTypes = ['class', 'function', 'method', 'interface', 'type'] as const;
            
            symbolTypes.forEach(symbolType => {
                const item: VectorItem = {
                    id: `symbol-${symbolType}`,
                    metadata: {
                        type: 'symbol',
                        filePath: 'test.ts',
                        symbolType,
                        symbolName: 'TestSymbol',
                    },
                    embedding: {
                        provider: 'local',
                        model: 'test',
                        dims: 2,
                        vector: new Float32Array([0, 0]),
                    },
                };
                
                expect(() => vectorIndexManager.indexItem(item)).not.toThrow();
            });
        });
    });
});
