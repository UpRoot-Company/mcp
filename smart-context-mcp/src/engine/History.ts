import * as path from "path";
import { HistoryItem } from "../types.js";
import { IFileSystem } from "../platform/FileSystem.js";

interface HistoryState {
    undoStack: HistoryItem[];
    redoStack: HistoryItem[];
}

export class HistoryEngine {

    private historyFilePath: string;
    private readonly fileSystem: IFileSystem;

    constructor(rootPath: string, fileSystem: IFileSystem) {

        this.historyFilePath = path.join(rootPath, ".mcp", "history.json");
        this.fileSystem = fileSystem;
    }

    private async readHistory(): Promise<HistoryState> {
        if (!(await this.fileSystem.exists(this.historyFilePath))) {
            return { undoStack: [], redoStack: [] };
        }

        try {
            const content = await this.fileSystem.readFile(this.historyFilePath);
            const parsed = JSON.parse(content);
            return {
                undoStack: Array.isArray(parsed.undoStack) ? parsed.undoStack : [],
                redoStack: Array.isArray(parsed.redoStack) ? parsed.redoStack : [],
            };
        } catch {
            return { undoStack: [], redoStack: [] };
        }
    }

    private async writeHistory(state: HistoryState): Promise<void> {
        const dir = path.dirname(this.historyFilePath);
        if (!(await this.fileSystem.exists(dir))) {
            await this.fileSystem.createDir(dir);
        }

        const json = JSON.stringify(state, null, 2);
        const tempPath = `${this.historyFilePath}.tmp`;
        await this.fileSystem.writeFile(tempPath, json);
        await this.fileSystem.rename(tempPath, this.historyFilePath);
    }

    public async pushOperation(op: HistoryItem): Promise<void> {
        const history = await this.readHistory();

        history.undoStack.push(op);
        if (history.undoStack.length > 50) {
            history.undoStack = history.undoStack.slice(-50);
        }

        history.redoStack = [];
        await this.writeHistory(history);
    }

    public async replaceOperation(id: string, op: HistoryItem): Promise<void> {
        const history = await this.readHistory();
        const index = history.undoStack.findIndex(item => (item as any).id === id);
        if (index === -1) {
            history.undoStack.push(op);
        } else {
            history.undoStack[index] = op;
        }
        history.redoStack = [];
        await this.writeHistory(history);
    }

    public async removeOperation(id: string): Promise<void> {
        const history = await this.readHistory();
        history.undoStack = history.undoStack.filter(item => (item as any).id !== id);
        history.redoStack = history.redoStack.filter(item => (item as any).id !== id);
        await this.writeHistory(history);
    }

    public async undo(): Promise<HistoryItem | null> {
        const history = await this.readHistory();

        if (history.undoStack.length === 0) {
            return null;
        }

        const op = history.undoStack.pop()!;
        history.redoStack.push(op);
        await this.writeHistory(history);

        return op;
    }

    public async redo(): Promise<HistoryItem | null> {
        const history = await this.readHistory();

        if (history.redoStack.length === 0) {
            return null;
        }

        const op = history.redoStack.pop()!;
        history.undoStack.push(op);
        await this.writeHistory(history);

        return op;
    }

    public async getHistory(): Promise<HistoryState> {
        return this.readHistory();
    }

    public async reset(): Promise<void> {
        const emptyState: HistoryState = { undoStack: [], redoStack: [] };
        await this.writeHistory(emptyState);
    }
}
