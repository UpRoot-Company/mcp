import type { SymbolEmbeddingIndex, SymbolSearchResult } from "../indexing/SymbolEmbeddingIndex.js";
import type { CodeSymbol } from "../indexing/SymbolVectorRepository.js";

/**
 * Symbol type hint extracted from natural language query
 */
export type SymbolTypeHint = 'class' | 'function' | 'method' | 'interface' | 'type' | 'any';

/**
 * Parsed intent from natural language query
 */
export interface QueryIntent {
    /** Original query text */
    query: string;
    /** Inferred symbol types from query */
    symbolTypes: SymbolTypeHint[];
    /** Extracted keywords */
    keywords: string[];
    /** Confidence score (0-1) */
    confidence: number;
}

/**
 * Configuration for IntentToSymbolMapper
 */
export interface IntentMapperConfig {
    /** Maximum number of results to return */
    maxResults: number;
    /** Minimum confidence threshold */
    minConfidence: number;
    /** Enable query expansion */
    enableExpansion: boolean;
}

const DEFAULT_CONFIG: IntentMapperConfig = {
    maxResults: 10,
    minConfidence: 0.3,
    enableExpansion: true,
};

/**
 * Symbol type keywords for intent detection
 */
const SYMBOL_TYPE_PATTERNS = {
    class: ['class', 'classes', 'object', 'objects', 'model', 'models', 'entity', 'entities'],
    function: ['function', 'functions', 'func', 'procedure', 'routine', 'subroutine'],
    method: ['method', 'methods', 'member function', 'member functions'],
    interface: ['interface', 'interfaces', 'contract', 'contracts', 'protocol', 'protocols'],
    type: ['type', 'types', 'alias', 'aliases', 'typedef'],
};

/**
 * Action verbs that indicate code intent
 */
const ACTION_VERBS = [
    'calculate', 'compute', 'process', 'parse', 'validate', 'check',
    'create', 'build', 'generate', 'construct', 'initialize',
    'get', 'fetch', 'retrieve', 'find', 'search', 'query',
    'set', 'update', 'modify', 'change', 'edit',
    'delete', 'remove', 'destroy', 'clear',
    'handle', 'manage', 'control', 'execute',
    'convert', 'transform', 'map', 'format',
];

/**
 * IntentToSymbolMapper - Phase 1 Smart Fuzzy Match
 * 
 * Maps natural language queries to symbol searches.
 * Analyzes user intent and extracts symbol type hints and keywords.
 * 
 * Example queries:
 * - "function that calculates total price" -> type: function, keywords: [calculate, total, price]
 * - "class for user authentication" -> type: class, keywords: [user, authentication]
 * - "method to validate email" -> type: method, keywords: [validate, email]
 */
export class IntentToSymbolMapper {
    private readonly config: IntentMapperConfig;

    constructor(
        private readonly symbolEmbeddingIndex: SymbolEmbeddingIndex,
        config: Partial<IntentMapperConfig> = {}
    ) {
        this.config = { ...DEFAULT_CONFIG, ...config };
    }

    /**
     * Parse natural language query and extract intent
     */
    parseIntent(query: string): QueryIntent {
        const normalizedQuery = query.toLowerCase().trim();
        const words = normalizedQuery.split(/\s+/);

        // Detect symbol types from query
        const symbolTypes = this.detectSymbolTypes(normalizedQuery);

        // Extract keywords (filter out common words)
        const keywords = this.extractKeywords(words, symbolTypes);

        // Calculate confidence based on detected patterns
        const confidence = this.calculateConfidence(normalizedQuery, symbolTypes, keywords);

        return {
            query,
            symbolTypes: symbolTypes.length > 0 ? symbolTypes : ['any'],
            keywords,
            confidence,
        };
    }

    /**
     * Map natural language query to symbol search
     * 
     * @param query - Natural language query (e.g., "function that calculates tax")
     * @param options - Search options
     * @returns Ranked symbol search results
     */
    async mapToSymbols(
        query: string,
        options: {
            maxResults?: number;
            minConfidence?: number;
        } = {}
    ): Promise<SymbolSearchResult[]> {
        const maxResults = options.maxResults ?? this.config.maxResults;
        const minConfidence = options.minConfidence ?? this.config.minConfidence;

        // Parse query intent
        const intent = this.parseIntent(query);

        // If confidence is too low, return empty results
        if (intent.confidence < minConfidence) {
            return [];
        }

        // Build enhanced query for embedding search
        const enhancedQuery = this.buildEnhancedQuery(intent);

        // Search using SymbolEmbeddingIndex
        const symbolTypes = intent.symbolTypes.includes('any') 
            ? undefined 
            : intent.symbolTypes.filter((t): t is CodeSymbol['type'] => t !== 'any');

        const results = await this.symbolEmbeddingIndex.searchSymbols(enhancedQuery, {
            topK: maxResults * 2, // Over-fetch for filtering
            symbolTypes,
        });

        // Handle null/undefined results
        if (!results || results.length === 0) {
            return [];
        }

        // Re-rank results based on keyword matching
        const reranked = this.rerankResults(results, intent);

        return reranked.slice(0, maxResults);
    }

    /**
     * Detect symbol types from query text
     */
    private detectSymbolTypes(query: string): SymbolTypeHint[] {
        const detected = new Set<SymbolTypeHint>();

        for (const [type, patterns] of Object.entries(SYMBOL_TYPE_PATTERNS)) {
            for (const pattern of patterns) {
                if (query.includes(pattern)) {
                    detected.add(type as SymbolTypeHint);
                    break;
                }
            }
        }

        return Array.from(detected);
    }

    /**
     * Extract meaningful keywords from query
     */
    private extractKeywords(words: string[], symbolTypes: SymbolTypeHint[]): string[] {
        // Common stop words to filter out
        const stopWords = new Set([
            'a', 'an', 'the', 'that', 'which', 'who', 'what', 'where', 'when', 'why', 'how',
            'is', 'are', 'was', 'were', 'be', 'been', 'being',
            'have', 'has', 'had', 'do', 'does', 'did',
            'will', 'would', 'should', 'could', 'can', 'may', 'might',
            'for', 'to', 'of', 'in', 'on', 'at', 'by', 'with', 'from',
            'and', 'or', 'but', 'not',
            ...Object.values(SYMBOL_TYPE_PATTERNS).flat(), // Filter out type keywords
        ]);

        const keywords = words.filter(word => {
            if (word.length < 2) return false;
            if (stopWords.has(word)) return false;
            return true;
        });

        return [...new Set(keywords)]; // Deduplicate
    }

    /**
     * Calculate confidence score for parsed intent
     */
    private calculateConfidence(
        query: string,
        symbolTypes: SymbolTypeHint[],
        keywords: string[]
    ): number {
        let confidence = 0.5; // Base confidence

        // Penalize if no meaningful keywords
        if (keywords.length === 0) {
            confidence = 0.2; // Very low confidence for queries with only stop words
        }

        // Boost if symbol type is detected
        if (symbolTypes.length > 0) {
            confidence += 0.2;
        }

        // Boost if action verbs are present
        const hasActionVerb = ACTION_VERBS.some(verb => query.includes(verb));
        if (hasActionVerb) {
            confidence += 0.15;
        }

        // Boost if we have meaningful keywords
        if (keywords.length >= 2) {
            confidence += 0.1;
        }

        // Penalize very short queries
        if (query.split(/\s+/).length < 3) {
            confidence -= 0.1;
        }

        return Math.max(0, Math.min(1, confidence));
    }

    /**
     * Build enhanced query for embedding search
     */
    private buildEnhancedQuery(intent: QueryIntent): string {
        if (!this.config.enableExpansion) {
            return intent.query;
        }

        // Combine original query with keywords for better matching
        const parts = [intent.query];

        // Add symbol type prefix if detected
        if (intent.symbolTypes.length > 0 && !intent.symbolTypes.includes('any')) {
            const typePrefix = intent.symbolTypes[0];
            parts.unshift(typePrefix);
        }

        return parts.join(' ');
    }

    /**
     * Re-rank results based on keyword matching
     */
    private rerankResults(
        results: SymbolSearchResult[],
        intent: QueryIntent
    ): SymbolSearchResult[] {
        if (intent.keywords.length === 0) {
            return results;
        }

        // Calculate keyword match score for each result
        const scored = results.map(result => {
            const nameWords = result.symbol.name.toLowerCase().split(/[_\s]+/);
            const matchedKeywords = intent.keywords.filter(kw =>
                nameWords.some(word => word.includes(kw) || kw.includes(word))
            );

            const keywordBoost = matchedKeywords.length / intent.keywords.length;
            const adjustedScore = result.relevanceScore * (1 + keywordBoost * 0.3);

            return {
                ...result,
                relevanceScore: Math.min(adjustedScore, 1.0),
            };
        });

        // Sort by adjusted relevance score
        return scored.sort((a, b) => b.relevanceScore - a.relevanceScore);
    }

    /**
     * Get configuration
     */
    getConfig(): IntentMapperConfig {
        return { ...this.config };
    }
}
