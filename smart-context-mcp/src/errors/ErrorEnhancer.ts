import { SymbolIndex } from '../ast/SymbolIndex.js';
import { EnhancedErrorDetails } from '../types.js';

export class ErrorEnhancer {
    /**
     * Enhance "Symbol not found" errors
     */
    static enhanceSymbolNotFound(
        symbolName: string,
        symbolIndex: SymbolIndex
    ): EnhancedErrorDetails {
        // symbolIndex.findSimilar was added in Phase 1
        const similar = symbolIndex.findSimilar(symbolName, 5);

        return {
            similarSymbols: similar.map(s => s.name),
            nextActionHint: similar.length > 0
                ? "Try one of the similar symbols above, or use search_project"
                : "Use search_project with type='symbol' to search across all files",
            toolSuggestions: [
                {
                    toolName: "search_project",
                    rationale: "Search for symbols across the entire codebase",
                    exampleArgs: {
                        query: symbolName,
                        type: "symbol",
                        maxResults: 10
                    },
                    priority: "high"
                },
                {
                    toolName: "read_code",
                    rationale: "If you know the file location, read it directly",
                    exampleArgs: {
                        filePath: "<path-to-file>",
                        view: "full"
                    },
                    priority: "medium"
                }
            ]
        };
    }

    /**
     * Enhance "Search not found" errors
     */
    static enhanceSearchNotFound(
        query: string,

    ): EnhancedErrorDetails {
        const isLikelyFilename = /^[A-Z0-9-_]+\.(ts|js|tsx|jsx|md|json)$/i.test(query);
        const isLikelyPattern = query.includes('*') || query.includes('ADR-');

        if (isLikelyFilename || isLikelyPattern) {
            return {
                nextActionHint: "Your query looks like a filename. Use type='filename' to search filenames instead of content",
                toolSuggestions: [
                    {
                        toolName: "search_project",
                        rationale: "Search by filename (searches filenames, not content)",
                        exampleArgs: {
                            query: query,
                            type: "filename",
                            maxResults: 10
                        },
                        priority: "high"
                    }
                ]
            };
        }

        return {
            nextActionHint: "Try broadening your search query or using different keywords",
            toolSuggestions: []
        };
    }
}
