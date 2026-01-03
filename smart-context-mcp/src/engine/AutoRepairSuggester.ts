import { AstChange } from '../ast/AstDiffEngine.js';
import { ImpactedSymbol } from './SymbolImpactAnalyzer.js';
import { Edit } from '../types.js';
import * as fs from 'fs/promises';

/**
 * Suggested repair edit for a breaking change
 */
export interface RepairEdit extends Edit {
    reason: string;
    confidence: number; // 0-1
    autoApplicable: boolean;
}

/**
 * Result of repair suggestion generation
 */
export interface RepairSuggestionResult {
    suggestedEdits: RepairEdit[];
    totalSuggestions: number;
    autoApplicableCount: number;
    summary: string;
}

/**
 * AutoRepairSuggester generates suggested edits to fix
 * breaking changes detected by SymbolImpactAnalyzer.
 */
export class AutoRepairSuggester {
    constructor() {}

    /**
     * Generate repair suggestions for breaking changes
     */
    public async suggestRepairs(
        astChanges: AstChange[],
        impactedSymbols: ImpactedSymbol[]
    ): Promise<RepairSuggestionResult> {
        const suggestedEdits: RepairEdit[] = [];

        // Group impacted symbols by file
        const symbolsByFile = new Map<string, ImpactedSymbol[]>();
        for (const symbol of impactedSymbols) {
            const existing = symbolsByFile.get(symbol.filePath) || [];
            existing.push(symbol);
            symbolsByFile.set(symbol.filePath, existing);
        }

        // Generate repairs for each affected file
        for (const [filePath, symbols] of symbolsByFile) {
            try {
                let fileContent = '';
                try {
                    fileContent = await fs.readFile(filePath, 'utf-8');
                } catch (readError) {
                    // File doesn't exist - generate generic repairs anyway
                }
                
                const repairs = await this.generateRepairsForFile(
                    filePath,
                    fileContent,
                    symbols,
                    astChanges
                );
                suggestedEdits.push(...repairs);
            } catch (error) {
                // Skip files we can't process
                console.warn(`Failed to generate repairs for ${filePath}:`, error);
                continue;
            }
        }

        const autoApplicableCount = suggestedEdits.filter(e => e.autoApplicable).length;

        return {
            suggestedEdits,
            totalSuggestions: suggestedEdits.length,
            autoApplicableCount,
            summary: this.generateSummary(suggestedEdits, autoApplicableCount)
        };
    }

    /**
     * Generate repair suggestions for a specific file
     */
    private async generateRepairsForFile(
        filePath: string,
        content: string,
        impactedSymbols: ImpactedSymbol[],
        astChanges: AstChange[]
    ): Promise<RepairEdit[]> {
        const repairs: RepairEdit[] = [];

        // For each impacted symbol, generate repairs for all breaking changes
        for (const symbol of impactedSymbols) {
            if (!symbol.isBreaking) {
                continue;
            }

            // Try all breaking AST changes
            for (const change of astChanges) {
                if (!change.isBreaking) {
                    continue;
                }

                const repair = this.generateRepairForChange(
                    filePath,
                    content,
                    symbol,
                    change
                );

                if (repair) {
                    repairs.push(repair);
                }
            }
        }

        return repairs;
    }

    /**
     * Generate a specific repair for a symbol/change combination
     */
    private generateRepairForChange(
        filePath: string,
        content: string,
        symbol: ImpactedSymbol,
        change: AstChange
    ): RepairEdit | null {
        switch (change.type) {
            case 'parameter-add':
                return this.generateParameterAddRepair(filePath, content, symbol, change);
            
            case 'parameter-remove':
                return this.generateParameterRemoveRepair(filePath, content, symbol, change);
            
            case 'signature-change':
                return this.generateSignatureChangeRepair(filePath, content, symbol, change);
            
            default:
                // For other change types, we can't auto-suggest
                return null;
        }
    }

    /**
     * Generate repair for added parameters
     */
    private generateParameterAddRepair(
        filePath: string,
        content: string,
        symbol: ImpactedSymbol,
        change: AstChange
    ): RepairEdit | null {
        const oldCount = (change.details?.oldCount as number) || 0;
        const newCount = (change.details?.newCount as number) || 0;
        const addedCount = newCount - oldCount;

        if (addedCount <= 0) {
            return null;
        }

        // Generate default values
        const defaultValues: string[] = [];
        for (let i = 0; i < addedCount; i++) {
            defaultValues.push(this.generateDefaultValue(`param${i}`));
        }

        // Return generic suggestion (works even without file content)
        return {
            targetString: '',
            replacementString: '',
            lineRange: {
                start: symbol.lineNumber,
                end: symbol.lineNumber
            },
            reason: `${change.symbolName}() now requires ${addedCount} more parameter(s). Suggested values: ${defaultValues.join(', ')}`,
            confidence: 0.6,
            autoApplicable: false
        };
    }

    /**
     * Generate repair for removed parameters
     */
    private generateParameterRemoveRepair(
        filePath: string,
        content: string,
        symbol: ImpactedSymbol,
        change: AstChange
    ): RepairEdit | null {
        const lines = content.split('\n');
        const targetLine = lines[symbol.lineNumber - 1];

        if (!targetLine) {
            return null;
        }

        const removed = (change.details?.removed as string[]) || [];
        const oldCount = (change.details?.oldCount as number) || 0;
        const newCount = (change.details?.newCount as number) || 0;

        // Simple heuristic: remove last N parameters
        const callPattern = new RegExp(`\\b${this.escapeRegex(change.symbolName)}\\s*\\(`);
        const match = callPattern.exec(targetLine);

        if (!match) {
            return null;
        }

        // This is a simplified repair - real implementation would need to parse AST
        return {
            targetString: targetLine,
            replacementString: targetLine, // Placeholder - would need actual logic
            lineRange: {
                start: symbol.lineNumber,
                end: symbol.lineNumber
            },
            reason: `Remove ${removed.length} parameter(s) from ${change.symbolName}() call`,
            confidence: 0.5, // Low confidence - needs manual review
            autoApplicable: false
        };
    }

    /**
     * Generate repair for signature changes
     */
    private generateSignatureChangeRepair(
        filePath: string,
        content: string,
        symbol: ImpactedSymbol,
        change: AstChange
    ): RepairEdit | null {
        // For general signature changes, we provide a suggestion but mark it as non-auto-applicable
        return {
            targetString: '', // User will need to identify exact location
            replacementString: '',
            lineRange: {
                start: symbol.lineNumber,
                end: symbol.lineNumber
            },
            reason: `Update call to ${change.symbolName}() to match new signature: ${change.newSignature}`,
            confidence: 0.3,
            autoApplicable: false
        };
    }

    /**
     * Generate a default value for a parameter based on its name/type
     */
    private generateDefaultValue(paramName: string): string {
        // Simple heuristics based on parameter name
        const lowerName = paramName.toLowerCase();

        if (lowerName.includes('count') || lowerName.includes('index') || lowerName.includes('num')) {
            return '0';
        }
        if (lowerName.includes('name') || lowerName.includes('str') || lowerName.includes('text')) {
            return "''";
        }
        if (lowerName.includes('flag') || lowerName.includes('is') || lowerName.includes('has')) {
            return 'false';
        }
        if (lowerName.includes('array') || lowerName.includes('list') || lowerName.includes('items')) {
            return '[]';
        }
        if (lowerName.includes('object') || lowerName.includes('config') || lowerName.includes('options')) {
            return '{}';
        }

        // Default fallback
        return 'undefined';
    }

    /**
     * Escape special regex characters
     */
    private escapeRegex(str: string): string {
        return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    /**
     * Generate summary of repair suggestions
     */
    private generateSummary(repairs: RepairEdit[], autoApplicableCount: number): string {
        if (repairs.length === 0) {
            return 'No repair suggestions generated';
        }

        const parts: string[] = [];
        parts.push(`${repairs.length} repair suggestion(s) generated`);

        if (autoApplicableCount > 0) {
            parts.push(`${autoApplicableCount} can be auto-applied`);
        } else {
            parts.push('all require manual review');
        }

        // Count by reason type
        const addParams = repairs.filter(r => r.reason.includes('Add')).length;
        const removeParams = repairs.filter(r => r.reason.includes('Remove')).length;
        const updateSig = repairs.filter(r => r.reason.includes('Update')).length;

        const types: string[] = [];
        if (addParams > 0) types.push(`${addParams} parameter additions`);
        if (removeParams > 0) types.push(`${removeParams} parameter removals`);
        if (updateSig > 0) types.push(`${updateSig} signature updates`);

        if (types.length > 0) {
            parts.push(`including ${types.join(', ')}`);
        }

        return parts.join(', ');
    }
}
