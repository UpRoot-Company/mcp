import type { EmbeddingProviderClient } from "../embeddings/EmbeddingProviderFactory.js";
import type { SymbolIndex } from "../ast/SymbolIndex.js";
import type { VectorIndexManager } from "../vector/VectorIndexManager.js";
import { SymbolVectorRepository, type CodeSymbol, type SymbolWithSimilarity } from "./SymbolVectorRepository.js";

/**
 * Configuration for SymbolEmbeddingIndex
 */
export interface SymbolEmbeddingConfig {
    /** Whether to enable symbol embedding indexing */
    enabled: boolean;
    /** Batch size for symbol indexing */
    batchSize: number;
    /** Minimum similarity threshold for search results */
    minSimilarity: number;
    /** Maximum number of results to return */
    maxResults: number;
}

const DEFAULT_CONFIG: SymbolEmbeddingConfig = {
    enabled: true,
    batchSize: 10,
    minSimilarity: 0.5,
    maxResults: 20,
};

/**
 * Search result from SymbolEmbeddingIndex
 */
export interface SymbolSearchResult {
    symbol: CodeSymbol;
    similarity: number;
    relevanceScore: number;
}

/**
 * SymbolEmbeddingIndex - Layer 3 Symbol-based Semantic Search
 * 
 * Provides embedding-based search over code symbols (classes, functions, methods).
 * Enables natural language queries to find relevant symbols by semantic similarity.
 * 
 * Phase 1 Smart Fuzzy Match component.
 */
export class SymbolEmbeddingIndex {
    private readonly config: SymbolEmbeddingConfig;
    private readonly symbolVectorRepo: SymbolVectorRepository;
    private indexedSymbolCount: number = 0;

    constructor(
        private readonly symbolIndex: SymbolIndex,
        private readonly vectorIndexManager: VectorIndexManager,
        private readonly embeddingProvider: EmbeddingProviderClient,
        config: Partial<SymbolEmbeddingConfig> = {}
    ) {
        this.config = { ...DEFAULT_CONFIG, ...config };
        this.symbolVectorRepo = new SymbolVectorRepository(
            vectorIndexManager,
            embeddingProvider,
            symbolIndex,
            {
                provider: embeddingProvider.provider,
                model: embeddingProvider.model,
            }
        );
    }

    /**
     * Index a single symbol with embedding
     */
    async indexSymbol(symbol: CodeSymbol): Promise<void> {
        if (!this.config.enabled) {
            return;
        }

        await this.symbolVectorRepo.indexSymbol(symbol);
        this.indexedSymbolCount++;
    }

    /**
     * Batch index multiple symbols (more efficient)
     */
    async batchIndex(symbols: CodeSymbol[]): Promise<void> {
        if (!this.config.enabled || symbols.length === 0) {
            return;
        }

        await this.symbolVectorRepo.indexSymbols(symbols, this.config.batchSize);
        this.indexedSymbolCount += symbols.length;
    }

    /**
     * Index all symbols from SymbolIndex
     */
    async indexAllSymbols(): Promise<void> {
        if (!this.config.enabled) {
            return;
        }

        const allSymbols = await this.extractAllSymbols();
        await this.batchIndex(allSymbols);
    }

    /**
     * Search for symbols by natural language query
     * 
     * @param query - Natural language description (e.g., "function that calculates total")
     * @param options - Search options
     * @returns Ranked list of matching symbols
     */
    async searchSymbols(
        query: string,
        options: {
            topK?: number;
            minSimilarity?: number;
            symbolTypes?: CodeSymbol['type'][];
        } = {}
    ): Promise<SymbolSearchResult[]> {
        if (!this.config.enabled) {
            return [];
        }

        const topK = options.topK ?? this.config.maxResults;
        const minSimilarity = options.minSimilarity ?? this.config.minSimilarity;

        // Get embedding-based matches
        const results = await this.symbolVectorRepo.searchSymbols(query, topK);

        // Filter by similarity threshold and symbol type
        let filtered = results.filter(r => r.similarity >= minSimilarity);

        if (options.symbolTypes && options.symbolTypes.length > 0) {
            filtered = filtered.filter(r => 
                options.symbolTypes!.includes(r.symbol.type)
            );
        }

        // Calculate relevance score (can be enhanced with more signals)
        return filtered.map(r => ({
            ...r,
            relevanceScore: this.calculateRelevanceScore(r.symbol, r.similarity, query),
        }));
    }

    /**
     * Get statistics about indexed symbols
     */
    getStats() {
        return {
            indexedSymbolCount: this.indexedSymbolCount,
            enabled: this.config.enabled,
            config: this.config,
        };
    }

    /**
     * Extract all symbols from SymbolIndex and convert to CodeSymbol format
     */
    private async extractAllSymbols(): Promise<CodeSymbol[]> {
        const symbols: CodeSymbol[] = [];
        // SymbolIndex doesn't have getAllFiles, we need to track indexed files separately
        // For now, return empty array (will be implemented when integrated with IncrementalIndexer)
        return symbols;
    }

    /**
     * Normalize SymbolIndex kind to CodeSymbol type
     */
    private normalizeSymbolType(kind: string): CodeSymbol['type'] {
        const normalized = kind.toLowerCase();
        
        if (normalized.includes('class')) return 'class';
        if (normalized.includes('function')) return 'function';
        if (normalized.includes('method')) return 'method';
        if (normalized.includes('interface')) return 'interface';
        if (normalized.includes('type')) return 'type';
        
        // Default to function
        return 'function';
    }

    /**
     * Calculate relevance score combining multiple signals
     */
    private calculateRelevanceScore(
        symbol: CodeSymbol,
        similarity: number,
        query: string
    ): number {
        let score = similarity;

        // Boost exact name matches
        const queryLower = query.toLowerCase();
        const nameLower = symbol.name.toLowerCase();
        
        if (nameLower === queryLower) {
            score *= 1.5;
        } else if (nameLower.includes(queryLower) || queryLower.includes(nameLower)) {
            score *= 1.2;
        }

        // Boost by symbol type (classes and interfaces are typically more important)
        if (symbol.type === 'class' || symbol.type === 'interface') {
            score *= 1.1;
        }

        return Math.min(score, 1.0);
    }
}
