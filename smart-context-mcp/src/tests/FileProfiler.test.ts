
import { FileProfiler } from '../engine/FileProfiler.js';

describe('FileProfiler', () => {
    describe('analyzeMetadata', () => {
        it('should detect LF newline style', () => {
            const content = 'line1\nline2\nline3';
            const metadata = FileProfiler.analyzeMetadata(content, 'test.ts');
            expect(metadata.newlineStyle).toBe('lf');
        });

        it('should detect CRLF newline style', () => {
            const content = 'line1\r\nline2\r\nline3';
            const metadata = FileProfiler.analyzeMetadata(content, 'test.ts');
            expect(metadata.newlineStyle).toBe('crlf');
        });

        it('should detect mixed newline style', () => {
            const content = 'line1\nline2\r\nline3';
            const metadata = FileProfiler.analyzeMetadata(content, 'test.ts');
            expect(metadata.newlineStyle).toBe('mixed');
        });

        it('should detect 4 spaces indentation', () => {
            const content = 'function test() {\n    return true;\n}';
            const metadata = FileProfiler.analyzeMetadata(content, 'test.ts');
            expect(metadata.usesTabs).toBe(false);
            expect(metadata.indentSize).toBe(4);
        });

        it('should detect 2 spaces indentation', () => {
            const content = 'function test() {\n  return true;\n}';
            const metadata = FileProfiler.analyzeMetadata(content, 'test.ts');
            expect(metadata.usesTabs).toBe(false);
            expect(metadata.indentSize).toBe(2);
        });

        it('should detect tabs indentation', () => {
            const content = 'function test() {\n\treturn true;\n}';
            const metadata = FileProfiler.analyzeMetadata(content, 'test.ts');
            expect(metadata.usesTabs).toBe(true);
        });

        it('should identify tsconfig.json', () => {
            const metadata = FileProfiler.analyzeMetadata('{}', '/path/to/tsconfig.json');
            expect(metadata.isConfigFile).toBe(true);
            expect(metadata.configType).toBe('tsconfig');
            expect(metadata.configScope).toBe('project');
        });

        it('should identify package.json', () => {
            const metadata = FileProfiler.analyzeMetadata('{}', '/path/to/package.json');
            expect(metadata.isConfigFile).toBe(true);
            expect(metadata.configType).toBe('package.json');
        });

        it('should identify .editorconfig', () => {
            const metadata = FileProfiler.analyzeMetadata('root = true', '/path/to/.editorconfig');
            expect(metadata.isConfigFile).toBe(true);
            expect(metadata.configType).toBe('editorconfig');
        });

        it('should identify general json config', () => {
            const metadata = FileProfiler.analyzeMetadata('{}', 'settings.json');
            expect(metadata.isConfigFile).toBe(true);
            expect(metadata.configType).toBe('other');
            expect(metadata.configScope).toBe('directory');
        });
    });
});
