import { ImpactAnalyzer } from '../engine/ImpactAnalyzer.js';
import { DependencyGraph } from '../ast/DependencyGraph.js';
import { CallGraphBuilder } from '../ast/CallGraphBuilder.js';
import { SymbolIndex } from '../ast/SymbolIndex.js';
import { jest } from '@jest/globals';

describe('ImpactAnalyzer', () => {
    const mockDepGraph = {
        getTransitiveDependencies: jest.fn<any>().mockResolvedValue(['fileB.ts', 'fileC.ts'])
    } as unknown as DependencyGraph;

    const mockCallGraph = {} as unknown as CallGraphBuilder;

    const mockSymbolIndex = {
        getSymbolsForFile: jest.fn<any>().mockResolvedValue([
            { name: 'MyClass', range: { startLine: 10, endLine: 50 } }
        ])
    } as unknown as SymbolIndex;

    const analyzer = new ImpactAnalyzer(mockDepGraph, mockCallGraph, mockSymbolIndex);

    it('should calculate risk score and level correctly', async () => {
        const edits = [{ targetString: '...', replacementString: '...', lineRange: { start: 15, end: 20 } }];
        const preview = await analyzer.analyzeImpact('src/main.ts', edits);

        // NEW SCORING LOGIC:
        // Factor 1: 2 files * 3 = 6
        // Factor 2: 1 symbol * 5 = 5
        // Factor 3: PageRank = 0 (not set)
        // Factor 4: Breaking = 0
        // Factor 5: main.ts = 10
        // Total = 21 -> 'low'
        expect(preview.riskLevel).toBe('low');
        expect(preview.summary.impactedFiles).toContain('fileB.ts');
    });

    it('should detect high risk with PageRank scores', async () => {
        const scores = new Map<string, number>();
        scores.set('src/important.ts:SuperSymbol', 1.0); // Max importance
        analyzer.setPagerankScores(scores);

        const edits = [{ targetString: '...', replacementString: '...', lineRange: { start: 10, end: 20 } }];
        const mockSymbols = [{ name: 'SuperSymbol', range: { startLine: 5, endLine: 25 } }];
        (mockSymbolIndex.getSymbolsForFile as any).mockResolvedValueOnce(mockSymbols);

        const preview = await analyzer.analyzeImpact('src/important.ts', edits);
        
        // PageRank factor alone adds 30 points
        expect(preview.riskLevel).toBe('medium');
        expect(preview.notes).toContain("Modified symbols: SuperSymbol");
    });

    it('should detect breaking changes for export removals', async () => {
        const edits = [{ targetString: 'export class Deleted {}', replacementString: '', lineRange: { start: 1, end: 5 } }];
        const preview = await analyzer.analyzeImpact('src/lib.ts', edits);
        
        expect(preview.notes?.some(n => n.includes('BREAKING CHANGE'))).toBe(true);
    });

    it('should identify modified symbols based on line ranges', async () => {
        const edits = [{ targetString: '...', replacementString: '...', lineRange: { start: 60, end: 70 } }];
        const preview = await analyzer.analyzeImpact('src/service.ts', edits);
        
        expect(preview.notes).not.toContain('Modified symbols: MyClass');
    });
});
