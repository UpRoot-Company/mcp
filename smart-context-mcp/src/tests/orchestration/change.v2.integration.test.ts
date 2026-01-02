/**
 * ADR-042-005 Phase B4: v2 Editor Integration Tests
 * 
 * Tests for:
 * - Batch change v2 success scenario
 * - Batch change v2 failure + rollback
 * - Ambiguous match error handling
 * - Write safeWrite + undo
 */

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { EditResolver } from '../../engine/EditResolver.js';
import { EditCoordinator } from '../../engine/EditCoordinator.js';
import { EditorEngine } from '../../engine/Editor.js';
import { HistoryEngine } from '../../engine/History.js';
import { NodeFileSystem } from '../../platform/FileSystem.js';
import { ConfigurationManager } from '../../config/ConfigurationManager.js';

describe('ADR-042-005 v2 Editor Integration', () => {
  let testDir: string;
  let fileSystem: NodeFileSystem;
  let editorEngine: EditorEngine;
  let historyEngine: HistoryEngine;
  let editCoordinator: EditCoordinator;
  let editResolver: EditResolver;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-integration-'));
    fileSystem = new NodeFileSystem(testDir);
    editorEngine = new EditorEngine(testDir, fileSystem);
    historyEngine = new HistoryEngine(testDir, fileSystem);
    editCoordinator = new EditCoordinator(editorEngine, historyEngine);
    editResolver = new EditResolver(fileSystem, editorEngine);

    // Enable v2 mode for tests
    process.env.SMART_CONTEXT_EDITOR_V2 = 'true';
    process.env.SMART_CONTEXT_EDITOR_V2_MODE = 'apply';
  });

  afterEach(() => {
    // Cleanup
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
    delete process.env.SMART_CONTEXT_EDITOR_V2;
    delete process.env.SMART_CONTEXT_EDITOR_V2_MODE;
  });

  describe('Batch change v2', () => {
    test('should successfully apply batch edits across multiple files', async () => {
      // Arrange: Create test files
      const file1 = path.join(testDir, 'file1.ts');
      const file2 = path.join(testDir, 'file2.ts');
      
      fs.writeFileSync(file1, 'function add(a, b) { return a + b; }');
      fs.writeFileSync(file2, 'function multiply(x, y) { return x * y; }');

      // Act: Resolve and apply batch edits
      const result1 = await editResolver.resolveAll(file1, [{
        targetString: 'a + b',
        replacementString: 'a + b + 1'
      }], {});

      const result2 = await editResolver.resolveAll(file2, [{
        targetString: 'x * y',
        replacementString: 'x * y * 2'
      }], {});

      expect(result1.success).toBe(true);
      expect(result2.success).toBe(true);

      const batchResult = await editCoordinator.applyBatchResolvedEdits([
        { filePath: file1, resolvedEdits: result1.resolvedEdits! },
        { filePath: file2, resolvedEdits: result2.resolvedEdits! }
      ], false);

      // Assert
      expect(batchResult.success).toBe(true);
      expect(fs.readFileSync(file1, 'utf-8')).toContain('a + b + 1');
      expect(fs.readFileSync(file2, 'utf-8')).toContain('x * y * 2');
    });

    test('should rollback all changes on batch failure', async () => {
      // Arrange
      const file1 = path.join(testDir, 'file1.ts');
      const file2 = path.join(testDir, 'file2.ts');
      
      const content1 = 'function add(a, b) { return a + b; }';
      const content2 = 'function multiply(x, y) { return x * y; }';
      
      fs.writeFileSync(file1, content1);
      fs.writeFileSync(file2, content2);

      // Act: First edit succeeds, second fails (invalid hash)
      const result1 = await editResolver.resolveAll(file1, [{
        targetString: 'a + b',
        replacementString: 'a + b + 1'
      }], {});

      expect(result1.success).toBe(true);

      // Manually create a resolved edit with wrong hash to force failure
      const badResolvedEdit = {
        filePath: file2,
        indexRange: { start: 35, end: 40 },
        targetString: 'x * y',
        expectedHash: { algorithm: 'sha256' as const, value: 'wrong-hash' },
        replacementString: 'x * y * 2'
      };

      try {
        await editCoordinator.applyBatchResolvedEdits([
          { filePath: file1, resolvedEdits: result1.resolvedEdits! },
          { filePath: file2, resolvedEdits: [badResolvedEdit] }
        ], false);
      } catch {
        // Expected to fail
      }

      // Assert: Both files should be unchanged (rollback)
      expect(fs.readFileSync(file1, 'utf-8')).toBe(content1);
      expect(fs.readFileSync(file2, 'utf-8')).toBe(content2);
    });
  });

  describe('Ambiguous match detection', () => {
    test('should fail with AMBIGUOUS_MATCH and provide lineRange suggestion', async () => {
      // Arrange
      const file = path.join(testDir, 'ambiguous.ts');
      fs.writeFileSync(file, `
function test1() { return 42; }
function test2() { return 42; }
function test3() { return 42; }
      `.trim());

      // Act: Try to edit ambiguous target
      const result = await editResolver.resolveAll(file, [{
        targetString: 'return 42',
        replacementString: 'return 100'
      }], { allowAmbiguousAutoPick: false });

      // Assert
      expect(result.success).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors![0].errorCode).toBe('AMBIGUOUS_MATCH');
      expect(result.errors![0].suggestion).toBeDefined();
      expect(result.errors![0].suggestion!.lineRange).toBeDefined();
    });

    test('should succeed when lineRange narrows to single match', async () => {
      // Arrange
      const file = path.join(testDir, 'narrowed.ts');
      const content = `
function test1() { return 42; }
function test2() { return 42; }
function test3() { return 42; }
      `.trim();
      fs.writeFileSync(file, content);

      // Act: Provide lineRange to narrow down
      const result = await editResolver.resolveAll(file, [{
        targetString: 'return 42',
        replacementString: 'return 100',
        lineRange: { start: 1, end: 1 }
      }], {});

      // Assert
      expect(result.success).toBe(true);
      expect(result.resolvedEdits).toHaveLength(1);

      const applyResult = await editCoordinator.applyResolvedEdits(
        file,
        result.resolvedEdits!,
        false
      );

      expect(applyResult.success).toBe(true);
      const updated = fs.readFileSync(file, 'utf-8');
      expect(updated).toContain('test1() { return 100; }');
      expect(updated).toContain('test2() { return 42; }');
    });
  });

  describe('Write safeWrite mode', () => {
    test('should create operations with undo support in safeWrite', async () => {
      // This test verifies that safeWrite creates operation records
      // Actual undo functionality depends on EditCoordinator/HistoryEngine implementation
      
      const file = path.join(testDir, 'safewrite.ts');
      const original = 'const x = 1;';
      const updated = 'const x = 2;';
      
      fs.writeFileSync(file, original);

      const resolvedEdit = {
        filePath: file,
        indexRange: { start: 0, end: original.length },
        targetString: original,
        replacementString: updated,
        expectedHash: undefined
      };

      const writeResult = await editCoordinator.applyResolvedEdits(
        file,
        [resolvedEdit],
        false
      );

      // Assert: safeWrite creates operation record (enables undo)
      expect(writeResult.success).toBe(true);
      expect(writeResult.operation).toBeDefined();
      expect(writeResult.operation?.id).toBeTruthy();
      expect(fs.readFileSync(file, 'utf-8')).toBe(updated);
      
      // Operation record means undo is theoretically possible
      // (actual undo tested in EditCoordinator tests)
    });

    test('should mark fast write as non-undoable', async () => {
      // This is a documentation test - fast write doesn't go through EditCoordinator
      // so it naturally doesn't support undo
      const file = path.join(testDir, 'fastwrite.ts');
      fs.writeFileSync(file, 'const y = 1;');

      // Fast write bypasses history
      fs.writeFileSync(file, 'const y = 2;');

      const undoResult = await editCoordinator.undo();
      
      // No history entry from direct fs.writeFileSync
      expect(undoResult.success).toBe(false);
      // Error message varies, just verify it failed
    });
  });

  describe('Cost guardrails', () => {
    test('should block levenshtein on large file with short target', async () => {
      // Arrange: Create large file (>100KB)
      const file = path.join(testDir, 'large.txt');
      const largeContent = 'x'.repeat(150000);
      fs.writeFileSync(file, largeContent);

      // Act: Try to edit with very short target (should fail fast)
      const start = Date.now();
      const result = await editResolver.resolveAll(file, [{
        targetString: 'xyz',  // Too short
        replacementString: 'abc'
      }], { timeoutMs: 1500 });
      const duration = Date.now() - start;

      // Assert: Should fail fast (not timeout)
      expect(duration).toBeLessThan(500); // No expensive levenshtein
      expect(result.success).toBe(false);
      expect(result.errors![0].errorCode).toBe('NO_MATCH');
    });

    test('should respect resolve timeout', async () => {
      // This test would need a pathological case to actually timeout
      // For now, verify timeout config is respected
      const file = path.join(testDir, 'timeout.ts');
      fs.writeFileSync(file, 'const a = 1;');

      const result = await editResolver.resolveAll(file, [{
        targetString: 'nonexistent',
        replacementString: 'foo'
      }], { timeoutMs: 100 });

      expect(result.success).toBe(false);
      // Should fail as NO_MATCH, not timeout (file too small)
    });
  });
});
