import * as fs from "fs";
import * as path from "path";
import { promisify } from "util";
import { EditOperation, HistoryItem } from "../types.js";

const readFileAsync = promisify(fs.readFile);
const writeFileAsync = promisify(fs.writeFile);

interface HistoryState {
    undoStack: HistoryItem[];
    redoStack: HistoryItem[];
}

export class HistoryEngine {
    private rootPath: string;
    private historyFilePath: string;

    constructor(rootPath: string) {
        this.rootPath = rootPath;
        this.historyFilePath = path.join(rootPath, ".mcp", "history.json");
    }

    private async readHistory(): Promise<HistoryState> {
        if (!fs.existsSync(this.historyFilePath)) {
            return { undoStack: [], redoStack: [] };
        }

        try {
            const content = await readFileAsync(this.historyFilePath, "utf-8");
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
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        const json = JSON.stringify(state, null, 2);
        await writeFileAsync(this.historyFilePath, json, "utf-8");
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
