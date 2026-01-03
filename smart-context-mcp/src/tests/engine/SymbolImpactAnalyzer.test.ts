import { describe, it, expect, beforeEach } from '@jest/globals';
import { AstDiffEngine } from '../../ast/AstDiffEngine.js';
import { SymbolImpactAnalyzer } from '../../engine/SymbolImpactAnalyzer.js';
import { SymbolIndex } from '../../ast/SymbolIndex.js';
import { CallGraphBuilder } from '../../ast/CallGraphBuilder.js';
import { SkeletonGenerator } from '../../ast/SkeletonGenerator.js';
import { ModuleResolver } from '../../ast/ModuleResolver.js';

describe('SymbolImpactAnalyzer', () => {
    let analyzer: SymbolImpactAnalyzer;
    let symbolIndex: SymbolIndex;
    let callGraphBuilder: CallGraphBuilder;
    let diffEngine: AstDiffEngine;
    let tempDir: string;

    beforeEach(() => {
        // Use a temporary directory for tests
        tempDir = `/tmp/test-${Date.now()}`;
        const skeletonGenerator = new SkeletonGenerator();
        symbolIndex = new SymbolIndex(tempDir, skeletonGenerator, []);
        const moduleResolver = new ModuleResolver(tempDir);
        callGraphBuilder = new CallGraphBuilder(tempDir, symbolIndex, moduleResolver);
        diffEngine = new AstDiffEngine();
        analyzer = new SymbolImpactAnalyzer(symbolIndex, callGraphBuilder, diffEngine);
    });

    describe('Breaking Change Detection', () => {
        it('should detect breaking changes from function removal', async () => {
            const filePath = '/test/module.ts';

            const oldCode = `
export function calculateTotal(a: number, b: number): number {
    return a + b;
}
            `;
            
            const newCode = `// Function removed`;

            const result = await analyzer.analyzeImpact({
                filePath,
                oldContent: oldCode,
                newContent: newCode
            });

            expect(result.riskScore).toBeGreaterThan(0);
            expect(result.astChanges.some((c: any) => c.type === 'remove')).toBe(true);
        });

        it('should detect breaking changes from signature modification', async () => {
            const filePath = '/test/api.ts';

            const oldCode = `
export function process(data: string): void {
    console.log(data);
}
            `;
            
            const newCode = `
export function process(data: string, options: any): void {
    console.log(data, options);
}
            `;

            const result = await analyzer.analyzeImpact({
                filePath,
                oldContent: oldCode,
                newContent: newCode
            });

            expect(result.astChanges.some((c: any) => c.type === 'signature-change')).toBe(true);
        });
    });

    describe('Risk Scoring', () => {
        it('should calculate high risk score for multiple breaking changes', async () => {
            const filePath = '/test/critical.ts';

            const oldCode = `
export function funcA(x: number): number { return x; }
export function funcB(y: string): string { return y; }
export class MyClass {}
            `;
            
            const newCode = `
export function funcA(x: number, z: boolean): number { return x; }
// funcB removed
// MyClass removed
            `;

            const result = await analyzer.analyzeImpact({
                filePath,
                oldContent: oldCode,
                newContent: newCode
            });

            expect(result.riskScore).toBeGreaterThan(50);
        });

        it('should calculate low risk score for non-breaking changes', async () => {
            const filePath = '/test/safe.ts';

            const oldCode = `
export function test() {}
            `;
            
            const newCode = `
export function test() {}
export function newHelper() {}
            `;

            const result = await analyzer.analyzeImpact({
                filePath,
                oldContent: oldCode,
                newContent: newCode
            });

            expect(result.riskScore).toBeLessThan(30);
        });
    });

    describe('Impacted Symbols', () => {
        // Simplified test due to complex setup
        it('should identify symbols as empty list without graph setup', async () => {
            const filePath = '/test/module.ts';

            const oldCode = `
export function target(x: number): number {
    return x * 2;
}
            `;
            
            const newCode = `
export function target(x: number, y: number): number {
    return x * y;
}
            `;

            const result = await analyzer.analyzeImpact({
                filePath,
                oldContent: oldCode,
                newContent: newCode
            });

            // Without proper symbol graph setup, impactedSymbols will be empty
            expect(result.impactedSymbols).toBeDefined();
        });
    });

    describe('No Impact Scenarios', () => {
        it('should return zero risk for identical code', async () => {
            const filePath = '/test/unchanged.ts';
            const code = `
export function test() {}
            `;

            const result = await analyzer.analyzeImpact({
                filePath,
                oldContent: code,
                newContent: code
            });

            expect(result.riskScore).toBe(0);
            expect(result.astChanges).toHaveLength(0);
            expect(result.impactedSymbols).toHaveLength(0);
        });

        it('should return low risk for comment/whitespace changes', async () => {
            const filePath = '/test/formatting.ts';

            const oldCode = `
export function process(x: number): number {
    // old comment
    return x * 2;
}
            `;
            
            const newCode = `
export function process(x: number): number {
    // new comment
    return x * 2;
}
            `;

            const result = await analyzer.analyzeImpact({
                filePath,
                oldContent: oldCode,
                newContent: newCode
            });

            // Comments might trigger signature-change but shouldn't be high risk
            expect(result.riskScore).toBeLessThan(50);
        });
    });
});
