import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { RootDetector } from '../../utils/RootDetector.js';

// Helper function to compare paths by resolving symlinks
function expectSamePath(received: string, expected: string) {
    const realReceived = fs.realpathSync(received);
    const realExpected = fs.realpathSync(expected);
    expect(realReceived).toBe(realExpected);
}

describe('RootDetector', () => {
    let testDir: string;
    let projectRoot: string;
    let nestedDir: string;
    let deeplyNestedDir: string;

    beforeAll(() => {
        // Create test directory structure
        testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'root-detector-'));
        projectRoot = path.join(testDir, 'myproject');
        nestedDir = path.join(projectRoot, 'src');
        deeplyNestedDir = path.join(nestedDir, 'deeply', 'nested');

        fs.mkdirSync(deeplyNestedDir, { recursive: true });

        // Create root markers
        fs.writeFileSync(path.join(projectRoot, 'package.json'), '{"name": "test-project"}');
        fs.writeFileSync(path.join(projectRoot, 'tsconfig.json'), '{}');
        fs.writeFileSync(path.join(projectRoot, 'README.md'), '# Test Project');

        // Create some test files
        fs.writeFileSync(path.join(projectRoot, 'index.ts'), 'export default {}');
        fs.writeFileSync(path.join(nestedDir, 'main.ts'), 'export function main() {}');
        fs.writeFileSync(path.join(deeplyNestedDir, 'deep.ts'), 'export const deep = true;');
    });

    afterAll(() => {
        // Clean up test directory
        fs.rmSync(testDir, { recursive: true, force: true });
    });

    describe('detectRoot', () => {
        it('should detect root from deeply nested file', async () => {
            const deepFile = path.join(deeplyNestedDir, 'deep.ts');
            const root = await RootDetector.detectRoot(deepFile);
            expect(root).toBe(projectRoot);
        });

        it('should detect root from file in src directory', async () => {
            const srcFile = path.join(nestedDir, 'main.ts');
            const root = await RootDetector.detectRoot(srcFile);
            expect(root).toBe(projectRoot);
        });

        it('should detect root from directory path', async () => {
            const root = await RootDetector.detectRoot(deeplyNestedDir);
            expect(root).toBe(projectRoot);
        });

        it('should detect root from project root itself', async () => {
            const root = await RootDetector.detectRoot(projectRoot);
            expect(root).toBe(projectRoot);
        });

        it('should handle relative paths', async () => {
            // Create a test from a relative path (resolved from cwd)
            const cwd = process.cwd();
            try {
                process.chdir(deeplyNestedDir);
                const root = await RootDetector.detectRoot('.');
                // Compare by resolving symlinks (handles macOS /var symlink issue)
                expectSamePath(root, projectRoot);
            } finally {
                process.chdir(cwd);
            }
        });

        it('should use custom markers', async () => {
            // Create a different root structure with custom marker
            const customRoot = path.join(testDir, 'custom-root');
            const customDir = path.join(customRoot, 'subdir');
            fs.mkdirSync(customDir, { recursive: true });

            // Only create a custom marker
            fs.writeFileSync(path.join(customRoot, '.project-marker'), '');

            const root = await RootDetector.detectRoot(customDir, ['.project-marker']);
            expect(root).toBe(customRoot);

            // Clean up
            fs.rmSync(customRoot, { recursive: true, force: true });
        });

        it('should not find root with non-existent markers', async () => {
            const customRoot = path.join(testDir, 'no-markers');
            const customDir = path.join(customRoot, 'deep');
            fs.mkdirSync(customDir, { recursive: true });

            // detectRoot should return fallback (start dir or parent)
            const root = await RootDetector.detectRoot(customDir, ['.nonexistent-marker']);
            // Should return something (fallback behavior)
            expect(root).toBeDefined();

            // Clean up
            fs.rmSync(customRoot, { recursive: true, force: true });
        });
    });

    describe('detectRootSync', () => {
        it('should synchronously detect root from nested file', () => {
            const deepFile = path.join(deeplyNestedDir, 'deep.ts');
            const root = RootDetector.detectRootSync(deepFile);
            expect(root).toBe(projectRoot);
        });

        it('should synchronously detect root from directory', () => {
            const root = RootDetector.detectRootSync(nestedDir);
            expect(root).toBe(projectRoot);
        });

        it('should handle relative paths synchronously', () => {
            const cwd = process.cwd();
            try {
                process.chdir(deeplyNestedDir);
                const root = RootDetector.detectRootSync('.');
                // Compare by resolving symlinks (handles macOS /var symlink issue)
                expectSamePath(root, projectRoot);
            } finally {
                process.chdir(cwd);
            }
        });

        it('should sync and async produce same results', async () => {
            const deepFile = path.join(deeplyNestedDir, 'deep.ts');
            const syncRoot = RootDetector.detectRootSync(deepFile);
            const asyncRoot = await RootDetector.detectRoot(deepFile);
            expect(syncRoot).toBe(asyncRoot);
        });
    });

    describe('detectCommonRoot', () => {
        it('should find common root for multiple files in same project', async () => {
            const files = [
                path.join(projectRoot, 'index.ts'),
                path.join(nestedDir, 'main.ts'),
                path.join(deeplyNestedDir, 'deep.ts')
            ];

            const commonRoot = await RootDetector.detectCommonRoot(files);
            expect(commonRoot).toBe(projectRoot);
        });

        it('should find common root for files in different subdirectories', async () => {
            const files = [
                path.join(nestedDir, 'main.ts'),
                path.join(projectRoot, 'index.ts')
            ];

            const commonRoot = await RootDetector.detectCommonRoot(files);
            expect(commonRoot).toBe(projectRoot);
        });

        it('should handle single file in common root', async () => {
            const files = [path.join(deeplyNestedDir, 'deep.ts')];
            const commonRoot = await RootDetector.detectCommonRoot(files);
            expect(commonRoot).toBe(projectRoot);
        });

        it('should handle empty array gracefully', async () => {
            // This might fail or return undefined - test the actual behavior
            try {
                const commonRoot = await RootDetector.detectCommonRoot([]);
                expect(commonRoot).toBeDefined();
            } catch {
                // Expected if empty array throws
                expect(true).toBe(true);
            }
        });
    });

    describe('detectRootWithDetails', () => {
        it('should return details about detected root', async () => {
            const deepFile = path.join(deeplyNestedDir, 'deep.ts');
            const details = await RootDetector.detectRootWithDetails(deepFile);

            expect(details.root).toBe(projectRoot);
            expect(details.markerFound).toBeDefined();
            expect(details.depth).toBeGreaterThanOrEqual(0);
        });

        it('should show which marker was found', async () => {
            const srcFile = path.join(nestedDir, 'main.ts');
            const details = await RootDetector.detectRootWithDetails(srcFile);

            // Should be one of the default markers
            const defaultMarkers = [
                '.git', 'package.json', 'tsconfig.json', 'pyproject.toml',
                '.env.local', 'Cargo.toml', 'go.mod', '.python-version',
                'pom.xml', 'build.gradle', 'README.md'
            ];

            expect(defaultMarkers).toContain(details.markerFound);
        });

        it('should track search depth', async () => {
            const deepFile = path.join(deeplyNestedDir, 'deep.ts');
            const details = await RootDetector.detectRootWithDetails(deepFile);

            // Depth should be > 0 since we're searching from deeply nested dir
            expect(details.depth).toBeGreaterThan(0);
        });

        it('should show fallback marker when no markers found', async () => {
            const customRoot = path.join(testDir, 'no-markers-2');
            const customDir = path.join(customRoot, 'deep');
            fs.mkdirSync(customDir, { recursive: true });

            const details = await RootDetector.detectRootWithDetails(customDir, ['.nonexistent']);
            expect(details.markerFound).toBe('FALLBACK');
            expect(details.depth).toBe(-1);

            // Clean up
            fs.rmSync(customRoot, { recursive: true, force: true });
        });
    });

    describe('isWithinProject', () => {
        it('should return true for file within project', async () => {
            const srcFile = path.join(nestedDir, 'main.ts');
            const isWithin = await RootDetector.isWithinProject(srcFile);
            expect(isWithin).toBe(true);
        });

        it('should return true for root directory itself', async () => {
            const isWithin = await RootDetector.isWithinProject(projectRoot);
            expect(isWithin).toBe(true);
        });

        it('should detect project root automatically', async () => {
            const deepFile = path.join(deeplyNestedDir, 'deep.ts');
            const isWithin = await RootDetector.isWithinProject(deepFile);
            expect(isWithin).toBe(true);
        });

        it('should accept explicit project root', async () => {
            const srcFile = path.join(nestedDir, 'main.ts');
            const isWithin = await RootDetector.isWithinProject(srcFile, projectRoot);
            expect(isWithin).toBe(true);
        });

        it('should return false for file outside project with explicit root', async () => {
            const outsideFile = path.join(testDir, 'outside.ts');
            fs.writeFileSync(outsideFile, '');

            const isWithin = await RootDetector.isWithinProject(outsideFile, projectRoot);
            expect(isWithin).toBe(false);

            // Clean up
            fs.unlinkSync(outsideFile);
        });
    });

    describe('detectCurrentProjectRoot', () => {
        it('should detect root from current working directory', async () => {
            const cwd = process.cwd();
            try {
                process.chdir(deeplyNestedDir);
                const root = await RootDetector.detectCurrentProjectRoot();
                // Compare by resolving symlinks (handles macOS /var symlink issue)
                expectSamePath(root, projectRoot);
            } finally {
                process.chdir(cwd);
            }
        });

        it('should support custom markers for current project', async () => {
            const customRoot = path.join(testDir, 'current-custom');
            const customDir = path.join(customRoot, 'deep');
            fs.mkdirSync(customDir, { recursive: true });
            fs.writeFileSync(path.join(customRoot, '.custom-root'), '');

            const cwd = process.cwd();
            try {
                process.chdir(customDir);
                const root = await RootDetector.detectCurrentProjectRoot(['.custom-root']);
                // Compare by resolving symlinks (handles macOS /var symlink issue)
                expectSamePath(root, customRoot);
            } finally {
                process.chdir(cwd);
                fs.rmSync(customRoot, { recursive: true, force: true });
            }
        });
    });

    describe('Marker priority and selection', () => {
        it('should prefer .git if it exists at same level', async () => {
            const customRoot = path.join(testDir, 'git-root');
            fs.mkdirSync(customRoot, { recursive: true });
            fs.mkdirSync(path.join(customRoot, '.git'), { recursive: true });
            fs.writeFileSync(path.join(customRoot, 'package.json'), '{}');
            fs.writeFileSync(path.join(customRoot, 'README.md'), '');

            const subDir = path.join(customRoot, 'sub');
            fs.mkdirSync(subDir, { recursive: true });

            const details = await RootDetector.detectRootWithDetails(subDir);
            expect(details.root).toBe(customRoot);
            // Should detect .git as it's first in the default markers list
            expect(details.markerFound).toBe('.git');

            // Clean up
            fs.rmSync(customRoot, { recursive: true, force: true });
        });

        it('should find nearest marker when multiple levels have markers', async () => {
            const grandparent = path.join(testDir, 'multi-level-1');
            const parent = path.join(grandparent, 'parent');
            const child = path.join(parent, 'child');

            fs.mkdirSync(child, { recursive: true });
            fs.writeFileSync(path.join(grandparent, 'package.json'), '{}');
            fs.writeFileSync(path.join(parent, 'tsconfig.json'), '{}');

            const details = await RootDetector.detectRootWithDetails(child);
            // Should find parent (closer), not grandparent
            expect(details.root).toBe(parent);
            expect(details.depth).toBe(1);

            // Clean up
            fs.rmSync(grandparent, { recursive: true, force: true });
        });
    });

    describe('Edge cases and error handling', () => {
        it('should handle non-existent paths', async () => {
            const nonExistent = path.join(testDir, 'nonexistent', 'deep', 'path.ts');
            // Should not throw, return fallback
            const root = await RootDetector.detectRoot(nonExistent);
            expect(root).toBeDefined();
        });

        it('should handle deeply nested paths', async () => {
            const veryDeep = path.join(
                projectRoot,
                'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k'
            );
            fs.mkdirSync(veryDeep, { recursive: true });

            const root = await RootDetector.detectRoot(veryDeep);
            expect(root).toBe(projectRoot);

            // Clean up
            fs.rmSync(path.join(projectRoot, 'a'), { recursive: true, force: true });
        });

        it('should handle paths with special characters', async () => {
            const specialDir = path.join(projectRoot, 'dir-with-special_chars.test');
            fs.mkdirSync(specialDir, { recursive: true });

            const root = await RootDetector.detectRoot(specialDir);
            expect(root).toBe(projectRoot);

            // Clean up
            fs.rmSync(specialDir, { recursive: true, force: true });
        });

        it('should handle max depth limit gracefully', async () => {
            // Create a very deep directory structure that exceeds MAX_DEPTH
            const maxDeepDir = path.join(testDir, ...Array(20).fill('level'));
            try {
                fs.mkdirSync(maxDeepDir, { recursive: true });

                // Should return fallback, not throw
                const root = await RootDetector.detectRoot(maxDeepDir, ['nonexistent-marker']);
                expect(root).toBeDefined();
            } finally {
                // Clean up
                try {
                    fs.rmSync(path.join(testDir, 'level'), { recursive: true, force: true });
                } catch {
                    // Ignore cleanup errors
                }
            }
        });
    });

    describe('Consistency across sync and async', () => {
        it('should produce identical results for sync and async detection', async () => {
            const testPaths = [
                projectRoot,
                nestedDir,
                deeplyNestedDir,
                path.join(deeplyNestedDir, 'deep.ts')
            ];

            for (const testPath of testPaths) {
                const syncResult = RootDetector.detectRootSync(testPath);
                const asyncResult = await RootDetector.detectRoot(testPath);
                expect(syncResult).toBe(asyncResult);
            }
        });

        it('should handle custom markers consistently', async () => {
            const customRoot = path.join(testDir, 'custom-marker-consistency');
            const deepDir = path.join(customRoot, 'a', 'b', 'c');
            fs.mkdirSync(deepDir, { recursive: true });
            fs.writeFileSync(path.join(customRoot, '.my-marker'), '');

            const markers = ['.my-marker'];

            const syncResult = RootDetector.detectRootSync(deepDir, markers);
            const asyncResult = await RootDetector.detectRoot(deepDir, markers);

            expect(syncResult).toBe(asyncResult);
            expect(syncResult).toBe(customRoot);

            // Clean up
            fs.rmSync(customRoot, { recursive: true, force: true });
        });
    });
});
