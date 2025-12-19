import { DependencyGraph } from '../ast/DependencyGraph.js';
import { CallGraphBuilder } from '../ast/CallGraphBuilder.js';
import { SymbolIndex } from '../ast/SymbolIndex.js';
import { Edit, ImpactPreview, ImpactRiskLevel, SymbolInfo, DefinitionSymbol } from '../types.js';
import * as path from 'path';

export class ImpactAnalyzer {
    constructor(
        private dependencyGraph: DependencyGraph,
        private callGraphBuilder: CallGraphBuilder,
        private symbolIndex: SymbolIndex,
        private pagerankScores?: Map<string, number> // Tier 1 PageRank scores
    ) {}

    public setPagerankScores(scores: Map<string, number>) {
        this.pagerankScores = scores;
    }

    public async analyzeImpact(filePath: string, edits: Edit[]): Promise<ImpactPreview> {
        // 1. Identify modified symbols
        const symbolsInFile = await this.symbolIndex.getSymbolsForFile(filePath);
        const modifiedSymbols = this.identifyModifiedSymbols(symbolsInFile, edits);

        // 2. Transitive file dependencies (Downstream = outgoing)
        const impactedFiles = await this.dependencyGraph.getTransitiveDependencies(filePath, 'outgoing');
        
        // 3. Breaking change detection (e.g. visibility changes)
        const breakingChanges = await this.detectBreakingChanges(symbolsInFile, edits);

        // 4. Risk Scoring
        const riskScore = await this.calculateRiskScore(filePath, modifiedSymbols, impactedFiles, breakingChanges);
        const riskLevel = this.mapScoreToRiskLevel(riskScore);

        // 5. Collect suggested tests
        const suggestedTests = await this.findRelatedTests(filePath, impactedFiles);

        return {
            filePath,
            riskLevel,
            summary: {
                incomingCount: (await this.dependencyGraph.getTransitiveDependencies(filePath, 'incoming')).length,
                outgoingCount: impactedFiles.length,
                impactedFiles: impactedFiles.map(f => path.relative(process.cwd(), f))
            },
            editCount: edits.length,
            suggestedTests,
            notes: this.generateImpactNotes(riskScore, modifiedSymbols, breakingChanges)
        };
    }

    private identifyModifiedSymbols(symbols: SymbolInfo[], edits: Edit[]): string[] {
        const modified: string[] = [];
        for (const edit of edits) {
            if (edit.lineRange) {
                const affected = symbols.filter(s => 
                    s.range.startLine <= edit.lineRange!.end && 
                    s.range.endLine >= edit.lineRange!.start
                );
                modified.push(...affected.map(s => s.name));
            }
        }
        return Array.from(new Set(modified));
    }

    private async detectBreakingChanges(symbols: SymbolInfo[], edits: Edit[]): Promise<string[]> {
        const breaking: string[] = [];
        for (const edit of edits) {
            // Heuristic: If an export is deleted or modified in a way that changes its name/type
            // This is simplified; a full impl would compare AST before/after
            if (edit.replacementString === "" && edit.targetString.includes("export")) {
                breaking.push(`Potential deletion of exported symbol in block: "${edit.targetString.slice(0, 30)}..."`);
            }
        }
        return breaking;
    }

    private async calculateRiskScore(filePath: string, modifiedSymbols: string[], impactedFiles: string[], breakingChanges: string[]): Promise<number> {
        let score = 0;

        // Factor 1: Blast radius (File count) - Up to 30 points
        score += Math.min(impactedFiles.length * 3, 30);

        // Factor 2: Modified symbols count - Up to 20 points
        score += Math.min(modifiedSymbols.length * 5, 20);

        // Factor 3: PageRank / Architectural Importance - Up to 30 points
        if (this.pagerankScores) {
            let maxPR = 0;
            for (const sym of modifiedSymbols) {
                const pr = this.pagerankScores.get(`${filePath}:${sym}`) || 0;
                maxPR = Math.max(maxPR, pr);
            }
            score += maxPR * 30;
        }

        // Factor 4: Breaking changes - Up to 20 points
        score += Math.min(breakingChanges.length * 10, 20);

        // Factor 5: Entry point bonus
        if (filePath.includes('index.ts') || filePath.includes('main.ts') || filePath.includes('App.tsx')) {
            score += 10;
        }

        return Math.min(score, 100);
    }

    private mapScoreToRiskLevel(score: number): ImpactRiskLevel {
        if (score >= 70) return 'high';
        if (score >= 35) return 'medium';
        return 'low';
    }

    private async findRelatedTests(filePath: string, impactedFiles: string[]): Promise<string[]> {
        const tests: string[] = [];
        const allFiles = [filePath, ...impactedFiles];
        
        for (const file of allFiles) {
            const base = path.basename(file, path.extname(file));
            const testFile = path.join(path.dirname(file), `${base}.test.ts`);
            tests.push(testFile);
        }
        return Array.from(new Set(tests)).slice(0, 5);
    }

    private generateImpactNotes(score: number, modifiedSymbols: string[], breakingChanges: string[]): string[] {
        const notes: string[] = [];
        if (score >= 70) notes.push("CRITICAL RISK: This change affects high-importance architectural components.");
        else if (score >= 35) notes.push("MEDIUM RISK: Significant downstream impact detected.");
        
        if (breakingChanges.length > 0) {
            notes.push(...breakingChanges.map(bc => `BREAKING CHANGE: ${bc}`));
        }
        
        if (modifiedSymbols.length > 0) {
            notes.push(`Modified symbols: ${modifiedSymbols.join(', ')}`);
        }
        return notes;
    }
}
