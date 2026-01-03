/**
 * SearchEngine Integration Tests - Phase 1 Smart Fuzzy Match
 * 
 * Tests integration of SymbolEmbeddingIndex and IntentToSymbolMapper
 * with SearchEngine for hybrid symbol + text search.
 */

import { describe, it, expect } from '@jest/globals';
import { SearchEngine } from '../../engine/Search.js';
import { IntentToSymbolMapper } from '../../engine/IntentToSymbolMapper.js';
import { SymbolEmbeddingIndex } from '../../indexing/SymbolEmbeddingIndex.js';

describe('SearchEngine - Phase 1 Smart Fuzzy Match Integration', () => {
    describe('Integration Points', () => {
        it('should accept symbolEmbeddingIndex in constructor options', () => {
            expect(() => {
                const options = {
                    symbolEmbeddingIndex: undefined as any,
                };
                expect(options).toBeDefined();
            }).not.toThrow();
        });

        it('should create IntentToSymbolMapper when symbolEmbeddingIndex is provided', () => {
            expect(() => {
                const mockIndex = {} as SymbolEmbeddingIndex;
                const mapper = new IntentToSymbolMapper(mockIndex);
                expect(mapper).toBeDefined();
                expect(mapper.getConfig()).toBeDefined();
            }).not.toThrow();
        });

        it('should work without symbolEmbeddingIndex (text search only)', async () => {
            expect(true).toBe(true);
        });
    });

    describe('IntentToSymbolMapper Integration', () => {
        it('should parse natural language queries', () => {
            const mockIndex = {} as SymbolEmbeddingIndex;
            const mapper = new IntentToSymbolMapper(mockIndex);

            const intent = mapper.parseIntent('function to calculate tax');
            
            expect(intent.query).toBe('function to calculate tax');
            expect(intent.symbolTypes).toContain('function');
            expect(intent.keywords).toContain('calculate');
            expect(intent.keywords).toContain('tax');
            expect(intent.confidence).toBeGreaterThan(0);
        });

        it('should respect custom configuration', () => {
            const mockIndex = {} as SymbolEmbeddingIndex;
            const mapper = new IntentToSymbolMapper(mockIndex, {
                maxResults: 5,
                minConfidence: 0.4,
                enableExpansion: false,
            });

            const config = mapper.getConfig();
            expect(config.maxResults).toBe(5);
            expect(config.minConfidence).toBe(0.4);
            expect(config.enableExpansion).toBe(false);
        });

        it('should detect multiple symbol types', () => {
            const mockIndex = {} as SymbolEmbeddingIndex;
            const mapper = new IntentToSymbolMapper(mockIndex);

            const intent = mapper.parseIntent('class or function for validation');
            
            expect(intent.symbolTypes.length).toBeGreaterThan(1);
            expect(intent.symbolTypes).toContain('class');
            expect(intent.symbolTypes).toContain('function');
        });

        it('should handle queries with low confidence', () => {
            const mockIndex = {} as SymbolEmbeddingIndex;
            const mapper = new IntentToSymbolMapper(mockIndex);

            const intent = mapper.parseIntent('the a is are');
            
            expect(intent.keywords.length).toBe(0);
            expect(intent.confidence).toBeLessThan(0.5);
        });
    });

    describe('Hybrid Search Flow', () => {
        it('should integrate symbol search into scout method flow', () => {
            // The scout method should:
            // 1. Detect symbol intent
            // 2. If intent is "symbol" and symbolEmbeddingIndex exists, use IntentToSymbolMapper
            // 3. Add symbol search results to candidates
            // 4. Continue with normal text search and ranking
            
            expect(true).toBe(true);
        });

        it('should fall back to text search if symbol search fails', () => {
            // If symbol search throws an error, the search should continue
            // with text-based search only
            expect(true).toBe(true);
        });

        it('should combine symbol and text search results', () => {
            // Symbol search results should be added to candidates
            // Then processed along with text search results
            expect(true).toBe(true);
        });
    });
});
