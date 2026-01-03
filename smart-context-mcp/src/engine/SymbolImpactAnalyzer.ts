import { CallGraphBuilder } from '../ast/CallGraphBuilder.js';
import { SymbolIndex } from '../ast/SymbolIndex.js';
import { AstDiffEngine, type AstDiffResult, type AstChange } from '../ast/AstDiffEngine.js';
import { Edit, DefinitionSymbol } from '../types.js';
import * as path from 'path';

// Re-export for convenience
export type { AstChange } from '../ast/AstDiffEngine.js';

/**
 * Impact level for a symbol change
 */
export type SymbolImpactLevel = 'none' | 'low' | 'medium' | 'high' | 'critical';

/**
 * Information about an impacted symbol
 */
export interface ImpactedSymbol {
    symbolName: string;
    symbolType: DefinitionSymbol['type'];
    filePath: string;
    lineNumber: number;
    impactReason: string;
    isBreaking: boolean;
}

/**
 * Result of symbol impact analysis
 */
export interface SymbolImpactResult {
    filePath: string;
    impactLevel: SymbolImpactLevel;
    astChanges: AstChange[];
    impactedSymbols: ImpactedSymbol[];
    upstreamCallers: string[]; // Files that call modified symbols
    downstreamCallees: string[]; // Files called by modified symbols
    riskScore: number; // 0-100
    summary: string;
}

/**
 * Request for symbol impact analysis
 */
export interface SymbolImpactRequest {
    filePath: string;
    oldContent: string;
    newContent: string;
    maxDepth?: number; // CallGraph traversal depth (default: 3)
}

/**
 * SymbolImpactAnalyzer uses AST diffing and call graph analysis
 * to identify symbols affected by code changes and assess risk.
 */
export class SymbolImpactAnalyzer {
    constructor(
        private symbolIndex: SymbolIndex,
        private callGraphBuilder: CallGraphBuilder,
        private astDiffEngine: AstDiffEngine
    ) {}

    /**
     * Analyze the impact of proposed code changes
     */
    public async analyzeImpact(request: SymbolImpactRequest): Promise<SymbolImpactResult> {
        const { filePath, oldContent, newContent, maxDepth = 3 } = request;

        // 1. Detect AST-level changes
        const astDiff = await this.astDiffEngine.diff(filePath, oldContent, newContent);

        // 2. Find impacted symbols via call graph
        const impactedSymbols = await this.findImpactedSymbols(
            filePath,
            astDiff,
            maxDepth
        );

        // 3. Calculate risk score
        const riskScore = this.calculateRiskScore(astDiff, impactedSymbols);
        const impactLevel = this.mapScoreToLevel(riskScore);

        // 4. Identify upstream and downstream files
        const { upstreamCallers, downstreamCallees } = await this.identifyDependentFiles(
            filePath,
            astDiff
        );

        // 5. Generate summary
        const summary = this.generateSummary(astDiff, impactedSymbols, riskScore);

        return {
            filePath,
            impactLevel,
            astChanges: astDiff.changes,
            impactedSymbols,
            upstreamCallers,
            downstreamCallees,
            riskScore,
            summary
        };
    }

    /**
     * Find symbols that are impacted by the changes
     */
    private async findImpactedSymbols(
        filePath: string,
        astDiff: AstDiffResult,
        maxDepth: number
    ): Promise<ImpactedSymbol[]> {
        const impacted: ImpactedSymbol[] = [];

        for (const change of astDiff.changes) {
            // Only analyze breaking changes that affect exports
            if (!change.isBreaking) {
                continue;
            }

            // For removed or modified symbols, find callers
            if (change.type === 'remove' || change.type === 'signature-change' || change.type === 'visibility-change') {
                const callers = await this.findCallers(
                    change.symbolName,
                    filePath,
                    maxDepth
                );
                impacted.push(...callers);
            }
        }

        return impacted;
    }

    /**
     * Find all symbols that call the given symbol
     */
    private async findCallers(
        symbolName: string,
        filePath: string,
        maxDepth: number
    ): Promise<ImpactedSymbol[]> {
        const impacted: ImpactedSymbol[] = [];

        try {
            const callGraph = await this.callGraphBuilder.analyzeSymbol(
                symbolName,
                filePath,
                'upstream', // Find callers
                maxDepth
            );

            if (!callGraph) {
                return impacted;
            }

            // Traverse upstream edges to find callers
            const visited = new Set<string>();
            const traverse = (nodeId: string, depth: number) => {
                if (depth > maxDepth || visited.has(nodeId)) {
                    return;
                }
                visited.add(nodeId);

                const node = callGraph.visitedNodes[nodeId];
                if (!node) {
                    return;
                }

                // Add this caller as impacted
                if (node.symbolName !== symbolName) {
                    impacted.push({
                        symbolName: node.symbolName,
                        symbolType: node.symbolType,
                        filePath: node.filePath,
                        lineNumber: node.range.startLine,
                        impactReason: `Calls modified symbol '${symbolName}'`,
                        isBreaking: true
                    });
                }

                // Recurse to callers of this symbol
                for (const edge of node.callers) {
                    traverse(edge.fromSymbolId, depth + 1);
                }
            };

            // Start from the root node
            traverse(callGraph.root.symbolId, 0);

        } catch (error) {
            // If call graph analysis fails, return empty result
            console.warn(`Failed to build call graph for ${symbolName}:`, error);
        }

        return impacted;
    }

    /**
     * Identify files that depend on or are depended upon by the changed file
     */
    private async identifyDependentFiles(
        filePath: string,
        astDiff: AstDiffResult
    ): Promise<{ upstreamCallers: string[]; downstreamCallees: string[] }> {
        const upstreamCallers = new Set<string>();
        const downstreamCallees = new Set<string>();

        for (const symbolName of astDiff.affectedSymbols) {
            try {
                // Find upstream callers
                const callGraphUp = await this.callGraphBuilder.analyzeSymbol(
                    symbolName,
                    filePath,
                    'upstream',
                    2 // Shallow depth for file-level
                );

                if (callGraphUp) {
                    for (const nodeId of Object.keys(callGraphUp.visitedNodes)) {
                        const node = callGraphUp.visitedNodes[nodeId];
                        if (node.filePath !== filePath) {
                            upstreamCallers.add(node.filePath);
                        }
                    }
                }

                // Find downstream callees
                const callGraphDown = await this.callGraphBuilder.analyzeSymbol(
                    symbolName,
                    filePath,
                    'downstream',
                    2
                );

                if (callGraphDown) {
                    for (const nodeId of Object.keys(callGraphDown.visitedNodes)) {
                        const node = callGraphDown.visitedNodes[nodeId];
                        if (node.filePath !== filePath) {
                            downstreamCallees.add(node.filePath);
                        }
                    }
                }

            } catch (error) {
                // Silently continue if analysis fails for a symbol
                continue;
            }
        }

        return {
            upstreamCallers: Array.from(upstreamCallers),
            downstreamCallees: Array.from(downstreamCallees)
        };
    }

    /**
     * Calculate risk score (0-100) based on changes and impact
     */
    private calculateRiskScore(astDiff: AstDiffResult, impactedSymbols: ImpactedSymbol[]): number {
        let score = 0;

        // Factor 1: Number of breaking changes (up to 30 points)
        const breakingChanges = astDiff.changes.filter((c: AstChange) => c.isBreaking);
        score += Math.min(breakingChanges.length * 10, 30);

        // Factor 2: Number of impacted symbols (up to 40 points)
        score += Math.min(impactedSymbols.length * 5, 40);

        // Factor 3: Type of changes (up to 30 points)
        const hasSignatureChange = astDiff.changes.some((c: AstChange) => c.type === 'signature-change');
        const hasVisibilityChange = astDiff.changes.some((c: AstChange) => c.type === 'visibility-change');
        const hasRemoval = astDiff.changes.some((c: AstChange) => c.type === 'remove');

        if (hasRemoval) {
            score += 15; // Removals are very risky
        }
        if (hasSignatureChange) {
            score += 10;
        }
        if (hasVisibilityChange) {
            score += 5;
        }

        return Math.min(score, 100);
    }

    /**
     * Map risk score to impact level
     */
    private mapScoreToLevel(score: number): SymbolImpactLevel {
        if (score >= 80) return 'critical';
        if (score >= 60) return 'high';
        if (score >= 40) return 'medium';
        if (score >= 20) return 'low';
        return 'none';
    }

    /**
     * Generate human-readable summary
     */
    private generateSummary(
        astDiff: AstDiffResult,
        impactedSymbols: ImpactedSymbol[],
        riskScore: number
    ): string {
        const breakingChanges = astDiff.changes.filter((c: AstChange) => c.isBreaking);
        const parts: string[] = [];

        if (breakingChanges.length > 0) {
            parts.push(`${breakingChanges.length} breaking change(s) detected`);
        }

        if (impactedSymbols.length > 0) {
            const uniqueFiles = new Set(impactedSymbols.map(s => s.filePath)).size;
            parts.push(`${impactedSymbols.length} symbol(s) in ${uniqueFiles} file(s) may be affected`);
        }

        // List specific change types
        const changeTypes = new Set(astDiff.changes.map((c: AstChange) => c.type));
        const typeDescriptions: string[] = [];
        if (changeTypes.has('signature-change')) typeDescriptions.push('signature changes');
        if (changeTypes.has('parameter-add')) typeDescriptions.push('new parameters');
        if (changeTypes.has('parameter-remove')) typeDescriptions.push('removed parameters');
        if (changeTypes.has('remove')) typeDescriptions.push('symbol removals');
        if (changeTypes.has('visibility-change')) typeDescriptions.push('visibility changes');

        if (typeDescriptions.length > 0) {
            parts.push(`Changes include: ${typeDescriptions.join(', ')}`);
        }

        if (parts.length === 0) {
            return 'No significant impact detected';
        }

        return parts.join('. ') + `.`;
    }
}
