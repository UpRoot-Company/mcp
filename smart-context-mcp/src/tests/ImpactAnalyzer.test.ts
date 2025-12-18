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

        // Factor 1: 2 files * 5 = 10
        // Factor 2: 1 symbol * 10 = 10
        // Factor 3: main.ts = 20
        // Total = 40 -> 'medium'
        expect(preview.riskLevel).toBe('medium');
        expect(preview.summary.impactedFiles).toContain('fileB.ts');
    });

    it('should identify modified symbols based on line ranges', async () => {
        const edits = [{ targetString: '...', replacementString: '...', lineRange: { start: 60, end: 70 } }];
        const preview = await analyzer.analyzeImpact('src/service.ts', edits);
        
        expect(preview.notes).not.toContain('Modified symbols: MyClass');
    });
});
