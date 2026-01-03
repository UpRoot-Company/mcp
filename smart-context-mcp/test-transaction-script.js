import { EditorEngine } from './src/engine/Editor.js';
import { EditCoordinator } from './src/engine/EditCoordinator.js';
import { HistoryEngine } from './src/engine/History.js';
import { NodeFileSystem } from './src/platform/FileSystem.js';
import { TransactionLog } from './src/engine/TransactionLog.js';
import * as path from 'path';
async function runTest() {
    const rootPath = process.cwd();
    const fs = new NodeFileSystem(rootPath);
    const history = new HistoryEngine(rootPath, fs); // Assuming HistoryEngine needs minimal args
    const editor = new EditorEngine(rootPath, fs);
    const transactionLog = new TransactionLog(path.join(rootPath, '.gemini/test-transaction/logs'));
    // Initialize EditCoordinator with transaction support
    const coordinator = new EditCoordinator(editor, history, {
        rootPath,
        fileSystem: fs,
        transactionLog
    });
    const fileA = '.gemini/test-transaction/test-a.ts';
    const fileB = '.gemini/test-transaction/test-b.ts';
    // Ensure absolute paths
    const absFileA = path.join(rootPath, fileA);
    const absFileB = path.join(rootPath, fileB);
    console.log('--- Starting Transaction Test ---');
    try {
        const result = await coordinator.applyBatchEdits([
            {
                filePath: absFileA,
                edits: [{
                        type: 'replace',
                        text: "console.log('File A Modified');",
                        range: { startLine: 0, endLine: 0, startColumn: 0, endColumn: 999 } // Simplified range, assuming engine handles it or we use fuzzy
                        // Actually, EditorEngine usually takes string-based fuzzy matches or specific line/col.
                        // Let's try to simulate what the tool does: construct edits that the engine understands.
                        // Based on my analysis, Edit type is defined in types.ts.
                    }]
            },
            {
                filePath: absFileB,
                edits: [{
                        type: 'replace',
                        text: "console.log('File B Modified');",
                        // Intentional mismatch: trying to replace text that doesn't exist or wrong location
                        // If we provide a 'range' that is valid, it might just overwrite.
                        // To fail, we need the EditorEngine to reject it. 
                        // Let's rely on 'fuzzy mismatch' if we could, but here we might need to rely on 'dryRun' logic or similar.
                        // Actually, if I give a valid range, it will succeed. 
                        // To make it fail, let's give an invalid range or content verification failure if the engine supports it.
                        // Or, simpler: let's use the 'verify' callback if available, but it's not.
                        // Wait, EditorEngine.applyEdits typically checks for context if provided.
                        // Let's try to mock an error by passing a non-existent file for B in the batch?
                        // No, that might fail before transaction starts.
                        // Let's try to pass an edit that throws an error, e.g. invalid line number.
                        range: { startLine: 100, endLine: 101, startColumn: 0, endColumn: 0 }
                    }]
            }
        ]);
        console.log('Result:', result);
    }
    catch (e) {
        console.error('Test Failed Exception:', e);
    }
    // Verify rollback
    const contentA = await fs.readFile(absFileA);
    const contentB = await fs.readFile(absFileB);
    console.log(`File A content: "${contentA.trim()}"`);
    console.log(`File B content: "${contentB.trim()}"`);
    if (contentA.includes('Original') && contentB.includes('Original')) {
        console.log('SUCCESS: Transaction rolled back successfully.');
    }
    else {
        console.log('FAILURE: Rollback failed.');
    }
}
runTest();
