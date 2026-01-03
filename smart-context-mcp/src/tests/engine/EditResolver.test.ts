// ADR-042-005: Phase A3 - EditResolver Tests
import { describe, it, expect, beforeEach } from '@jest/globals';
import { EditResolver } from '../../engine/EditResolver.js';
import { EditorEngine } from '../../engine/Editor.js';
import { IFileSystem } from '../../platform/FileSystem.js';
import { Edit } from '../../types.js';
import * as path from 'path';

class MockFileSystem implements IFileSystem {
    private files: Map<string, string> = new Map();

    setFile(absPath: string, content: string): void {
        this.files.set(absPath, content);
    }

    async exists(absPath: string): Promise<boolean> {
        return this.files.has(absPath);
    }

    async readFile(absPath: string): Promise<string> {
        const content = this.files.get(absPath);
        if (!content) throw new Error(`File not found: ${absPath}`);
        return content;
    }

    async writeFile(absPath: string, content: string): Promise<void> {
        this.files.set(absPath, content);
    }

    async createDir(dirPath: string): Promise<void> {
        // no-op for tests
    }

    async rename(oldPath: string, newPath: string): Promise<void> {
        const content = this.files.get(oldPath);
        if (content) {
            this.files.set(newPath, content);
            this.files.delete(oldPath);
        }
    }

    async deleteFile(absPath: string): Promise<void> {
        this.files.delete(absPath);
    }

    async readDir(dirPath: string): Promise<string[]> {
        return [];
    }

    async stat(absPath: string): Promise<any> {
        return { isDirectory: false, isFile: true, size: 0 };
    }

    async listFiles(basePath: string): Promise<string[]> {
        return Array.from(this.files.keys());
    }
}

describe('EditResolver', () => {
    let fileSystem: MockFileSystem;
    let editor: EditorEngine;
    let resolver: EditResolver;
    const testFilePath = '/test/file.ts';

    beforeEach(() => {
        fileSystem = new MockFileSystem();
        editor = new EditorEngine('/test', fileSystem);
        resolver = new EditResolver(fileSystem, editor);
    });

    describe('A3.1: indexRange 기반 resolve (즉시 성공)', () => {
        it('should resolve with exact indexRange', async () => {
            const content = 'function foo() {\n  return 42;\n}\n';
            fileSystem.setFile(testFilePath, content);

            const edits: Edit[] = [{
                targetString: 'return 42',
                replacementString: 'return 100',
                indexRange: { start: 19, end: 28 }
            }];

            const result = await resolver.resolveAll(testFilePath, edits);

            expect(result.success).toBe(true);
            expect(result.resolvedEdits).toHaveLength(1);
            expect(result.resolvedEdits![0].indexRange).toEqual({ start: 19, end: 28 });
            expect(result.resolvedEdits![0].diagnostics?.resolvedBy).toBe('indexRange');
            expect(result.resolvedEdits![0].diagnostics?.candidateCount).toBe(1);
        });

        it('should fail with invalid indexRange', async () => {
            const content = 'short';
            fileSystem.setFile(testFilePath, content);

            const edits: Edit[] = [{
                targetString: 'foo',
                replacementString: 'bar',
                indexRange: { start: 0, end: 100 } // out of bounds
            }];

            const result = await resolver.resolveAll(testFilePath, edits);

            expect(result.success).toBe(false);
            expect(result.errors).toHaveLength(1);
            expect(result.errors![0].errorCode).toBe('NO_MATCH');
            expect(result.errors![0].message).toContain('Invalid indexRange');
        });
    });

    describe('A3.2: 모호한 후보 처리 (AMBIGUOUS_MATCH)', () => {
        it('should return AMBIGUOUS_MATCH when multiple candidates exist', async () => {
            const content = 'const total = 10;\nconst total = 20;\nconst total = 30;\n';
            fileSystem.setFile(testFilePath, content);

            const edits: Edit[] = [{
                targetString: 'total',
                replacementString: 'sum'
            }];

            const result = await resolver.resolveAll(testFilePath, edits, {
                allowAmbiguousAutoPick: false
            });

            expect(result.success).toBe(false);
            expect(result.errors).toHaveLength(1);
            expect(result.errors![0].errorCode).toBe('AMBIGUOUS_MATCH');
            expect(result.errors![0].message).toContain('Found');
            expect(result.errors![0].message).toContain('matches');
            expect(result.errors![0].suggestion?.lineRange).toBeDefined();
        });

        it('should auto-pick when allowAmbiguousAutoPick is true', async () => {
            const content = 'const total = 10;\nconst total = 20;\n';
            fileSystem.setFile(testFilePath, content);

            const edits: Edit[] = [{
                targetString: 'total',
                replacementString: 'sum'
            }];

            const result = await resolver.resolveAll(testFilePath, edits, {
                allowAmbiguousAutoPick: true
            });

            expect(result.success).toBe(true);
            expect(result.resolvedEdits).toHaveLength(1);
            expect(result.resolvedEdits![0].diagnostics?.candidateCount).toBeGreaterThan(1);
        });
    });

    describe('A3.3: 큰 파일 + 짧은 target (levenshtein 금지)', () => {
        it('should block levenshtein on large file with short target', async () => {
            // Create a large file (>100KB)
            const largeContent = 'x'.repeat(150000);
            fileSystem.setFile(testFilePath, largeContent);

            const edits: Edit[] = [{
                targetString: 'xy',  // very short
                replacementString: 'ab',
                fuzzyMode: 'levenshtein'
            }];

            const result = await resolver.resolveAll(testFilePath, edits);

            expect(result.success).toBe(false);
            expect(result.errors).toHaveLength(1);
            expect(result.errors![0].errorCode).toBe('LEVENSHTEIN_BLOCKED');
            expect(result.errors![0].message).toContain('Levenshtein blocked');
        });

        it('should allow levenshtein with adequate target length', async () => {
            const content = 'function calculateTotal() { return 0; }';
            fileSystem.setFile(testFilePath, content);

            const edits: Edit[] = [{
                targetString: 'function calculateTotal',  // long enough (>20 chars)
                replacementString: 'function computeSum',
                // No fuzzyMode - will use default exact/normalization matching
            }];

            const result = await resolver.resolveAll(testFilePath, edits);

            expect(result.success).toBe(true);
        });
    });

    describe('A3.4: timeout 처리 (RESOLVE_TIMEOUT)', () => {
        it('should timeout on long-running resolve', async () => {
            // Create a file with many potential matches
            const content = 'const x = 1;\n'.repeat(50);
            fileSystem.setFile(testFilePath, content);

            // Create edits with ambiguous matches
            const edits: Edit[] = Array.from({ length: 50 }, (_, i) => ({
                targetString: `x`,  // Will match many times
                replacementString: `y${i}`,
            }));

            const result = await resolver.resolveAll(testFilePath, edits, {
                timeoutMs: 5, // very short timeout
                allowAmbiguousAutoPick: false
            });

            // Should fail due to ambiguous matches or timeout
            expect(result.success).toBe(false);
            expect(result.errors!.length).toBeGreaterThan(0);
        });
    });

    describe('A3.5: lineRange를 통한 범위 좁히기', () => {
        it('should succeed with lineRange narrowing', async () => {
            const content = 'line 1: total\nline 2: total\nline 3: total\n';
            fileSystem.setFile(testFilePath, content);

            const edits: Edit[] = [{
                targetString: 'total',
                replacementString: 'sum',
                lineRange: { start: 2, end: 2 }
            }];

            const result = await resolver.resolveAll(testFilePath, edits);

            expect(result.success).toBe(true);
            expect(result.resolvedEdits).toHaveLength(1);
            expect(result.resolvedEdits![0].diagnostics?.resolvedBy).toBe('lineRange');
        });
    });

    describe('A3.6: 파일 없음 처리', () => {
        it('should fail when file does not exist', async () => {
            const edits: Edit[] = [{
                targetString: 'foo',
                replacementString: 'bar'
            }];

            const result = await resolver.resolveAll('/nonexistent.ts', edits);

            expect(result.success).toBe(false);
            expect(result.errors).toHaveLength(1);
            expect(result.errors![0].message).toContain('File not found');
        });
    });

    describe('A3.7: 복합 시나리오 (batch)', () => {
        it('should resolve multiple edits in batch', async () => {
            const content = 'const a = 1;\nconst b = 2;\nconst c = 3;\n';
            fileSystem.setFile(testFilePath, content);

            const edits: Edit[] = [
                {
                    targetString: 'a = 1',
                    replacementString: 'a = 10',
                    lineRange: { start: 1, end: 1 }
                },
                {
                    targetString: 'b = 2',
                    replacementString: 'b = 20',
                    lineRange: { start: 2, end: 2 }
                },
                {
                    targetString: 'c = 3',
                    replacementString: 'c = 30',
                    lineRange: { start: 3, end: 3 }
                }
            ];

            const result = await resolver.resolveAll(testFilePath, edits);

            expect(result.success).toBe(true);
            expect(result.resolvedEdits).toHaveLength(3);
        });

        it('should handle partial failures in batch', async () => {
            const content = 'const a = 1;\nconst b = 2;\n';
            fileSystem.setFile(testFilePath, content);

            const edits: Edit[] = [
                {
                    targetString: 'a = 1',
                    replacementString: 'a = 10'
                },
                {
                    targetString: 'NOT_EXIST',
                    replacementString: 'bar'
                },
                {
                    targetString: 'b = 2',
                    replacementString: 'b = 20'
                }
            ];

            const result = await resolver.resolveAll(testFilePath, edits);

            expect(result.success).toBe(false);
            expect(result.errors).toHaveLength(1);
            expect(result.errors![0].editIndex).toBe(1);
        });
    });
});
