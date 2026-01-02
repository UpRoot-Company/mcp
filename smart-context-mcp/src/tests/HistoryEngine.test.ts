import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { HistoryEngine } from "../engine/History.js";
import { NodeFileSystem } from "../platform/FileSystem.js";
import { PathManager } from "../utils/PathManager.js";

describe("HistoryEngine", () => {
    let tempDir: string;
    let engine: HistoryEngine;
    let historyFilePath: string;

    beforeEach(async () => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "history-engine-test-"));
        PathManager.setRoot(tempDir);
        const fileSystem = new NodeFileSystem(tempDir);
        engine = new HistoryEngine(tempDir, fileSystem);
        historyFilePath = path.join(PathManager.getHistoryDir(), "history.json");
    });

    afterEach(() => {
        if (fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    it("should initialize with empty stacks", async () => {
        const history = await engine.getHistory();
        expect(history.undoStack).toEqual([]);
        expect(history.redoStack).toEqual([]);
    });

    it("persists data to the history file when pushing operations", async () => {
        const op = createOperation("first");
        await engine.pushOperation(op);
        expect(fs.existsSync(historyFilePath)).toBe(true);
        const content = fs.readFileSync(historyFilePath, "utf-8");
        const parsed = JSON.parse(content);
        expect(Array.isArray(parsed.undoStack)).toBe(true);
        expect(parsed.undoStack[0].description).toBe("first");
    });

    it("supports undo and redo operations", async () => {
        const op1 = createOperation("first");
        const op2 = createOperation("second");

        await engine.pushOperation(op1);
        await engine.pushOperation(op2);

        const undone = await engine.undo();
        expect(undone?.description).toBe("second");

        const history = await engine.getHistory();
        expect(history.undoStack).toHaveLength(1);
        expect(history.redoStack).toHaveLength(1);
        expect(history.undoStack[0].description).toBe("first");

        const redone = await engine.redo();
        expect(redone?.description).toBe("second");

        const historyAfterRedo = await engine.getHistory();
        expect(historyAfterRedo.undoStack).toHaveLength(2);
        expect(historyAfterRedo.redoStack).toHaveLength(0);
    });

    it("clears redo stack when pushing a new operation", async () => {
        const op1 = createOperation("first");
        const op2 = createOperation("second");
        const op3 = createOperation("third");

        await engine.pushOperation(op1);
        await engine.pushOperation(op2);
        await engine.undo();
        
        await engine.pushOperation(op3);
        const history = await engine.getHistory();
        expect(history.redoStack).toHaveLength(0);
        expect(history.undoStack).toHaveLength(2);
        expect(history.undoStack[1].description).toBe("third");
    });

    it("limits the undo stack size to 50 operations", async () => {
        const operations = Array.from({ length: 60 }, (_, index) =>
            createOperation(`op-${index}`)
        );

        for (const op of operations) {
            await engine.pushOperation(op);
        }

        const history = await engine.getHistory();
        expect(history.undoStack).toHaveLength(50);
        
        const expectedIds = operations.slice(10).map((op) => op.id);
        const actualIds = history.undoStack.map((op: any) => op.id);
        expect(actualIds).toEqual(expectedIds);
    }, 15000);
});

function createOperation(description: string) {
    const timestamp = Date.now();
    return {
        id: `op-${timestamp}-${Math.random()}`,
        timestamp,
        description,
        edits: [],
        inverseEdits: [],
    };
}
