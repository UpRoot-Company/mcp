// src/tests/HistoryEngine.test.ts
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { HistoryEngine } from "../engine/History.js";
import { NodeFileSystem } from "../platform/FileSystem.js";

describe("HistoryEngine", () => {
  let tempDir: string;
  let engine: HistoryEngine;
  let historyFilePath: string;

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "history-engine-test-"));
    engine = new HistoryEngine(tempDir, new NodeFileSystem(tempDir));
    historyFilePath = path.join(tempDir, ".mcp", "history.json");
  });

  beforeEach(async () => {
    // Ensure a clean history state before each test
    await engine.reset();
    if (fs.existsSync(historyFilePath)) {
      fs.rmSync(historyFilePath, { recursive: true, force: true });
    }
  });

  afterAll(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("persists data to the history file when pushing operations", async () => {
    const op = createOperation("first");

    await engine.pushOperation(op);

    expect(fs.existsSync(historyFilePath)).toBe(true);
    const content = fs.readFileSync(historyFilePath, "utf-8");
    const parsed = JSON.parse(content);

    expect(Array.isArray(parsed.undoStack)).toBe(true);
    expect(parsed.undoStack).toHaveLength(1);
    expect(parsed.undoStack[0].id).toBe(op.id);
    expect(Array.isArray(parsed.redoStack)).toBe(true);
    expect(parsed.redoStack).toHaveLength(0);
  });

  it("undo retrieves the last operation and moves it to the redo stack", async () => {
    const op1 = createOperation("first");
    const op2 = createOperation("second");

    await engine.pushOperation(op1);
    await engine.pushOperation(op2);

    const undone = await engine.undo();

    expect(undone).not.toBeNull();
    expect(undone!.id).toBe(op2.id);

    const history = await engine.getHistory();
    expect(history.undoStack.map((o: any) => o.id)).toEqual([op1.id]);
    expect(history.redoStack.map((o: any) => o.id)).toEqual([op2.id]);
  });

  it("redo retrieves from the redo stack and moves it back to the undo stack", async () => {
    const op1 = createOperation("first");
    const op2 = createOperation("second");

    await engine.pushOperation(op1);
    await engine.pushOperation(op2);

    const undone = await engine.undo();
    expect(undone).not.toBeNull();
    expect(undone!.id).toBe(op2.id);

    const redone = await engine.redo();
    expect(redone).not.toBeNull();
    expect(redone!.id).toBe(op2.id);

    const history = await engine.getHistory();
    expect(history.undoStack.map((o: any) => o.id)).toEqual([op1.id, op2.id]);
    expect(history.redoStack).toHaveLength(0);
  });

  it("reset clears the redo stack (and undo stack)", async () => {
    const op1 = createOperation("first");
    const op2 = createOperation("second");

    await engine.pushOperation(op1);
    await engine.pushOperation(op2);

    // Move the last operation to the redo stack
    await engine.undo();
    let history = await engine.getHistory();
    expect(history.redoStack).toHaveLength(1);

    await engine.reset();
    history = await engine.getHistory();

    expect(history.undoStack).toHaveLength(0);
    expect(history.redoStack).toHaveLength(0);
  });

  it("enforces a history limit of 50 items on the undo stack", async () => {
    const operations = Array.from({ length: 60 }, (_, index) =>
      createOperation(`op-${index}`)
    );

    for (const op of operations) {
      await engine.pushOperation(op);
    }

    const history = await engine.getHistory();
    expect(history.undoStack).toHaveLength(50);

    // The oldest 10 operations should have been discarded
    const expectedIds = operations.slice(10).map((op) => op.id);
    const actualIds = history.undoStack.map((op: any) => op.id);
    expect(actualIds).toEqual(expectedIds);
  });
});

function createOperation(description: string) {
  const timestamp = Date.now();
  return {
    id: `${description}-${timestamp}-${Math.random()}`,
    timestamp,
    description,
    edits: [],
    inverseEdits: [],
  };
}