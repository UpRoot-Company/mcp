import { jest, describe, it, beforeEach, expect } from '@jest/globals';
import { EditCoordinator } from "../engine/EditCoordinator.js";
import { EditorEngine } from "../engine/Editor.js";
import { HistoryEngine } from "../engine/History.js";
import { ImpactAnalyzer } from "../engine/ImpactAnalyzer.js";
import { BatchOperation, Edit, EditOperation, EditResult } from "../types.js";
import * as path from "path";

describe("EditCoordinator", () => {
  let mockEditorEngine: { applyEdits: ReturnType<typeof jest.fn> } & Partial<EditorEngine>;
  let mockHistoryEngine: {
    pushOperation: ReturnType<typeof jest.fn>;
    replaceOperation: ReturnType<typeof jest.fn>;
    removeOperation: ReturnType<typeof jest.fn>;
    undo: ReturnType<typeof jest.fn>;
    redo: ReturnType<typeof jest.fn>;
  } & Partial<HistoryEngine>;
  let mockImpactAnalyzer: { analyzeImpact: ReturnType<typeof jest.fn> } & Partial<ImpactAnalyzer>;
  const rootPath = "/project/root";

  let coordinator: EditCoordinator;

  beforeEach(() => {
    mockEditorEngine = {
      applyEdits: jest.fn<any>().mockResolvedValue({ success: true }),
    };
    mockHistoryEngine = {
      pushOperation: jest.fn<any>().mockResolvedValue(undefined),
      replaceOperation: jest.fn<any>().mockResolvedValue(undefined),
      removeOperation: jest.fn<any>().mockResolvedValue(undefined),
      undo: jest.fn<any>(),
      redo: jest.fn<any>(),
    };
    mockImpactAnalyzer = {
      analyzeImpact: jest.fn<any>().mockResolvedValue({
        filePath: 'src/file.ts',
        riskLevel: 'medium',
        summary: { incomingCount: 1, outgoingCount: 1, impactedFiles: [] },
        editCount: 1
      })
    };

    coordinator = new EditCoordinator(
      mockEditorEngine as unknown as EditorEngine,
      mockHistoryEngine as unknown as HistoryEngine,
      {
        rootPath,
        transactionLog: {
            begin: jest.fn<any>(),
            commit: jest.fn<any>(),
            rollback: jest.fn<any>()
        } as any,
        fileSystem: {
            readFile: jest.fn<any>().mockResolvedValue("content"),
            writeFile: jest.fn<any>().mockResolvedValue(undefined)
        } as any,
        impactAnalyzer: mockImpactAnalyzer as unknown as ImpactAnalyzer
      }
    );
  });

  const filePath = "/path/to/file.txt";
  const edits: Edit[] = [
    {
      targetString: "old",
      replacementString: "new",
    },
  ];

  it("applyEdits: should call editorEngine and record history", async () => {
    const operation: EditOperation = {
      id: "op-1",
      timestamp: Date.now(),
      description: "test operation",
      edits: [],
      inverseEdits: [],
      filePath: "relative/path.txt",
    };
    const result: EditResult = {
      success: true,
      message: "ok",
      operation,
    };
    mockEditorEngine.applyEdits.mockResolvedValue(result);

    const output = await coordinator.applyEdits(filePath, edits, false);

    expect(mockEditorEngine.applyEdits).toHaveBeenCalledWith(filePath, edits, false);
    expect(mockHistoryEngine.pushOperation).toHaveBeenCalledWith(operation);
    expect(output).toBe(result);
  });

  it("applyEdits: should return impact preview on dryRun", async () => {
    const result: EditResult = { success: true };
    mockEditorEngine.applyEdits.mockResolvedValue(result);

    const output = await coordinator.applyEdits(filePath, edits, true);

    expect(output.success).toBe(true);
    expect(output.impactPreview).toBeDefined();
    expect(mockImpactAnalyzer.analyzeImpact).toHaveBeenCalled();
  });

  const fileEdits = [
    {
      filePath: "/path/to/file1.txt",
      edits: [
        {
          targetString: "old1",
          replacementString: "new1",
        },
      ] as Edit[],
    },
    {
      filePath: "/path/to/file2.txt",
      edits: [
        {
          targetString: "old2",
          replacementString: "new2",
        },
      ] as Edit[],
    },
  ];

  it("applyBatchEdits (dryRun): should include impact previews", async () => {
    mockEditorEngine.applyEdits.mockResolvedValue({ success: true });

    const result = await coordinator.applyBatchEdits(fileEdits, true);

    expect(result.success).toBe(true);
    expect(result.impactPreviews).toHaveLength(2);
    expect(result.impactPreviews?.[0].riskLevel).toBe('medium');
  });

  it("undo: should handle batch operations", async () => {
    const batch: BatchOperation = {
        id: "batch-1",
        timestamp: Date.now(),
        description: "batch",
        operations: [
            { id: "1", filePath: "file1.ts", edits: [], inverseEdits: [], timestamp: 0, description: "" },
            { id: "2", filePath: "file2.ts", edits: [], inverseEdits: [], timestamp: 0, description: "" }
        ]
    };
    mockHistoryEngine.undo.mockResolvedValue(batch);
    mockEditorEngine.applyEdits.mockResolvedValue({ success: true });

    const result = await coordinator.undo();
    expect(result.success).toBe(true);
    expect(mockEditorEngine.applyEdits).toHaveBeenCalledTimes(2);
  });
});
