import { SymbolIndex } from '../ast/SymbolIndex.js';
import { EnhancedErrorDetails, ToolSuggestion } from '../types.js';
import { AgentWorkflowGuidance } from '../engine/AgentPlaybook.js';

export class ErrorEnhancer {
    /**
     * Enhance "Symbol not found" errors
     */
    static enhanceSymbolNotFound(
        symbolName: string,
        symbolIndex: SymbolIndex
    ): EnhancedErrorDetails {
        const similar = (symbolIndex as any).findSimilar(symbolName, 5) || [];
        
        const suggestions: ToolSuggestion[] = [
            {
                toolName: "search_project",
                rationale: "Search for the symbol name in code contents if it might not be indexed.",
                exampleArgs: { query: symbolName, type: "symbol" },
                priority: "high"
            }
        ];

        // Add recovery strategy from playbook
        const strategy = AgentWorkflowGuidance.recovery.find(r => r.code === "AMBIGUOUS_MATCH");
        if (strategy) {
            suggestions.push({
                toolName: strategy.action.toolName,
                rationale: strategy.action.rationale,
                exampleArgs: strategy.action.exampleArgs,
                priority: "medium"
            });
        }

        return {
            similarSymbols: similar.map((s: any) => s.name),
            nextActionHint: `Symbol '${symbolName}' not found. Try searching or check for typos.`,
            toolSuggestions: suggestions
        };
    }

    /**
     * Enhance "Search not found" errors
     */
    static enhanceSearchNotFound(
        query: string
    ): EnhancedErrorDetails {
        const isLikelyFilename = /^[A-Z0-9-_]+\.(ts|js|tsx|jsx|md|json)$/i.test(query);
        
        const suggestions: ToolSuggestion[] = [];
        
        if (isLikelyFilename) {
            suggestions.push({
                toolName: "search_project",
                rationale: "Try searching with type='filename' for more accurate file matching.",
                exampleArgs: { query, type: "filename" },
                priority: "high"
            });
        }

        return {
            nextActionHint: `No results found for '${query}'. Try adjusting your search type or query.`,
            toolSuggestions: suggestions
        };
    }

    /**
     * Enhance "Edit target not found" (NO_MATCH) errors
     */
    static enhanceNoMatch(filePath: string, targetString?: string): EnhancedErrorDetails {
        const strategy = AgentWorkflowGuidance.recovery.find(r => r.code === "NO_MATCH");
        const suggestions: ToolSuggestion[] = [];

        if (strategy) {
            suggestions.push({
                toolName: strategy.action.toolName,
                rationale: strategy.action.rationale,
                exampleArgs: { ...strategy.action.exampleArgs, filePath },
                priority: "high"
            });
        }

        return {
            nextActionHint: `Target block not found in ${filePath}. Use read_code(fragment) to verify the current content.`,
            toolSuggestions: suggestions
        };
    }

    /**
     * Enhance "Hash mismatch" errors
     */
    static enhanceHashMismatch(filePath: string): EnhancedErrorDetails {
        const strategy = AgentWorkflowGuidance.recovery.find(r => r.code === "HASH_MISMATCH");
        const suggestions: ToolSuggestion[] = [];

        if (strategy) {
            suggestions.push({
                toolName: strategy.action.toolName,
                rationale: strategy.action.rationale,
                exampleArgs: { ...strategy.action.exampleArgs, filePath },
                priority: "high"
            });
        }

        return {
            nextActionHint: `File ${filePath} has changed since it was last read. Refresh its metadata.`,
            toolSuggestions: suggestions
        };
    }

    /**
     * Enhance "Index stale" errors
     */
    static enhanceIndexStale(): EnhancedErrorDetails {
        const strategy = AgentWorkflowGuidance.recovery.find(r => r.code === "INDEX_STALE");
        const suggestions: ToolSuggestion[] = [];

        if (strategy) {
            suggestions.push({
                toolName: strategy.action.toolName,
                rationale: strategy.action.rationale,
                exampleArgs: strategy.action.exampleArgs,
                priority: "medium"
            });
        }

        return {
            nextActionHint: "The project index may be outdated. Check index status or wait for reindexing.",
            toolSuggestions: suggestions
        };
    }
}
