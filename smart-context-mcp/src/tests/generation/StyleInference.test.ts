import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { StyleInference } from '../../generation/StyleInference.js';
import type { IFileSystem } from '../../platform/FileSystem.js';

describe('StyleInference - Phase 2.5 Quick Code Generation', () => {
    let styleInference: StyleInference;
    let mockFileSystem: jest.Mocked<IFileSystem>;
    const rootPath = '/test/project';

    beforeEach(() => {
        mockFileSystem = {
            exists: jest.fn<any>(),
            readFile: jest.fn<any>(),
            readDir: jest.fn<any>(),
            stat: jest.fn<any>(),
        } as any;

        styleInference = new StyleInference(mockFileSystem, rootPath);
    });

    describe('EditorConfig parsing', () => {
        it('should parse .editorconfig for TypeScript files', async () => {
            mockFileSystem.exists.mockResolvedValue(true);
            mockFileSystem.readFile.mockResolvedValue(
                `[*]\nindent_style = space\nindent_size = 2\nend_of_line = lf\n\n[*.ts]\nindent_size = 4`
            );

            const style = await styleInference.inferStyle('.ts');

            expect(style.indent).toBe('spaces');
            expect(style.indentSize).toBe(4);
            expect(style.lineEndings).toBe('lf');
            expect(style.confidence).toBe(1.0);
        });

        it('should handle tab indentation', async () => {
            mockFileSystem.exists.mockResolvedValue(true);
            mockFileSystem.readFile.mockResolvedValue(
                `[*]\nindent_style = tab\ntab_width = 4`
            );

            const style = await styleInference.inferStyle('.ts');

            expect(style.indent).toBe('tabs');
            expect(style.indentSize).toBe(4);
        });

        it('should return null when .editorconfig does not exist', async () => {
            mockFileSystem.exists.mockResolvedValue(false);
            mockFileSystem.readDir.mockResolvedValue([]);

            const style = await styleInference.inferStyle('.ts');

            // Should return default style with low confidence
            expect(style.indent).toBe('spaces');
            expect(style.confidence).toBe(0.5);
        });
    });

    describe('Majority voting from files', () => {
        it('should detect spaces indentation from file samples', async () => {
            mockFileSystem.exists.mockResolvedValue(false);
            mockFileSystem.readDir.mockResolvedValue(['file1.ts', 'file2.ts']);
            mockFileSystem.stat.mockResolvedValue({ isDirectory: () => false } as any);
            mockFileSystem.readFile
                .mockResolvedValueOnce(`function test() {\n  const x = 1;\n  return x;\n}`)
                .mockResolvedValueOnce(`class Test {\n  method() {\n    return 1;\n  }\n}`);

            const style = await styleInference.inferStyle('.ts');

            expect(style.indent).toBe('spaces');
            expect(style.indentSize).toBe(2);
        });

        it('should detect single quotes preference', async () => {
            mockFileSystem.exists.mockResolvedValue(false);
            mockFileSystem.readDir.mockResolvedValue(['file1.ts']);
            mockFileSystem.stat.mockResolvedValue({ isDirectory: () => false } as any);
            mockFileSystem.readFile.mockResolvedValue(`const msg = 'hello';\nconst name = 'world';\n`);

            const style = await styleInference.inferStyle('.ts');

            expect(style.quotes).toBe('single');
        });

        it('should detect semicolon usage', async () => {
            mockFileSystem.exists.mockResolvedValue(false);
            mockFileSystem.readDir.mockResolvedValue(['file1.ts']);
            mockFileSystem.stat.mockResolvedValue({ isDirectory: () => false } as any);
            mockFileSystem.readFile.mockResolvedValue(`const x = 1;\nconst y = 2;\nreturn x + y;`);

            const style = await styleInference.inferStyle('.ts');

            expect(style.semicolons).toBe(true);
        });

        it('should detect line endings', async () => {
            mockFileSystem.exists.mockResolvedValue(false);
            mockFileSystem.readDir.mockResolvedValue(['file1.ts']);
            mockFileSystem.stat.mockResolvedValue({ isDirectory: () => false } as any);
            mockFileSystem.readFile.mockResolvedValue(`function test() {\r\n  return 1;\r\n}`);

            const style = await styleInference.inferStyle('.ts');

            expect(style.lineEndings).toBe('crlf');
        });

        it('should skip node_modules and other ignored directories', async () => {
            mockFileSystem.exists.mockResolvedValue(false);
            mockFileSystem.readDir
                .mockResolvedValueOnce(['node_modules', 'src'])
                .mockResolvedValueOnce(['file1.ts']);
            mockFileSystem.stat
                .mockResolvedValueOnce({ isDirectory: () => true } as any)
                .mockResolvedValueOnce({ isDirectory: () => true } as any)
                .mockResolvedValueOnce({ isDirectory: () => false } as any);
            mockFileSystem.readFile.mockResolvedValue(`const x = 1;\n`);

            const style = await styleInference.inferStyle('.ts');

            expect(mockFileSystem.readDir).toHaveBeenCalledTimes(2);
        });
    });

    describe('Default style', () => {
        it('should return TypeScript defaults when no files found', async () => {
            mockFileSystem.exists.mockResolvedValue(false);
            mockFileSystem.readDir.mockResolvedValue([]);

            const style = await styleInference.inferStyle('.ts');

            expect(style.indent).toBe('spaces');
            expect(style.indentSize).toBe(2);
            expect(style.quotes).toBe('single');
            expect(style.semicolons).toBe(true);
            expect(style.lineEndings).toBe('lf');
            expect(style.confidence).toBe(0.5);
        });
    });

    describe('Confidence scoring', () => {
        it('should have high confidence for EditorConfig', async () => {
            mockFileSystem.exists.mockResolvedValue(true);
            mockFileSystem.readFile.mockResolvedValue(`[*.ts]\nindent_style = space\nindent_size = 2`);

            const style = await styleInference.inferStyle('.ts');

            expect(style.confidence).toBe(1.0);
        });

        it('should calculate confidence from majority voting', async () => {
            mockFileSystem.exists.mockResolvedValue(false);
            mockFileSystem.readDir.mockResolvedValue(['file1.ts', 'file2.ts', 'file3.ts']);
            mockFileSystem.stat.mockResolvedValue({ isDirectory: () => false } as any);
            mockFileSystem.readFile
                .mockResolvedValueOnce(`  const x = 1;`)
                .mockResolvedValueOnce(`  const y = 2;`)
                .mockResolvedValueOnce(`\tconst z = 3;`);

            const style = await styleInference.inferStyle('.ts');

            expect(style.confidence).toBeGreaterThan(0.5);
            expect(style.indent).toBe('spaces');
        });
    });

    describe('Performance', () => {
        it('should complete inference within 200ms', async () => {
            mockFileSystem.exists.mockResolvedValue(false);
            mockFileSystem.readDir.mockResolvedValue(['file1.ts', 'file2.ts']);
            mockFileSystem.stat.mockResolvedValue({ isDirectory: () => false } as any);
            mockFileSystem.readFile.mockResolvedValue(`function test() {\n  return 1;\n}`);

            const startTime = Date.now();
            await styleInference.inferStyle('.ts');
            const duration = Date.now() - startTime;

            expect(duration).toBeLessThan(200);
        });
    });

    describe('Configuration', () => {
        it('should respect custom max sample files', () => {
            const customInference = new StyleInference(mockFileSystem, rootPath, { maxSampleFiles: 5 });
            const config = customInference.getConfig();
            expect(config.maxSampleFiles).toBe(5);
        });

        it('should use default configuration', () => {
            const config = styleInference.getConfig();
            expect(config.maxSampleFiles).toBe(20);
            expect(config.fileExtensions).toContain('.ts');
            expect(config.minConfidence).toBe(0.6);
        });
    });
});
