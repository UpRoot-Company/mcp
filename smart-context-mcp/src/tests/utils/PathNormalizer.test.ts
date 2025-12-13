import { describe, it, expect, beforeAll } from '@jest/globals';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { PathNormalizer } from '../../utils/PathNormalizer.js';

describe('PathNormalizer', () => {
    let testDir: string;
    let normalizer: PathNormalizer;

    beforeAll(() => {
        // 테스트용 임시 디렉토리 생성
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-normalizer-'));
        normalizer = new PathNormalizer(testDir);

        // 테스트 파일 구조 생성
        const srcDir = path.join(testDir, 'src');
        const nestedDir = path.join(srcDir, 'deeply', 'nested');
        fs.mkdirSync(nestedDir, { recursive: true });

        fs.writeFileSync(path.join(testDir, 'file.ts'), 'content');
        fs.writeFileSync(path.join(srcDir, 'index.ts'), 'content');
        fs.writeFileSync(path.join(nestedDir, 'deep.ts'), 'content');
    });

    afterAll(() => {
        // 테스트 디렉토리 정리
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    describe('normalize', () => {
        it('should normalize relative paths (no change)', () => {
            expect(normalizer.normalize('file.ts')).toBe('file.ts');
            expect(normalizer.normalize('src/index.ts')).toBe('src/index.ts');
            expect(normalizer.normalize('src/deeply/nested/deep.ts')).toBe('src/deeply/nested/deep.ts');
        });

        it('should convert absolute paths to relative paths', () => {
            const absPath = path.join(testDir, 'file.ts');
            expect(normalizer.normalize(absPath)).toBe('file.ts');

            const absSrcPath = path.join(testDir, 'src', 'index.ts');
            expect(normalizer.normalize(absSrcPath)).toBe('src/index.ts');

            const absNestedPath = path.join(testDir, 'src', 'deeply', 'nested', 'deep.ts');
            expect(normalizer.normalize(absNestedPath)).toBe('src/deeply/nested/deep.ts');
        });

        it('should normalize paths with .. sequences', () => {
            // 상대경로에서 .. 제거
            const absPath = path.join(testDir, 'src', '..', 'file.ts');
            expect(normalizer.normalize(absPath)).toBe('file.ts');
        });

        it('should handle current directory path', () => {
            const currentDirPath = '.';
            expect(normalizer.normalize(currentDirPath)).toBe('.');
        });

        it('should use forward slashes consistently (cross-platform)', () => {
            const absPath = path.join(testDir, 'src', 'index.ts');
            const normalized = normalizer.normalize(absPath);
            // Should always use forward slashes, never backslashes
            expect(normalized).not.toContain('\\');
            expect(normalized).toContain('/');
        });

        it('should throw error for paths outside root directory', () => {
            const outsidePath = '/etc/passwd'; // Unix
            expect(() => normalizer.normalize(outsidePath)).toThrow('SecurityViolation');
        });

        it('should throw error for relative paths that escape root', () => {
            const escapePath = '../../outside';
            expect(() => normalizer.normalize(escapePath)).toThrow('SecurityViolation');
        });

        it('should throw error for invalid input', () => {
            expect(() => normalizer.normalize('')).toThrow();
            expect(() => normalizer.normalize(null as any)).toThrow();
            expect(() => normalizer.normalize(undefined as any)).toThrow();
        });
    });

    describe('normalizeBatch', () => {
        it('should normalize multiple paths at once', () => {
            const paths = [
                'file.ts',
                path.join(testDir, 'src', 'index.ts'),
                'src/deeply/nested/deep.ts'
            ];

            const normalized = normalizer.normalizeBatch(paths);

            expect(normalized).toHaveLength(3);
            expect(normalized[0]).toBe('file.ts');
            expect(normalized[1]).toBe('src/index.ts');
            expect(normalized[2]).toBe('src/deeply/nested/deep.ts');
        });

        it('should handle mixed absolute and relative paths', () => {
            const paths = [
                path.join(testDir, 'file.ts'),
                'src/index.ts',
                path.join(testDir, 'src', 'deeply', 'nested', 'deep.ts')
            ];

            const normalized = normalizer.normalizeBatch(paths);

            expect(normalized[0]).toBe('file.ts');
            expect(normalized[1]).toBe('src/index.ts');
            expect(normalized[2]).toBe('src/deeply/nested/deep.ts');
        });
    });

    describe('toAbsolute', () => {
        it('should convert relative path to absolute path', () => {
            const abs1 = normalizer.toAbsolute('file.ts');
            expect(abs1).toBe(path.join(testDir, 'file.ts'));

            const abs2 = normalizer.toAbsolute('src/index.ts');
            expect(abs2).toBe(path.join(testDir, 'src', 'index.ts'));
        });
    });

    describe('isWithinRoot', () => {
        it('should return true for paths within root', () => {
            expect(normalizer.isWithinRoot('file.ts')).toBe(true);
            expect(normalizer.isWithinRoot('src/index.ts')).toBe(true);
            expect(normalizer.isWithinRoot(path.join(testDir, 'file.ts'))).toBe(true);
            expect(normalizer.isWithinRoot('.')).toBe(true);
        });

        it('should return false for paths outside root', () => {
            expect(normalizer.isWithinRoot('/etc/passwd')).toBe(false);
            expect(normalizer.isWithinRoot('../../outside')).toBe(false);
        });

        it('should return false for invalid paths', () => {
            expect(normalizer.isWithinRoot('')).toBe(false);
            expect(normalizer.isWithinRoot(null as any)).toBe(false);
        });
    });

    describe('setRootDir and getRootDir', () => {
        it('should allow changing root directory', () => {
            const oldRoot = normalizer.getRootDir();
            const newRoot = path.join(testDir, 'src');

            normalizer.setRootDir(newRoot);
            expect(normalizer.getRootDir()).toBe(newRoot);

            // 경로 정규화가 새 루트 기준으로 작동하는지 확인
            const abs = path.join(newRoot, 'index.ts');
            expect(normalizer.normalize(abs)).toBe('index.ts');

            // 복원
            normalizer.setRootDir(oldRoot);
        });
    });

    describe('IDE Integration Scenarios', () => {
        it('should handle VSCode absolute path from open file', () => {
            // VSCode 플러그인이 전송하는 형식
            const vscodePath = path.join(testDir, 'src', 'index.ts');
            const normalized = normalizer.normalize(vscodePath);
            expect(normalized).toBe('src/index.ts');
        });

        it('should handle CLI relative path', () => {
            // CLI 도구가 전송하는 형식
            const cliPath = 'src/index.ts';
            const normalized = normalizer.normalize(cliPath);
            expect(normalized).toBe('src/index.ts');
        });

        it('should prevent directory traversal attacks', () => {
            // 악의적인 경로 차단
            const malicious = [
                '../../../etc/passwd',
                '/etc/passwd',
                path.join(testDir, '..', '..', 'etc', 'passwd')
            ];

            for (const path_ of malicious) {
                expect(() => normalizer.normalize(path_)).toThrow('SecurityViolation');
            }
        });

        it('should handle mixed path separators on Windows', () => {
            // Windows와 Unix 경로 혼합
            const mixedPath = normalizer.normalize('src\\deeply\\nested\\deep.ts'.replace(/\\\\/g, path.sep));
            expect(mixedPath).toContain('src');
            expect(mixedPath).toContain('nested');
        });
    });

    describe('Normalization consistency', () => {
        it('should produce same result for equivalent paths', () => {
            const abs1 = path.join(testDir, 'src', 'index.ts');
            const abs2 = path.join(testDir, 'src', '.', 'index.ts');
            const rel = 'src/index.ts';

            const norm1 = normalizer.normalize(abs1);
            const norm2 = normalizer.normalize(abs2);
            const norm3 = normalizer.normalize(rel);

            expect(norm1).toBe(norm2);
            expect(norm2).toBe(norm3);
            expect(norm1).toBe('src/index.ts');
        });
    });
});
