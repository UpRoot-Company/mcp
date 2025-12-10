
import { SmartContextServer } from "../index.js";
import * as fs from "fs";
import * as path from "path";
import { EditResult } from "../types.js";
import * as crypto from "crypto";

describe('SmartContextServer - edit_file', () => {
    let server: SmartContextServer;
    const testFilesDir = path.join(process.cwd(), 'src', 'tests', 'test_files');
    const testFileName = 'replace_test.txt';
    const backupsDir = path.join(process.cwd(), '.mcp', 'backups');
    const relativeTestFilePath = path.join('src', 'tests', 'test_files', testFileName);

    const getEncodedPathPrefix = (filePath: string): string => {
        const absolutePath = path.join(testFilesDir, filePath);
        const relativePath = path.relative(process.cwd(), absolutePath);
        const fullPath = relativePath || absolutePath;
        const encoded = fullPath
            .replace(/^[A-Z]:/i, (drive) => drive[0] + '_')
            .replace(/["\\/\\:]/g, '_')
            .replace(/^_/, '');
        return encoded;
    };

    beforeEach(() => {
        if (fs.existsSync(testFilesDir)) {
            fs.rmSync(testFilesDir, { recursive: true, force: true });
        }
        fs.mkdirSync(testFilesDir, { recursive: true });
        fs.mkdirSync(backupsDir, { recursive: true });
        const encodedPrefix = getEncodedPathPrefix(testFileName);
        fs.readdirSync(backupsDir)
            .filter(file => file.startsWith(`${encodedPrefix}_`))
            .forEach(file => fs.rmSync(path.join(backupsDir, file), { force: true }));

        server = new SmartContextServer(process.cwd());

        const content = [
            'Line 1: Header',
            'Line 2: UniqueTarget',
            'Line 3: Duplicate',
            'Line 4: Duplicate',
            'Line 5: Fuzzy   Target   With   Spaces',
            'Line 6: Context Anchor Target Post',
            'Line 7: Another Anchor Target Post',
            'Line 8: Footer'
        ].join('\n');
        fs.writeFileSync(path.join(testFilesDir, testFileName), content);
    });

    afterAll(() => {
        if (fs.existsSync(testFilesDir)) {
            fs.rmSync(testFilesDir, { recursive: true, force: true });
        }
    });

    it('should replace a unique target string and create a backup', async () => {
        const originalContent = fs.readFileSync(path.join(testFilesDir, testFileName), 'utf-8');
        const args = {
            filePath: relativeTestFilePath,
            edits: [{ targetString: 'UniqueTarget', replacementString: 'ReplacedTarget' }]
        };

        const response = await (server as any).handleCallTool('edit_file', args);
        expect(response.isError).toBeFalsy();

        const newContent = fs.readFileSync(path.join(testFilesDir, testFileName), 'utf-8');
        expect(newContent).toContain('ReplacedTarget');

        const encodedPrefix = getEncodedPathPrefix(testFileName);
        const backupFiles = fs.readdirSync(backupsDir).filter(f => f.startsWith(`${encodedPrefix}_`));
        expect(backupFiles.length).toBe(1);
        const backupContent = fs.readFileSync(path.join(backupsDir, backupFiles[0]), 'utf-8');
        expect(backupContent).toBe(originalContent);
    });

    it('should enforce backup retention policy', async () => {
        const encodedPrefix = getEncodedPathPrefix(testFileName);
        for (let i = 0; i < 12; i++) {
            const timestamp = new Date(Date.now() - (i * 1000)).toISOString().replace(/[:.-]/g, '');
            fs.writeFileSync(path.join(backupsDir, `${encodedPrefix}_${timestamp}.bak`), `dummy ${i}`);
        }

        const args = {
            filePath: relativeTestFilePath,
            edits: [{ targetString: 'UniqueTarget', replacementString: 'AnotherNewTarget' }]
        };

        await (server as any).handleCallTool('edit_file', args);

        const remainingBackups = fs.readdirSync(backupsDir).filter(f => f.startsWith(`${encodedPrefix}_`));
        expect(remainingBackups.length).toBe(10);
    });

    it('should fail on ambiguous match and provide actionable feedback', async () => {
        const args = {
            filePath: relativeTestFilePath,
            edits: [{ targetString: 'Duplicate', replacementString: 'ShouldFail' }]
        };

        const response = await (server as any).handleCallTool('edit_file', args);
        expect(response.isError).toBe(true);
        const error: EditResult = JSON.parse(response.content[0].text);
        expect(error.errorCode).toBe('AMBIGUOUS_MATCH');
        expect(error.message).toContain('Found 2 occurrences');
        expect(error.suggestion?.toolName).toBe('debug_edit_match');
        expect(error.details?.conflictingLines).toEqual([3, 4]);
    });

    it('should perform whitespace fuzzy matching', async () => {
        const args = {
            filePath: relativeTestFilePath,
            edits: [{ targetString: 'Fuzzy   Target   With   Spaces', replacementString: 'FuzzyReplaced', fuzzyMode: 'whitespace' }]
        };
        const response = await (server as any).handleCallTool('edit_file', args);
        expect(response.isError).toBeFalsy();
        const newContent = fs.readFileSync(path.join(testFilesDir, testFileName), 'utf-8');
        expect(newContent).toContain('FuzzyReplaced');
        expect(newContent).not.toContain('Fuzzy   Target   With   Spaces');
    });

    it('should use beforeContext and afterContext for precise matching', async () => {
        const args = {
            filePath: relativeTestFilePath,
            edits: [
                {
                    targetString: 'Target',
                    replacementString: 'ContextualTarget',
                    beforeContext: 'Anchor',
                    afterContext: 'Post',
                    lineRange: { start: 6, end: 6 }
                }
            ]
        };
        const response = await (server as any).handleCallTool('edit_file', args);
        expect(response.isError).toBeFalsy();
        const newContent = fs.readFileSync(path.join(testFilesDir, testFileName), 'utf-8');
        expect(newContent).toContain('Context Anchor ContextualTarget Post');
        expect(newContent).not.toContain('Context Anchor Target Post');
    });

    it('should fail if beforeContext does not match', async () => {
        const args = {
            filePath: relativeTestFilePath,
            edits: [
                {
                    targetString: 'Target',
                    replacementString: 'ContextualTarget',
                    beforeContext: 'NONEXISTENT Anchor',
                    afterContext: 'Post',
                    lineRange: { start: 6, end: 6 }
                }
            ]
        };
        const response = await (server as any).handleCallTool('edit_file', args);
        expect(response.isError).toBe(true);
        const error: EditResult = JSON.parse(response.content[0].text);
        expect(error.message).toContain('Target not found');
    });

    it('should respect structural normalization for CRLF multi-line edits', async () => {
        const filePath = path.join(testFilesDir, testFileName);
        const original = fs.readFileSync(filePath, 'utf-8');
        fs.writeFileSync(filePath, original.replace(/\n/g, '\r\n'));

        const args = {
            filePath: relativeTestFilePath,
            edits: [
                {
                    targetString: 'Line 3: Duplicate\nLine 4: Duplicate',
                    replacementString: 'Line 3: Patched\nLine 4: Duplicate',
                    lineRange: { start: 3, end: 4 },
                    normalization: 'structural'
                }
            ]
        };

        const response = await (server as any).handleCallTool('edit_file', args);
        expect(response.isError).toBeFalsy();
        const newContent = fs.readFileSync(filePath, 'utf-8');
        expect(newContent).toContain('Line 3: Patched');
    });

    it('should handle Levenshtein fuzzy matching', async () => {
        const args = {
            filePath: relativeTestFilePath,
            edits: [
                {
                    targetString: 'UniqeTrget', // Typo for 'UniqueTarget'
                    replacementString: 'LevenshteinReplaced',
                    fuzzyMode: 'levenshtein',
                    lineRange: { start: 2, end: 2 }
                }
            ]
        };
        const response = await (server as any).handleCallTool('edit_file', args);
        expect(response.isError).toBeFalsy(); // Should succeed now!
        const newContent = fs.readFileSync(path.join(testFilesDir, testFileName), 'utf-8');
        expect(newContent).toContain('LevenshteinReplaced');
    });

    it('should fail Levenshtein matching if too many candidates after context filtering', async () => {
        const args = {
            filePath: relativeTestFilePath,
            edits: [
                {
                    targetString: 'Duplicat', // Typo for 'Duplicate'
                    replacementString: 'LevenshteinFail',
                    fuzzyMode: 'levenshtein',
                }
            ]
        };
        const response = await (server as any).handleCallTool('edit_file', args);
        expect(response.isError).toBe(true);
        const error: EditResult = JSON.parse(response.content[0].text);
        expect(error.errorCode).toBe('AMBIGUOUS_MATCH');
        expect(error.message).toContain('Found 2 occurrences');
    });

    it('should fail Levenshtein matching if minimum distance exceeds threshold', async () => {
        const args = {
            filePath: relativeTestFilePath,
            edits: [
                {
                    targetString: 'CompletelyDifferentString',
                    replacementString: 'LevenshteinFail',
                    fuzzyMode: 'levenshtein',
                    lineRange: { start: 2, end: 2 }
                }
            ]
        };
        const response = await (server as any).handleCallTool('edit_file', args);
        expect(response.isError).toBe(true);
        const error: EditResult = JSON.parse(response.content[0].text);
        expect(error.message).toContain('Target not found');
    });

    it('should detect hash mismatches when file drifts', async () => {
        const filePath = path.join(testFilesDir, testFileName);
        const original = fs.readFileSync(filePath, 'utf-8');
        const lines = original.split('\n');
        const lineTwoWithNewline = lines[1] + '\n';
        const hash = crypto.createHash('sha256').update(lineTwoWithNewline).digest('hex');

        const mutated = original.replace('Line 2: UniqueTarget', 'Line 2: UniqueTarget (mutated)');
        fs.writeFileSync(filePath, mutated);

        const args = {
            filePath: relativeTestFilePath,
            edits: [
                {
                    targetString: 'UniqueTarget',
                    replacementString: 'ShouldNotApply',
                    lineRange: { start: 2, end: 2 },
                    expectedHash: { algorithm: 'sha256', value: hash }
                }
            ]
        };

        const response = await (server as any).handleCallTool('edit_file', args);
        expect(response.isError).toBe(true);
        const error: EditResult = JSON.parse(response.content[0].text);
        expect(error.errorCode).toBe('HASH_MISMATCH');
    });

    it('should apply edits successfully when expectedHash matches', async () => {
        const filePath = path.join(testFilesDir, testFileName);
        const original = fs.readFileSync(filePath, 'utf-8');
        const lines = original.split('\n');
        const lineTwoWithNewline = lines[1] + '\n';
        const hash = crypto.createHash('sha256').update(lineTwoWithNewline).digest('hex');

        const args = {
            filePath: relativeTestFilePath,
            edits: [
                {
                    targetString: 'UniqueTarget',
                    replacementString: 'HashGuardedTarget',
                    lineRange: { start: 2, end: 2 },
                    expectedHash: { algorithm: 'sha256', value: hash }
                }
            ]
        };

        const response = await (server as any).handleCallTool('edit_file', args);
        expect(response.isError).toBeFalsy();
        const newContent = fs.readFileSync(filePath, 'utf-8');
        expect(newContent).toContain('HashGuardedTarget');
    });
});
