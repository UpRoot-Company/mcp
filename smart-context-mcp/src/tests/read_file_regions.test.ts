
import { SmartContextServer } from "../index.js";
import * as fs from "fs";
import * as path from "path";
import { ReadFragmentResult } from "../types.js";

describe('SmartContextServer - read_fragment', () => {
    let server: SmartContextServer;
    const testFilesDir = path.join(process.cwd(), 'src', 'tests', 'test_files');
    const testFileName = 'read_test.txt';
    const originalStorageMode = process.env.SMART_CONTEXT_STORAGE_MODE;

    beforeAll(() => {
        process.env.SMART_CONTEXT_STORAGE_MODE = "memory";
        server = new SmartContextServer(process.cwd());
        if (!fs.existsSync(testFilesDir)) {
            fs.mkdirSync(testFilesDir, { recursive: true });
        }
        const content = [
            'Line 1: Start',
            'Line 2: Context',
            'Line 3: Target1',
            'Line 4: Context',
            'Line 5: Gap',
            'Line 6: Context',
            'Line 7: Target2',
            'Line 8: Context',
            'Line 9: End',
            'Line 10: Footer'
        ].join('\n');
        fs.writeFileSync(path.join(testFilesDir, testFileName), content);
    });

    afterAll(async () => {
        if (server) {
            await server.shutdown();
        }
        if (fs.existsSync(testFilesDir)) {
            fs.rmSync(testFilesDir, { recursive: true, force: true });
        }
        if (originalStorageMode === undefined) {
            delete process.env.SMART_CONTEXT_STORAGE_MODE;
        } else {
            process.env.SMART_CONTEXT_STORAGE_MODE = originalStorageMode;
        }
    });

    it('should extract lines with keyword matches', async () => {
        const args = {
            filePath: path.join('src', 'tests', 'test_files', testFileName),
            keywords: ['Target1'],
            contextLines: 0
        };
        const response = await (server as any).handleCallTool('read_fragment', args);
        expect(response.isError).toBeFalsy();
        const result: ReadFragmentResult = JSON.parse(response.content[0].text);
        expect(result.content).toContain('Line 3: Target1');
        expect(result.content).not.toContain('Line 2: Context');
    });

    it('should extract lines with context', async () => {
        const args = {
            filePath: path.join('src', 'tests', 'test_files', testFileName),
            keywords: ['Target1'],
            contextLines: 1
        };
        const response = await (server as any).handleCallTool('read_fragment', args);
        expect(response.isError).toBeFalsy();
        const result: ReadFragmentResult = JSON.parse(response.content[0].text);
        expect(result.content).toContain('Line 2: Context');
        expect(result.content).toContain('Line 3: Target1');
        expect(result.content).toContain('Line 4: Context');
    });

    it('should merge overlapping intervals', async () => {
        const args = {
            filePath: path.join('src', 'tests', 'test_files', testFileName),
            keywords: ['Target1', 'Target2'],
            contextLines: 2
        };
        const response = await (server as any).handleCallTool('read_fragment', args);
        expect(response.isError).toBeFalsy();
        const result: ReadFragmentResult = JSON.parse(response.content[0].text);
        expect(result.content).toContain('--- Lines 1-9 ---');
        expect(result.content).toContain('Line 1: Start');
        expect(result.content).toContain('Line 5: Gap');
        expect(result.content).toContain('Line 9: End');
        expect(result.ranges).toHaveLength(1);
        expect(result.ranges[0]).toEqual({ start: 1, end: 9 });
    });

    it('should extract explicitly provided line ranges', async () => {
        const args = {
            filePath: path.join('src', 'tests', 'test_files', testFileName),
            lineRanges: [{ start: 1, end: 2 }, { start: 9, end: 10 }]
        };
        const response = await (server as any).handleCallTool('read_fragment', args);
        expect(response.isError).toBeFalsy();
        const result: ReadFragmentResult = JSON.parse(response.content[0].text);
        expect(result.content).toContain('--- Lines 1-2 ---');
        expect(result.content).toContain('Line 1: Start');
        expect(result.content).toContain('--- Lines 9-10 ---');
        expect(result.content).toContain('Line 10: Footer');
    });

    it('should handle file not found', async () => {
        const args = {
            filePath: 'nonexistent.txt',
            keywords: ['test']
        };
        const response = await (server as any).handleCallTool('read_fragment', args);
        expect(response.isError).toBe(true);
        const errorDetails = JSON.parse(response.content[0].text);
        expect(errorDetails.message).toContain('File not found');
    });

    it('should read entire file if no keywords or lineRanges are provided', async () => {
        const args = {
            filePath: path.join('src', 'tests', 'test_files', testFileName)
        };
        const response = await (server as any).handleCallTool('read_fragment', args);
        expect(response.isError).toBeFalsy();
        const result: ReadFragmentResult = JSON.parse(response.content[0].text);
        const originalContent = fs.readFileSync(path.join(testFilesDir, testFileName), 'utf-8');
        expect(result.content).toEqual(originalContent);
        expect(result.ranges[0]).toEqual({ start: 1, end: 10 });
    });
});
