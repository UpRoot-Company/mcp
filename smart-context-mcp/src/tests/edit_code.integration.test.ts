import { describe, beforeEach, afterEach, it, expect } from '@jest/globals';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SmartContextServer } from '../index.js';

const runTool = async (server: SmartContextServer, toolName: string, args: any) => {
    const response = await (server as any).handleCallTool(toolName, args);
    expect(response).toBeDefined();
    const payload = JSON.parse(response.content[0].text);
    return payload;
};

describe('SmartContextServer - edit_code integration', () => {
    let server: SmartContextServer;
    let testRoot: string;

    beforeEach(async () => {
        testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'edit-code-test-'));
        fs.mkdirSync(path.join(testRoot, 'src'), { recursive: true });
        server = new SmartContextServer(testRoot);
    });

    afterEach(async () => {
        await server.shutdown();
        fs.rmSync(testRoot, { recursive: true, force: true });
    });

    it('replays escaped replacements end-to-end', async () => {
        const relPath = path.join('src', 'escaped.ts');
        const absPath = path.join(testRoot, relPath);
        fs.writeFileSync(absPath, 'const label = "before";\n', 'utf-8');

        const result = await runTool(server, 'edit_code', {
            edits: [{
                filePath: relPath,
                operation: 'replace',
                targetString: 'const label = "before";',
                replacementString: 'const label = \\\"after\\\";'
            }]
        });

        expect(result.success).toBe(true);
        const updated = fs.readFileSync(absPath, 'utf-8');
        expect(updated).toContain('const label = "after";');
        expect(updated).not.toContain('\\"');
    });

    it('handles CRLF content and undo via manage_project', async () => {
        const relFirst = path.join('src', 'windows.ts');
        const relSecond = path.join('src', 'second.ts');
        const absFirst = path.join(testRoot, relFirst);
        const absSecond = path.join(testRoot, relSecond);

        fs.writeFileSync(absFirst, 'alpha\r\nbeta\r\n', 'utf-8');
        fs.writeFileSync(absSecond, 'first line\nsecond line\n', 'utf-8');

        const editResult = await runTool(server, 'edit_code', {
            edits: [
                {
                    filePath: relFirst,
                    operation: 'replace',
                    targetString: 'alpha\\r\\nbeta',
                    replacementString: 'alpha\\nBETA'
                },
                {
                    filePath: relSecond,
                    operation: 'replace',
                    targetString: 'second line',
                    replacementString: 'second line (patched)'
                }
            ]
        });
        expect(editResult.success).toBe(true);
        expect(fs.readFileSync(absFirst, 'utf-8')).toContain('alpha\\nBETA');
        expect(fs.readFileSync(absSecond, 'utf-8')).toContain('second line (patched)');

        const undoResult = await runTool(server, 'manage_project', { command: 'undo' });
        expect(undoResult.output).toMatch(/undid/i);
        expect(fs.readFileSync(absFirst, 'utf-8')).toBe('alpha\r\nbeta\r\n');
        expect(fs.readFileSync(absSecond, 'utf-8')).toBe('first line\nsecond line\n');
    });

    it('surfacing actionable errors for ambiguous matches', async () => {
        const relPath = path.join('src', 'ambiguous.ts');
        const absPath = path.join(testRoot, relPath);
        fs.writeFileSync(absPath, 'repeat\nrepeat\n', 'utf-8');

        const result = await runTool(server, 'edit_code', {
            edits: [{
                filePath: relPath,
                operation: 'replace',
                targetString: 'repeat',
                replacementString: 'patched'
            }]
        });

        expect(result.success).toBe(false);
        expect(result.results?.[0]?.error).toMatch(/Ambiguous match/i);
    });
});
