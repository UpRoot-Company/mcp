
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
});
