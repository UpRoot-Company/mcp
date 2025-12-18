import { SymbolExtractor } from '../../../ast/extraction/SymbolExtractor.js';
import { AstManager } from '../../../ast/AstManager.js';

describe('SymbolExtractor', () => {
    let extractor: SymbolExtractor;
    let astManager: AstManager;

    beforeAll(async () => {
        astManager = AstManager.getInstance();
        await astManager.init();
        extractor = new SymbolExtractor();
    });

    test('should extract function definitions', async () => {
        const code = `
            function greet(name: string) {
                return "Hello " + name;
            }
        `;
        const symbols = await extractor.generateStructureJson('test.ts', code, astManager);
        
        const func = symbols.find(s => s.name === 'greet' && s.type === 'function');
        expect(func).toBeDefined();
        if (func && func.type === 'function') {
            expect(func.parameters).toEqual(['name']);
        }
    });

    test('should extract class members', async () => {
        const code = `
            class User {
                private name: string;
                constructor(name: string) { this.name = name; }
                getName() { return this.name; }
            }
        `;
        const symbols = await extractor.generateStructureJson('test.ts', code, astManager);
        
        const cls = symbols.find(s => s.name === 'User' && s.type === 'class');
        const ctor = symbols.find(s => s.name === 'constructor');
        const method = symbols.find(s => s.name === 'getName');

        expect(cls).toBeDefined();
        expect(ctor).toBeDefined();
        expect(method).toBeDefined();
    });

    test('should extract imports', async () => {
        const code = `
            import { useState } from 'react';
            import fs from 'fs';
        `;
        const symbols = await extractor.generateStructureJson('test.ts', code, astManager);
        
        const imports = symbols.filter(s => s.type === 'import');
        expect(imports).toHaveLength(2);
        expect(imports.some(i => i.name === 'fs')).toBe(true);
        expect(imports.some(i => i.source === 'react')).toBe(true);
    });
});
