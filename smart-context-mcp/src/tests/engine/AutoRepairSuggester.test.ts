import { describe, it, expect } from '@jest/globals';
import { AutoRepairSuggester } from '../../engine/AutoRepairSuggester.js';
import type { AstChange } from '../../ast/AstDiffEngine.js';
import type { ImpactedSymbol, SymbolImpactResult } from '../../engine/SymbolImpactAnalyzer.js';

describe('AutoRepairSuggester', () => {
    const suggester = new AutoRepairSuggester();

    describe('Parameter Addition Repairs', () => {
        it('should suggest default value for added required parameter', async () => {
            const change: AstChange = {
                type: 'parameter-add',
                symbolName: 'calculate',
                symbolType: 'function',
                isBreaking: true,
                details: {
                    oldCount: 2,
                    newCount: 3
                }
            };

            const impactedSymbol: ImpactedSymbol = {
                symbolName: 'caller',
                symbolType: 'function',
                filePath: '/test/caller.ts',
                lineNumber: 10,
                impactReason: 'calls changed function',
                isBreaking: true
            };

            const result = await suggester.suggestRepairs([change], [impactedSymbol]);

            expect(result.suggestedEdits.length).toBeGreaterThan(0);
            expect(result.totalSuggestions).toBe(result.suggestedEdits.length);
        });
    });

    describe('No Repairs Needed', () => {
        it('should return empty repairs for no impacted symbols', async () => {
            const change: AstChange = {
                type: 'add',
                symbolName: 'newFunction',
                symbolType: 'function',
                isBreaking: false
            };

            const result = await suggester.suggestRepairs([change], []);

            expect(result.suggestedEdits).toHaveLength(0);
            expect(result.totalSuggestions).toBe(0);
        });
    });
});
