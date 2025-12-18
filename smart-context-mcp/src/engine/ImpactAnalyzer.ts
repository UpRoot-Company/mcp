import { DependencyGraph } from '../ast/DependencyGraph.js';
import { CallGraphBuilder } from '../ast/CallGraphBuilder.js';
import { SymbolIndex } from '../ast/SymbolIndex.js';
import { Edit, ImpactPreview, ImpactRiskLevel } from '../types.js';
import * as path from 'path';

export class ImpactAnalyzer {
    constructor(
        private dependencyGraph: DependencyGraph,
        private callGraphBuilder: CallGraphBuilder,
        private symbolIndex: SymbolIndex
    ) {}

    public async analyzeImpact(filePath: string, edits: Edit[]): Promise<ImpactPreview> {
        // 1. Identify modified symbols
        const symbolsInFile = await this.symbolIndex.getSymbolsForFile(filePath);
        const modifiedSymbols = this.identifyModifiedSymbols(symbolsInFile, edits);

        // 2. Transitive file dependencies (Downstream = outgoing)
        const impactedFiles = await this.dependencyGraph.getTransitiveDependencies(filePath, 'outgoing');
        
        // 3. Risk Scoring
        const riskScore = await this.calculateRiskScore(filePath, modifiedSymbols, impactedFiles);
        const riskLevel = this.mapScoreToRiskLevel(riskScore);

        // 4. Collect suggested tests
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
            notes: this.generateImpactNotes(riskScore, modifiedSymbols)
        };
    }

    private identifyModifiedSymbols(symbols: any[], edits: Edit[]): string[] {
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

    private async calculateRiskScore(filePath: string, modifiedSymbols: string[], impactedFiles: string[]): Promise<number> {
        let score = 0;

        // Factor 1: Blast radius (File count)
        score += Math.min(impactedFiles.length * 5, 40);

        // Factor 2: Modified symbols count
        score += Math.min(modifiedSymbols.length * 10, 30);

        // Factor 3: Entry point or important file
        if (filePath.includes('index.ts') || filePath.includes('main.ts')) {
            score += 20;
        }

        return score;
    }

    private mapScoreToRiskLevel(score: number): ImpactRiskLevel {
        if (score >= 60) return 'high';
        if (score >= 30) return 'medium';
        return 'low';
    }

    private async findRelatedTests(filePath: string, impactedFiles: string[]): Promise<string[]> {
        const tests: string[] = [];
        const allFiles = [filePath, ...impactedFiles];
        
        for (const file of allFiles) {
            const base = path.basename(file, path.extname(file));
            const testFile = path.join(path.dirname(file), `${base}.test.ts`);
            // In a real impl, we'd check if this file exists on disk
            tests.push(testFile);
        }
        return Array.from(new Set(tests)).slice(0, 5);
    }

    private generateImpactNotes(score: number, modifiedSymbols: string[]): string[] {
        const notes: string[] = [];
        if (score >= 60) notes.push("HIGH RISK: This change affects core architectural components.");
        if (modifiedSymbols.length > 0) notes.push(`Modified symbols: ${modifiedSymbols.join(', ')}`);
        return notes;
    }
}
