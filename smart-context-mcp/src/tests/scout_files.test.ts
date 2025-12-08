
import { SmartContextServer } from "../index.js";
import * as fs from "fs";
import * as path from "path";
import { FileSearchResult } from "../types.js";

describe('SmartContextServer - scout_files', () => {
    let server: SmartContextServer;
    const testFilesDir = path.join(process.cwd(), 'src', 'tests', 'test_files');
    const rankingKeyword = 'rankingToken';
    const tieBreakerKeyword = 'keywordToken';

    beforeAll(() => {
        server = new SmartContextServer(process.cwd());
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
    });

    afterAll(() => {
        if (fs.existsSync(testFilesDir)) {
            fs.rmSync(testFilesDir, { recursive: true, force: true });
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
    });
});
