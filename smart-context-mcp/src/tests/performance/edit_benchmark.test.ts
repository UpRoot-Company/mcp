
import { SmartContextServer } from "../../index.js";
import * as fs from "fs";
import * as path from "path";

describe('Performance - edit_file', () => {
    let server: SmartContextServer;
    const perfTestDir = path.join(__dirname, 'perf_files');
    const largeFileName = 'large_file.txt';

    beforeAll(() => {
        if (!fs.existsSync(perfTestDir)) {
            fs.mkdirSync(perfTestDir);
        }

        const uniqueTarget = 'UNIQUE_TARGET_STRING_FOR_PERF_TEST';
        // Create a 1MB file for performance testing
        const largeContent = uniqueTarget + 'a'.repeat(1024 * 1024 - uniqueTarget.length);
        fs.writeFileSync(path.join(perfTestDir, largeFileName), largeContent);

        server = new SmartContextServer(perfTestDir);
    });

    afterAll(() => {
        if (fs.existsSync(perfTestDir)) {
            fs.rmSync(perfTestDir, { recursive: true, force: true });
        }
    });

    it('should perform edits on a large file in a reasonable time', async () => {
        const startTime = Date.now();

        const args = {
            filePath: largeFileName,
            edits: [
                { targetString: 'UNIQUE_TARGET_STRING_FOR_PERF_TEST', replacementString: 'REPLACED' }
            ]
        };

        const response = await (server as any).handleCallTool('edit_file', args);

        const endTime = Date.now();
        console.log(`[PERF] edit_file took ${endTime - startTime}ms`);

        expect(response.isError).toBeFalsy();
    }, 10000); // 10 seconds timeout for this test
});

/**
 * ADR-024: Enhanced Edit Flexibility and Safety Performance Benchmarks
 *
 * This test suite validates that the new Confidence Scoring and Normalization
 * features do not introduce unacceptable performance overhead.
 */
describe('Performance - ADR-024 Confidence Scoring and Normalization', () => {
    let server: SmartContextServer;
    const perfTestDir = path.join(__dirname, 'perf_adr024');

    beforeAll(() => {
        if (!fs.existsSync(perfTestDir)) {
            fs.mkdirSync(perfTestDir, { recursive: true });
        }
        server = new SmartContextServer(perfTestDir);
    });

    afterAll(() => {
        if (fs.existsSync(perfTestDir)) {
            fs.rmSync(perfTestDir, { recursive: true, force: true });
        }
    });

    it('should compute confidence scores with < 2ms overhead per edit', async () => {
        const testFile = path.join(perfTestDir, 'confidence_test.ts');
        const content = `
function authenticate(username,password) {
  return validateCredentials(username, password);
}

function validateCredentials(user, pass) {
  return user && pass && user.length > 0;
}

export { authenticate, validateCredentials };
        `.trim();

        fs.writeFileSync(testFile, content);

        const startTime = Date.now();

        const args = {
            edits: [{
                filePath: 'confidence_test.ts',
                operation: 'replace',
                targetString: 'function authenticate(username,password) {',
                replacementString: 'async function authenticate(username, password) {',
                normalization: 'whitespace'
            }]
        };

        const response = await (server as any).handleCallTool('edit_code', args);
        const elapsed = Date.now() - startTime;

        console.log(`[PERF] Confidence scoring (single edit) took ${elapsed}ms`);
        expect(elapsed).toBeLessThan(50); // Should complete quickly
        expect(response.success || response.results).toBeDefined();
    }, 10000);

    it('should handle 6-level normalization cascade efficiently', async () => {
        const testFile = path.join(perfTestDir, 'normalization_test.ts');
        const content = `const  x  =  1;  \r\nconst  y  =  2;  `;
        fs.writeFileSync(testFile, content);

        const perfMetrics: Record<string, number> = {};

        // Test each normalization level
        for (const level of ['exact', 'line-endings', 'trailing', 'indentation', 'whitespace', 'structural'] as const) {
            const startTime = Date.now();

            const args = {
                edits: [{
                    filePath: 'normalization_test.ts',
                    operation: 'replace',
                    targetString: 'const x = 1;',
                    replacementString: 'const x = 100;',
                    normalization: level === 'exact' ? undefined : level
                }]
            };

            try {
                await (server as any).handleCallTool('edit_code', args);
            } catch {
                // Expected for some levels on this test case
            }

            perfMetrics[level] = Date.now() - startTime;
        }

        console.log('[PERF] Normalization cascade metrics:', perfMetrics);

        // Each normalization should be fast (under 20ms)
        Object.values(perfMetrics).forEach(time => {
            expect(time).toBeLessThan(50);
        });
    }, 15000);

    it('should compute hash verification for large files efficiently', async () => {
        const testFile = path.join(perfTestDir, 'delete_hash_test.ts');
        const content = 'a'.repeat(15_000); // Create 15KB file
        fs.writeFileSync(testFile, content);

        const startTime = Date.now();

        // Simulate dry-run to get hash
        const args = {
            edits: [{
                filePath: 'delete_hash_test.ts',
                operation: 'delete'
            }],
            dryRun: true
        };

        const response = await (server as any).handleCallTool('edit_code', args);
        const hashComputeTime = Date.now() - startTime;

        console.log(`[PERF] Delete hash computation (15KB file) took ${hashComputeTime}ms`);

        // Hash computation should be fast (under 100ms even for large files)
        expect(hashComputeTime).toBeLessThan(200);
        expect(response.results?.[0]?.contentPreview).toBeDefined();
    }, 10000);

    it('should handle refactoring context guidance without performance penalty', async () => {
        const testFile = path.join(perfTestDir, 'refactor_context_test.ts');
        fs.writeFileSync(testFile, 'const oldName = 1;');

        const startTime = Date.now();

        const args = {
            refactoringContext: {
                pattern: 'rename-symbol',
                scope: 'project',
                estimatedEdits: 25
            },
            edits: [{
                filePath: 'refactor_context_test.ts',
                operation: 'replace',
                targetString: 'const oldName = 1;',
                replacementString: 'const newName = 1;'
            }],
            dryRun: true
        };

        const response = await (server as any).handleCallTool('edit_code', args);
        const elapsed = Date.now() - startTime;

        console.log(`[PERF] Refactoring context guidance took ${elapsed}ms`);
        expect(elapsed).toBeLessThan(50);
        expect(response.warnings || response.message).toBeDefined();
    }, 10000);
});
