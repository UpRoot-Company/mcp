import type { VectorIndexManager, VectorItem, VectorItemMetadata } from "../vector/VectorIndexManager.js";
import type { EmbeddingProviderClient } from "../embeddings/EmbeddingProviderFactory.js";
import type { SymbolIndex } from "../ast/SymbolIndex.js";

/**
 * CodeSymbol interface for Layer 3 Smart Fuzzy Match
 */
export interface CodeSymbol {
    symbolId: string;
    name: string;
    type: 'class' | 'function' | 'method' | 'interface' | 'type';
    filePath: string;
    lineRange: { start: number; end: number };
    range: { startByte: number; endByte: number }; // For indexRange resolution
    signature?: string;
    content?: string; // For embedding
}

/**
 * Symbol search result with similarity score
 */
export interface SymbolWithSimilarity {
    symbol: CodeSymbol;
    similarity: number;
}

/**
 * Bridge between SymbolIndex and VectorIndexManager
 * Enables embedding-based symbol search for Layer 3
 */
export class SymbolVectorRepository {
    private readonly vectorIndexManager: VectorIndexManager;
    private readonly embeddingProvider: EmbeddingProviderClient;
    private readonly symbolIndex: SymbolIndex;
    private readonly provider: string;
    private readonly model: string;

    constructor(
        vectorIndexManager: VectorIndexManager,
        embeddingProvider: EmbeddingProviderClient,
        symbolIndex: SymbolIndex,
        options: { provider: string; model: string }
    ) {
        this.vectorIndexManager = vectorIndexManager;
        this.embeddingProvider = embeddingProvider;
        this.symbolIndex = symbolIndex;
        this.provider = options.provider;
        this.model = options.model;
    }

    /**
     * Index a single symbol with embedding
     */
    async indexSymbol(symbol: CodeSymbol): Promise<void> {
        // Generate text for embedding: "function_name signature"
        const textForEmbedding = this.buildSymbolText(symbol);
        
        // Get embedding
        const embeddings = await this.embeddingProvider.embed([textForEmbedding]);
        if (embeddings.length === 0) {
            throw new Error(`Failed to generate embedding for symbol: ${symbol.symbolId}`);
        }

        // Create VectorItem
        const item: VectorItem = {
            id: symbol.symbolId,
            metadata: {
                type: 'symbol',
                filePath: symbol.filePath,
                lineRange: symbol.lineRange,
                symbolType: symbol.type,
                symbolName: symbol.name,
                signature: symbol.signature,
            },
            embedding: {
                provider: this.provider,
                model: this.model,
                dims: embeddings[0].length,
                vector: embeddings[0],
            },
        };

        // Index via VectorIndexManager
        this.vectorIndexManager.indexItem(item);
    }

    /**
     * Batch index symbols (optimized for performance)
     */
    async indexSymbols(symbols: CodeSymbol[], batchSize = 10): Promise<void> {
        for (let i = 0; i < symbols.length; i += batchSize) {
            const batch = symbols.slice(i, i + batchSize);
            const texts = batch.map(s => this.buildSymbolText(s));
            
            // Batch embedding for efficiency
            const embeddings = await this.embeddingProvider.embed(texts);
            
            // Index each symbol
            for (let j = 0; j < batch.length; j++) {
                const symbol = batch[j];
                const embedding = embeddings[j];
                
                if (!embedding) continue;
                
                const item: VectorItem = {
                    id: symbol.symbolId,
                    metadata: {
                        type: 'symbol',
                        filePath: symbol.filePath,
                        lineRange: symbol.lineRange,
                        symbolType: symbol.type,
                        symbolName: symbol.name,
                        signature: symbol.signature,
                    },
                    embedding: {
                        provider: this.provider,
                        model: this.model,
                        dims: embedding.length,
                        vector: embedding,
                    },
                };
                
                this.vectorIndexManager.indexItem(item);
            }
        }
    }

    /**
     * Search symbols by natural language query
     */
    async searchSymbols(query: string, topK = 3): Promise<SymbolWithSimilarity[]> {
        // Embed query
        const queryEmbeddings = await this.embeddingProvider.embed([query]);
        if (queryEmbeddings.length === 0) {
            return [];
        }

        // Search via VectorIndexManager
        const results = await this.vectorIndexManager.search(queryEmbeddings[0], {
            provider: this.provider,
            model: this.model,
            k: topK,
        });

        if (results.degraded || results.ids.length === 0) {
            return [];
        }

        // Convert IDs back to CodeSymbols with similarity scores
        // Note: In a real implementation, we'd need to store metadata
        // For now, return partial results
        return results.ids.map((id, index) => ({
            symbol: {
                symbolId: id,
                name: id.split('::').pop() ?? id,
                type: 'function' as const,
                filePath: '',
                lineRange: { start: 0, end: 0 },
                range: { startByte: 0, endByte: 0 },
            },
            similarity: results.scores.get(id) ?? 0,
        }));
    }

    /**
     * Update a symbol (re-index with new embedding)
     */
    async updateSymbol(symbolId: string, symbol: CodeSymbol): Promise<void> {
        // Remove old version
        this.vectorIndexManager.removeChunk(symbolId);
        
        // Index new version
        await this.indexSymbol(symbol);
    }

    /**
     * Remove a symbol from index
     */
    removeSymbol(symbolId: string): void {
        this.vectorIndexManager.removeChunk(symbolId);
    }

    /**
     * Build text representation of symbol for embedding
     * Format: "type name signature"
     */
    private buildSymbolText(symbol: CodeSymbol): string {
        const parts: string[] = [];
        
        // Include type
        parts.push(symbol.type);
        
        // Include name
        parts.push(symbol.name);
        
        // Include signature if available
        if (symbol.signature) {
            parts.push(symbol.signature);
        }
        
        // Include content if available (for better context)
        if (symbol.content) {
            parts.push(symbol.content);
        }
        
        return parts.join(' ');
    }
}
