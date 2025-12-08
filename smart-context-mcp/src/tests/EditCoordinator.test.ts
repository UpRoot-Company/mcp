import { EditCoordinator } from "../engine/EditCoordinator.js";
import { EditorEngine } from "../engine/Editor.js";
import { HistoryEngine } from "../engine/History.js";
import { BatchOperation, Edit, EditOperation, EditResult } from "../types.js";
import * as path from "path";

describe("EditCoordinator", () => {
  let mockEditorEngine: { applyEdits: jest.Mock } & Partial<EditorEngine>;
  let mockHistoryEngine: {
    pushOperation: jest.Mock;
    undo: jest.Mock;
    redo: jest.Mock;
  } & Partial<HistoryEngine>;
  const rootPath = "/project/root";

  let coordinator: EditCoordinator;

  beforeEach(() => {
    mockEditorEngine = {
      applyEdits: jest.fn(),
    } as any;

    mockHistoryEngine = {
      pushOperation: jest.fn(),
      undo: jest.fn(),
      redo: jest.fn(),
    } as any;

    coordinator = new EditCoordinator(
      mockEditorEngine as unknown as EditorEngine,
      mockHistoryEngine as unknown as HistoryEngine,
      rootPath
    );
  });

  describe("applyEdits", () => {
    const filePath = "/path/to/file.txt";
    const edits: Edit[] = [
      {
        targetString: "old",
        replacementString: "new",
      },
    ];

    it("should call editorEngine.applyEdits", async () => {
      const result: EditResult = { success: true };
      mockEditorEngine.applyEdits.mockResolvedValue(result);

      const output = await coordinator.applyEdits(filePath, edits, false);

      expect(mockEditorEngine.applyEdits).toHaveBeenCalledWith(
        filePath,
        edits,
        false
      );
      expect(output).toBe(result);
    });

    it("should call historyEngine.pushOperation if success and not dryRun", async () => {
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

      await coordinator.applyEdits(filePath, edits, false);

      expect(mockHistoryEngine.pushOperation).toHaveBeenCalledTimes(1);
      expect(mockHistoryEngine.pushOperation).toHaveBeenCalledWith(operation);
    });

    it("should NOT call historyEngine.pushOperation if editorEngine.applyEdits fails", async () => {
      const result: EditResult = {
        success: false,
        message: "failed",
      };

      mockEditorEngine.applyEdits.mockResolvedValue(result);

      await coordinator.applyEdits(filePath, edits, false);

      expect(mockHistoryEngine.pushOperation).not.toHaveBeenCalled();
    });

    it("should NOT call historyEngine.pushOperation on dryRun even if successful", async () => {
      const operation: EditOperation = {
        id: "op-2",
        timestamp: Date.now(),
        description: "dry run operation",
        edits: [],
        inverseEdits: [],
        filePath: "relative/path.txt",
      };

      const result: EditResult = {
        success: true,
        operation,
      };

      mockEditorEngine.applyEdits.mockResolvedValue(result);

      await coordinator.applyEdits(filePath, edits, true);

      expect(mockHistoryEngine.pushOperation).not.toHaveBeenCalled();
    });
  });

  describe("applyBatchEdits", () => {
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

    it("dryRun: should verify all edits and return success if all pass", async () => {
      const successResult: EditResult = { success: true };
      mockEditorEngine.applyEdits.mockResolvedValue(successResult);

      const result = await coordinator.applyBatchEdits(fileEdits, true);

      expect(mockEditorEngine.applyEdits).toHaveBeenCalledTimes(
        fileEdits.length
      );
      for (const { filePath, edits } of fileEdits) {
        expect(mockEditorEngine.applyEdits).toHaveBeenCalledWith(
          filePath,
          edits,
          true
        );
      }
      expect(result.success).toBe(true);
    });

    it("dryRun: should return error if any edit fails", async () => {
      const successResult: EditResult = { success: true };
      const failedResult: EditResult = {
        success: false,
        message: "validation failed",
      };

      mockEditorEngine.applyEdits
        .mockResolvedValueOnce(successResult)
        .mockResolvedValueOnce(failedResult);

      const result = await coordinator.applyBatchEdits(fileEdits, true);

      expect(mockEditorEngine.applyEdits).toHaveBeenNthCalledWith(
        1,
        fileEdits[0].filePath,
        fileEdits[0].edits,
        true
      );
      expect(mockEditorEngine.applyEdits).toHaveBeenNthCalledWith(
        2,
        fileEdits[1].filePath,
        fileEdits[1].edits,
        true
      );

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe("BatchDryRunFailed");
      expect(result.message).toContain(fileEdits[1].filePath);
    });

    it("!dryRun: should apply edits one by one and push BatchOperation to history on success", async () => {
      const operation1: EditOperation = {
        id: "op-1",
        timestamp: Date.now(),
        description: "file1 operation",
        edits: fileEdits[0].edits,
        inverseEdits: [],
        filePath: "relative/file1.txt",
      };
      const operation2: EditOperation = {
        id: "op-2",
        timestamp: Date.now(),
        description: "file2 operation",
        edits: fileEdits[1].edits,
        inverseEdits: [],
        filePath: "relative/file2.txt",
      };

      mockEditorEngine.applyEdits
        .mockResolvedValueOnce({ success: true, operation: operation1 })
        .mockResolvedValueOnce({ success: true, operation: operation2 });

      const result = await coordinator.applyBatchEdits(fileEdits, false);

      expect(mockEditorEngine.applyEdits).toHaveBeenNthCalledWith(
        1,
        fileEdits[0].filePath,
        fileEdits[0].edits,
        false
      );
      expect(mockEditorEngine.applyEdits).toHaveBeenNthCalledWith(
        2,
        fileEdits[1].filePath,
        fileEdits[1].edits,
        false
      );

      expect(mockHistoryEngine.pushOperation).toHaveBeenCalledTimes(1);
      const batch = mockHistoryEngine
        .pushOperation.mock.calls[0][0] as BatchOperation;

      expect(batch.operations).toEqual([operation1, operation2]);
      expect(result.success).toBe(true);
    });

    it("!dryRun: should rollback if an edit fails", async () => {
      const extendedFileEdits = [
        ...fileEdits,
        {
          filePath: "/path/to/file3.txt",
          edits: [
            {
              targetString: "old3",
              replacementString: "new3",
            },
          ] as Edit[],
        },
      ];

      const operation1: EditOperation = {
        id: "op-1",
        timestamp: Date.now(),
        description: "file1 operation",
        edits: extendedFileEdits[0].edits,
        inverseEdits: [
          {
            targetString: "new1",
            replacementString: "old1",
          },
        ],
        filePath: "relative/file1.txt",
      };

      const operation2: EditOperation = {
        id: "op-2",
        timestamp: Date.now(),
        description: "file2 operation",
        edits: extendedFileEdits[1].edits,
        inverseEdits: [
          {
            targetString: "new2",
            replacementString: "old2",
          },
        ],
        filePath: "relative/file2.txt",
      };

      mockEditorEngine.applyEdits.mockResolvedValue({ success: true });
      mockEditorEngine.applyEdits
        .mockResolvedValueOnce({ success: true, operation: operation1 })
        .mockResolvedValueOnce({ success: true, operation: operation2 })
        .mockResolvedValueOnce({
          success: false,
          message: "apply failed on third file",
        });

      const result = await coordinator.applyBatchEdits(
        extendedFileEdits,
        false
      );

      expect(mockEditorEngine.applyEdits).toHaveBeenNthCalledWith(
        1,
        extendedFileEdits[0].filePath,
        extendedFileEdits[0].edits,
        false
      );
      expect(mockEditorEngine.applyEdits).toHaveBeenNthCalledWith(
        2,
        extendedFileEdits[1].filePath,
        extendedFileEdits[1].edits,
        false
      );
      expect(mockEditorEngine.applyEdits).toHaveBeenNthCalledWith(
        3,
        extendedFileEdits[2].filePath,
        extendedFileEdits[2].edits,
        false
      );

      expect(mockEditorEngine.applyEdits).toHaveBeenNthCalledWith(
        4,
        extendedFileEdits[1].filePath,
        operation2.inverseEdits,
        false
      );
      expect(mockEditorEngine.applyEdits).toHaveBeenNthCalledWith(
        5,
        extendedFileEdits[0].filePath,
        operation1.inverseEdits,
        false
      );

      expect(mockHistoryEngine.pushOperation).not.toHaveBeenCalled();
      expect(result.success).toBe(false);
      expect(result.errorCode).toBe("BatchApplyFailed");
      expect(result.message).toContain(extendedFileEdits[2].filePath);
    });
  });

  describe("undo", () => {
    it("should call historyEngine.undo", async () => {
      const op: EditOperation = {
        id: "undo-op",
        timestamp: Date.now(),
        description: "undo operation",
        edits: [],
        inverseEdits: [],
        filePath: "relative/file.txt",
      };

      mockHistoryEngine.undo.mockResolvedValue(op);
      mockEditorEngine.applyEdits.mockResolvedValue({ success: true });

      await coordinator.undo();

      expect(mockHistoryEngine.undo).toHaveBeenCalledTimes(1);
    });

    it("should call editorEngine.applyEdits with inverseEdits and resolved path when undo returns an operation", async () => {
      const relativePath = "src/file.ts";
      const op: EditOperation = {
        id: "undo-op-2",
        timestamp: Date.now(),
        description: "undo operation 2",
        edits: [],
        inverseEdits: [
          {
            targetString: "new",
            replacementString: "old",
          },
        ],
        filePath: relativePath,
      };

      mockHistoryEngine.undo.mockResolvedValue(op);

      const applyResult: EditResult = { success: true };
      mockEditorEngine.applyEdits.mockResolvedValue(applyResult);

      const result = await coordinator.undo();

      const expectedPath = path.join(rootPath, relativePath);
      expect(mockEditorEngine.applyEdits).toHaveBeenCalledWith(
        expectedPath,
        op.inverseEdits,
        false
      );
      expect(result).toBe(applyResult);
    });

    it("should return error if there is no undo history", async () => {
      mockHistoryEngine.undo.mockResolvedValue(null);

      const result = await coordinator.undo();

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe("NoUndoHistory");
      expect(mockEditorEngine.applyEdits).not.toHaveBeenCalled();
    });
  });

  describe("redo", () => {
    it("should call historyEngine.redo", async () => {
      const op: EditOperation = {
        id: "redo-op",
        timestamp: Date.now(),
        description: "redo operation",
        edits: [],
        inverseEdits: [],
        filePath: "relative/file.txt",
      };

      mockHistoryEngine.redo.mockResolvedValue(op);
      mockEditorEngine.applyEdits.mockResolvedValue({ success: true });

      await coordinator.redo();

      expect(mockHistoryEngine.redo).toHaveBeenCalledTimes(1);
    });

    it("should call editorEngine.applyEdits with edits and resolved path when redo returns an operation", async () => {
      const relativePath = "src/file.ts";
      const op: EditOperation = {
        id: "redo-op-2",
        timestamp: Date.now(),
        description: "redo operation 2",
        edits: [
          {
            targetString: "old",
            replacementString: "new",
          },
        ],
        inverseEdits: [],
        filePath: relativePath,
      };

      mockHistoryEngine.redo.mockResolvedValue(op);

      const applyResult: EditResult = { success: true };
      mockEditorEngine.applyEdits.mockResolvedValue(applyResult);

      const result = await coordinator.redo();

      const expectedPath = path.join(rootPath, relativePath);
      expect(mockEditorEngine.applyEdits).toHaveBeenCalledWith(
        expectedPath,
        op.edits,
        false
      );
      expect(result).toBe(applyResult);
    });

    it("should return error if there is no redo history", async () => {
      mockHistoryEngine.redo.mockResolvedValue(null);

      const result = await coordinator.redo();

      expect(result.success).toBe(false);
      expect(result.errorCode).toBe("NoRedoHistory");
      expect(mockEditorEngine.applyEdits).not.toHaveBeenCalled();
    });
  });
});
