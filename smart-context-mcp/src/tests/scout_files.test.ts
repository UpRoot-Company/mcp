
import { jest, describe, beforeAll, afterAll, beforeEach, it, expect } from '@jest/globals';
import { SmartContextServer } from "../index.js";
import * as fs from "fs";
import * as path from "path";
import { FileSearchResult } from "../types.js";

describe('SmartContextServer - scout_files', () => {
    let server: SmartContextServer;
    const testFilesDir = path.join(process.cwd(), 'src', 'tests', 'test_files');
    const rankingKeyword = 'rankingToken';
    const tieBreakerKeyword = 'keywordToken';

    // Increase timeout for all tests in this suite
    jest.setTimeout(30000);

    beforeAll(async () => {
        if (!fs.existsSync(testFilesDir)) {
            fs.mkdirSync(testFilesDir, { recursive: true });
        }

        fs.writeFileSync(path.join(testFilesDir, 'file1.txt'), 'This is a test file.\nIt contains keyword1 and keyword2.\nAnother line here.');
        fs.writeFileSync(path.join(testFilesDir, 'file2.ts'), '// TypeScript file\nconst data = "pattern1";\nfunction testFunc() { /* ... */ }\nconst another = "pattern2";');
        fs.writeFileSync(path.join(testFilesDir, 'file3.js'), 'console.log("keyword1");\nvar x = 1;');
        fs.writeFileSync(path.join(testFilesDir, 'empty.txt'), '');
        fs.writeFileSync(path.join(testFilesDir, 'ranking1.txt'), `${rankingKeyword} ${rankingKeyword} ${rankingKeyword} ${tieBreakerKeyword}`);
        fs.writeFileSync(path.join(testFilesDir, 'ranking2.txt'), `${rankingKeyword} ${tieBreakerKeyword}`);
        fs.writeFileSync(path.join(testFilesDir, 'ranking3.txt'), `another ${tieBreakerKeyword}`);
        fs.writeFileSync(path.join(testFilesDir, 'User.ts'), 'export const User = { name: "User" };\n');
        fs.writeFileSync(path.join(testFilesDir, 'UserManager.ts'), 'export class UserManager {\n    constructor() {\n        console.log("UserManager ready");\n    }\n}\n');

        server = new SmartContextServer(process.cwd());
        await server.waitForInitialScan();
    });

    afterAll(async () => {
        if (server) {
            await server.shutdown();
        }
        if (fs.existsSync(testFilesDir)) {
            try {
                fs.rmSync(testFilesDir, { recursive: true, force: true });
            } catch (e) {
                // Ignore cleanup errors
            }
        }
    });

    beforeEach(async () => {
        if (server) {
            await server.waitForInitialScan();
        }
    });

    it('should find files with a single keyword', async () => {
        const args = { keywords: ['keyword1'], excludeGlobs: ["node_modules"] };
        const response = await (server as any).handleCallTool('search_files', args);
        expect(response.isError).toBeFalsy();
        const result: FileSearchResult[] = JSON.parse(response.content[0].text);
        expect(result).toHaveLength(2);
        expect(result).toEqual(expect.arrayContaining([
            expect.objectContaining({ filePath: path.join('src', 'tests', 'test_files', 'file1.txt') }),
            expect.objectContaining({ filePath: path.join('src', 'tests', 'test_files', 'file3.js') }),
        ]));
    });

    it('should find files with a single regex pattern', async () => {
        const args = { patterns: ['pattern[1-2]'], excludeGlobs: ["**/node_modules/**"] };
        const response = await (server as any).handleCallTool('search_files', args);
        expect(response.isError).toBeFalsy();
        const result: FileSearchResult[] = JSON.parse(response.content[0].text);
        expect(result).toHaveLength(2);
        expect(result).toEqual(expect.arrayContaining([
            expect.objectContaining({ filePath: path.join('src', 'tests', 'test_files', 'file2.ts') }),
        ]));
    });

    it('should find files with multiple keywords/patterns and deduplicate', async () => {
        const args = { keywords: ['keyword2'], patterns: ['pattern1'], excludeGlobs: ["**/node_modules/**"] };
        const response = await (server as any).handleCallTool('search_files', args);
        expect(response.isError).toBeFalsy();
        const result: FileSearchResult[] = JSON.parse(response.content[0].text);
        expect(result).toHaveLength(2);
        expect(result).toEqual(expect.arrayContaining([
            expect.objectContaining({ filePath: path.join('src', 'tests', 'test_files', 'file1.txt') }),
            expect.objectContaining({ filePath: path.join('src', 'tests', 'test_files', 'file2.ts') }),
        ]));
    });

    it('should rank files by relevance using BM25', async () => {
        const args = { keywords: [rankingKeyword, tieBreakerKeyword], excludeGlobs: ["**/node_modules/**"] };
        const response = await (server as any).handleCallTool('search_files', args);
        expect(response.isError).toBeFalsy();
        const result: FileSearchResult[] = JSON.parse(response.content[0].text);
        expect(result).toHaveLength(3);

        // Expect ranking1.txt to have the highest score, then ranking2.txt, then ranking3.txt
        expect(result[0].filePath).toContain('ranking1.txt');
        expect(result[1].filePath).toContain('ranking2.txt');
        expect(result[2].filePath).toContain('ranking3.txt');

        expect(result[0].score).toBeGreaterThan(result[1].score!);
        expect(result[1].score).toBeGreaterThan(result[2].score!);
        expect(result[0].scoreDetails).toBeDefined();
    });

    it('should match substrings by default and honor word boundary option', async () => {
        const substringArgs = { keywords: ['User'], excludeGlobs: ["**/node_modules/**"] };
        const substringResponse = await (server as any).handleCallTool('search_files', substringArgs);
        expect(substringResponse.isError).toBeFalsy();
        const substringResult: FileSearchResult[] = JSON.parse(substringResponse.content[0].text);

        const exactMatch = substringResult.find(res => res.filePath.endsWith('User.ts'));
        const partialMatch = substringResult.find(res => res.filePath.endsWith('UserManager.ts'));

        expect(exactMatch).toBeDefined();
        expect(partialMatch).toBeDefined();
        expect(exactMatch!.score!).toBeGreaterThan(partialMatch!.score!);
        expect(exactMatch!.scoreDetails?.filenameMatchType).toBe('exact');
        expect(exactMatch!.scoreDetails?.filenameMultiplier).toBe(10);
        expect(partialMatch!.scoreDetails?.filenameMatchType).toBe('partial');
        expect(partialMatch!.scoreDetails?.filenameMultiplier).toBe(5);

        const boundaryArgs = { keywords: ['User'], wordBoundary: true, excludeGlobs: ["**/node_modules/**"] };
        const boundaryResponse = await (server as any).handleCallTool('search_files', boundaryArgs);
        expect(boundaryResponse.isError).toBeFalsy();
        const boundaryResult: FileSearchResult[] = JSON.parse(boundaryResponse.content[0].text);
        const hasPartial = boundaryResult.some(res => res.filePath.endsWith('UserManager.ts'));
        const hasExact = boundaryResult.some(res => res.filePath.endsWith('User.ts'));
        expect(hasPartial).toBe(false);
        expect(hasExact).toBe(true);
    });
});
