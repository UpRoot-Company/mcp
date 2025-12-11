import { jest } from '@jest/globals';
import { SymbolIndex } from '../ast/SymbolIndex.js';
import { SkeletonGenerator } from '../ast/SkeletonGenerator.js';
import { AstManager } from '../ast/AstManager.js';
import * as fs from 'fs';
import * as path from 'path';

describe('SymbolIndex', () => {
    const testDir = path.join(process.cwd(), 'src', 'tests', 'symbol_index_test_env');
    let index: SymbolIndex;

    beforeAll(async () => {
        // Ensure AstManager is ready
        await AstManager.getInstance().init();
        
        // Setup test directory
        if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
        fs.mkdirSync(testDir, { recursive: true });
        
        // Create test files
        fs.writeFileSync(path.join(testDir, 'test.ts'), 'class TestClass { method() {} }');
        fs.writeFileSync(path.join(testDir, 'utils.py'), 'def python_helper(): pass');
        fs.writeFileSync(path.join(testDir, 'notes.txt'), 'plain text content');
        
        fs.mkdirSync(path.join(testDir, 'nested'));
        fs.writeFileSync(path.join(testDir, 'nested', 'deep.ts'), 'function deepFunc() {}');
        
        // Create ignored file (node_modules is ignored by default in SymbolIndex)
        fs.mkdirSync(path.join(testDir, 'node_modules'), { recursive: true });
        fs.writeFileSync(path.join(testDir, 'node_modules', 'ignored.ts'), 'class IgnoredClass {}');
    });

    afterAll(() => {
        if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    });

    beforeEach(() => {
        const generator = new SkeletonGenerator();
        // Pointing to testDir as root
        index = new SymbolIndex(testDir, generator, []);
    });

    it('should find symbols in root files', async () => {
        const results = await index.search('TestClass');
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].symbol.name).toBe('TestClass');
        expect(results[0].filePath).toBe('test.ts');
    });

    it('should find symbols in nested files', async () => {
        const results = await index.search('deepFunc');
        expect(results.length).toBeGreaterThan(0);
        const found = results.find((r: any) => r.symbol.name === 'deepFunc');
        expect(found).toBeDefined();
        // path.relative might return 'nested/deep.ts' or 'nested\\deep.ts'
        expect(found!.filePath.replace(/\\/g, '/')).toBe('nested/deep.ts');
    });

    it('should ignore files in node_modules', async () => {
        const results = await index.search('IgnoredClass');
        expect(results).toHaveLength(0);
    });

    it('should support partial matching (case insensitive)', async () => {
        const results = await index.search('helper');
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].symbol.name).toBe('python_helper');
    });

    it('should skip unsupported extensions without emitting warnings', async () => {
        const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const unsupportedPath = path.join(testDir, 'notes.txt');
            const symbols = await index.getSymbolsForFile(unsupportedPath);
            expect(symbols).toHaveLength(0);
            expect(warnSpy).not.toHaveBeenCalled();
        } finally {
            warnSpy.mockRestore();
        }
    });
});
