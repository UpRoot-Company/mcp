
import { EditorEngine } from '../engine/Editor.js';
import { MemoryFileSystem } from '../platform/FileSystem.js';
import { EditorEngine as EditorEngineType } from '../engine/Editor.js';

describe('EditorEngine Match Failures', () => {
    let engine: EditorEngine;
    let fs: MemoryFileSystem;

    beforeEach(() => {
        fs = new MemoryFileSystem('/');
        engine = new EditorEngine('/', fs);
    });

    it('should handle different line endings (\\r\\n vs \\n)', async () => {
        const content = 'line1\r\nline2\r\nline3';
        await fs.writeFile('/test.ts', content);

        const edits = [{
            filePath: '/test.ts',
            operation: 'replace' as const,
            targetString: 'line2\nline3',
            replacementString: 'modified'
        }];

        const result = await engine.applyEdits('/test.ts', edits);
        expect(result.success).toBe(true);
    });

    it('should handle \\r line endings', async () => {
        const content = 'line1\rline2\rline3';
        await fs.writeFile('/test.ts', content);

        const edits = [{
            filePath: '/test.ts',
            operation: 'replace' as const,
            targetString: 'line2\rline3',
            replacementString: 'modified'
        }];

        const result = await engine.applyEdits('/test.ts', edits);
        expect(result.success).toBe(true);
    });

    it('should handle backslashes correctly', async () => {
        const content = 'const path = "C:\\\\Users\\\\dev";';
        await fs.writeFile('/test.ts', content);

        const edits = [{
            filePath: '/test.ts',
            operation: 'replace' as const,
            targetString: 'const path = "C:\\\\Users\\\\dev";',
            replacementString: 'const path = "/home/dev";'
        }];

        const result = await engine.applyEdits('/test.ts', edits);
        expect(result.success).toBe(true);
    });

    it('should be flexible with quotes in structural mode', async () => {
        const content = "const s = 'hello';";
        await fs.writeFile('/test.ts', content);

        const edits = [{
            filePath: '/test.ts',
            operation: 'replace' as const,
            targetString: 'const s = "hello";',
            replacementString: 'const s = "world";',
            normalization: 'structural' as any
        }];

        const result = await engine.applyEdits('/test.ts', edits);
        expect(result.success).toBe(true);
    });

    it('should match escaped newline sequences against real line breaks', async () => {
        const content = 'alpha\nbeta\ncharlie';
        await fs.writeFile('/test.ts', content);

        const edits = [{
            filePath: '/test.ts',
            operation: 'replace' as const,
            targetString: 'beta\\ncharlie',
            replacementString: 'BETA'
        }];

        const result = await engine.applyEdits('/test.ts', edits);
        expect(result.success).toBe(true);
        const updated = await fs.readFile('/test.ts');
        expect(updated.includes('BETA')).toBe(true);
    });

    it('should match actual newlines against escaped file content', async () => {
        const content = 'const log = "line\\nnext";';
        await fs.writeFile('/test.ts', content);

        const edits = [{
            filePath: '/test.ts',
            operation: 'replace' as const,
            targetString: 'const log = "line\nnext";',
            replacementString: 'const log = "line\\nupdated";'
        }];

        const result = await engine.applyEdits('/test.ts', edits);
        expect(result.success).toBe(true);
        const updated = await fs.readFile('/test.ts');
        expect(updated.includes('line\\nupdated')).toBe(true);
    });

    it('should normalize replacement strings that contain escaped quotes', async () => {
        const content = 'const before = 1;';
        await fs.writeFile('/test.ts', content);

        const edits = [{
            filePath: '/test.ts',
            operation: 'replace' as const,
            targetString: 'const before = 1;',
            replacementString: 'const after = \\\"value\\\";'
        }];

        const result = await engine.applyEdits('/test.ts', edits);
        expect(result.success).toBe(true);
        const updated = await fs.readFile('/test.ts');
        expect(updated.includes('const after = "value";')).toBe(true);
        expect(updated.includes('\\"')).toBe(false);
    });

    it('should normalize replacement strings that contain escaped single quotes', async () => {
        const content = "const before = 'value';";
        await fs.writeFile('/test.ts', content);

        const edits = [{
            filePath: '/test.ts',
            operation: 'replace' as const,
            targetString: "const before = 'value';",
            replacementString: "const after = \\'value\\';"
        }];

        const result = await engine.applyEdits('/test.ts', edits);
        expect(result.success).toBe(true);
        const updated = await fs.readFile('/test.ts');
        expect(updated.includes("const after = 'value';")).toBe(true);
        expect(updated.includes("\\'")).toBe(false);
    });

    it('should normalize replacement strings that contain escaped backticks', async () => {
        const content = 'const before = `value`;';
        await fs.writeFile('/test.ts', content);

        const edits = [{
            filePath: '/test.ts',
            operation: 'replace' as const,
            targetString: 'const before = `value`;',
            replacementString: 'const after = \\`value\\`;'
        }];

        const result = await engine.applyEdits('/test.ts', edits);
        expect(result.success).toBe(true);
        const updated = await fs.readFile('/test.ts');
        expect(updated.includes('const after = `value`;')).toBe(true);
        expect(updated.includes('\\`')).toBe(false);
    });

    it('should decode structural newline escapes in replacement strings', async () => {
        const content = 'const before = 1;';
        await fs.writeFile('/test.ts', content);

        const edits = [{
            filePath: '/test.ts',
            operation: 'replace' as const,
            targetString: 'const before = 1;',
            replacementString: 'const before = 1;\\nconst after = 2;'
        }];

        const result = await engine.applyEdits('/test.ts', edits);
        expect(result.success).toBe(true);
        const updated = await fs.readFile('/test.ts');
        expect(updated.includes('const before = 1;\nconst after = 2;')).toBe(true);
        expect(updated.includes('\\nconst after')).toBe(false);
    });

    it('should preserve newline escapes that live inside string literals', async () => {
        const content = 'const text = "before";';
        await fs.writeFile('/test.ts', content);

        const edits = [{
            filePath: '/test.ts',
            operation: 'replace' as const,
            targetString: 'const text = "before";',
            replacementString: 'const text = "line\\nnext";'
        }];

        const result = await engine.applyEdits('/test.ts', edits);
        expect(result.success).toBe(true);
        const updated = await fs.readFile('/test.ts');
        expect(updated.includes('const text = "line\\nnext";')).toBe(true);
    });
});
