import { SmartContextServer } from "../index.js";
import * as fs from "fs";
import * as path from "path";
import { EditResult } from "../types.js";
import * as crypto from "crypto";
import { PathManager } from "../utils/PathManager.js";
import { describe, test, expect, beforeEach, afterEach, it } from "@jest/globals";

describe('SmartContextServer - edit_file', () => {
    let server: SmartContextServer;
    const testFilesDir = path.join(process.cwd(), 'src', 'tests', 'test_files');
    const testFileName = 'replace_test.txt';
    let backupsDir: string;
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

    beforeEach(async () => {
        // Initialize PathManager
        PathManager.setRoot(process.cwd());
        backupsDir = PathManager.getBackupDir();

        if (!fs.existsSync(testFilesDir)) {
            fs.mkdirSync(testFilesDir, { recursive: true });
        }
        server = new SmartContextServer(process.cwd());
        const encodedPrefix = getEncodedPathPrefix(testFileName);
        
        // Clean up old backups
        if (fs.existsSync(backupsDir)) {
            const files = fs.readdirSync(backupsDir);
            for (const file of files) {
                if (file.startsWith(encodedPrefix)) {
                    fs.unlinkSync(path.join(backupsDir, file));
                }
            }
        }

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
        fs.writeFileSync(path.join(testFilesDir, testFileName), content, 'utf-8');
    });

    afterEach(async () => {
        await server.shutdown();
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
        expect(newContent).not.toContain('UniqueTarget');

        const encodedPrefix = getEncodedPathPrefix(testFileName);
        const backupFiles = fs.readdirSync(backupsDir).filter(f => f.startsWith(`${encodedPrefix}_`));
        expect(backupFiles.length).toBe(1);
        const backupContent = fs.readFileSync(path.join(backupsDir, backupFiles[0]), 'utf-8');
        expect(backupContent).toBe(originalContent);
    });

    it('should enforce backup retention policy', async () => {
        const encodedPrefix = getEncodedPathPrefix(testFileName);
        if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });
        
        for (let i = 0; i < 12; i++) {
            const timestamp = new Date(Date.now() - (i * 1000)).toISOString().replace(/[:.-]/g, '');
            fs.writeFileSync(path.join(backupsDir, `${encodedPrefix}_${timestamp}.bak`), 'old content');
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
        expect(response.isError).toBeTruthy();
        const error: EditResult = JSON.parse(response.content[0].text);
        expect(error.errorCode).toBe('AMBIGUOUS_MATCH');
        expect(error.message).toContain('Ambiguous match');
        expect(error.details?.conflictingLines).toContain(3);
        expect(error.details?.conflictingLines).toContain(4);
    });

    it('should support whitespace-tolerant matching via fuzzyMode', async () => {
        const args = {
            filePath: relativeTestFilePath,
            edits: [{ targetString: 'Fuzzy   Target   With   Spaces', replacementString: 'FuzzyReplaced', fuzzyMode: 'whitespace' }]
        };
        const response = await (server as any).handleCallTool('edit_file', args);
        expect(response.isError).toBeFalsy();
        const newContent = fs.readFileSync(path.join(testFilesDir, testFileName), 'utf-8');
        expect(newContent).toContain('FuzzyReplaced');
    });

    it('should respect contextual anchors', async () => {
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
        expect(newContent).toContain('Line 6: Context Anchor ContextualTarget Post');
        expect(newContent).toContain('Line 7: Another Anchor Target Post');
    });

    it('should fail if context anchors do not match', async () => {
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
        expect(response.isError).toBeTruthy();
        const error: EditResult = JSON.parse(response.content[0].text);
        expect(error.errorCode).toBe('NO_MATCH');
    });

    it('should handle multi-line replacements with structural normalization', async () => {
        const filePath = path.join(testFilesDir, testFileName);
        const original = fs.readFileSync(filePath, 'utf-8');
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

    it('should handle small typos using Levenshtein distance', async () => {
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
        expect(response.isError).toBeFalsy();
        const newContent = fs.readFileSync(path.join(testFilesDir, testFileName), 'utf-8');
        expect(newContent).toContain('LevenshteinReplaced');
    });

    it('should fail Levenshtein if ambiguity is detected', async () => {
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
        expect(response.isError).toBeTruthy();
        const error: EditResult = JSON.parse(response.content[0].text);
        expect(error.errorCode).toBe('AMBIGUOUS_MATCH');
    });

    it('should fail Levenshtein if no reasonable match exists', async () => {
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
        expect(response.isError).toBeTruthy();
        const error: EditResult = JSON.parse(response.content[0].text);
        expect(error.errorCode).toBe('NO_MATCH');
    });

    it('should fail if expectedHash validation fails', async () => {
        const filePath = path.join(testFilesDir, testFileName);
        const original = fs.readFileSync(filePath, 'utf-8');
        const lines = original.split('\n');
        const lineTwoWithNewline = lines[1] + '\n';
        const hash = crypto.createHash('sha256').update(lineTwoWithNewline).digest('hex');
        
        // Mutate file on disk to trigger hash failure
        fs.writeFileSync(filePath, original.replace('Line 2: UniqueTarget', 'Line 2: UniqueTarget (mutated)'), 'utf-8');

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
        expect(response.isError).toBeTruthy();
        const error: EditResult = JSON.parse(response.content[0].text);
        expect(error.errorCode).toBe('HASH_MISMATCH');
    });

    it('should succeed if expectedHash validation passes', async () => {
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
