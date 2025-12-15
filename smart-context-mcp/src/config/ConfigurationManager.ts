import chokidar from "chokidar";
import { EventEmitter } from "events";
import * as fs from "fs";
import * as path from "path";

export type ConfigurationEvent =
    | "ignoreChanged"
    | "tsconfigChanged"
    | "jsconfigChanged"
    | "packageJsonChanged";

export interface ConfigurationEventPayloads {
    ignoreChanged: { filePath: string; patterns: string[] };
    tsconfigChanged: { filePath: string };
    jsconfigChanged: { filePath: string };
    packageJsonChanged: { filePath: string };
}

const WATCH_FILES = [
    ".gitignore",
    ".mcpignore",
    "tsconfig.json",
    "jsconfig.json",
    "package.json"
];

export class ConfigurationManager extends EventEmitter {
    private readonly watcher: chokidar.FSWatcher;
    private ignorePatterns: string[];

    constructor(private readonly rootPath: string) {
        super();
        this.ignorePatterns = this.loadIgnorePatterns();
        const watchTargets = WATCH_FILES.map(file => path.join(this.rootPath, file));
        this.watcher = chokidar.watch(watchTargets, {
            ignoreInitial: true,
            persistent: true,
            awaitWriteFinish: {
                stabilityThreshold: 200,
                pollInterval: 100
            }
        });
        this.registerWatchHandlers();
    }

    public getIgnoreGlobs(): string[] {
        return [...this.ignorePatterns];
    }

    public on<T extends ConfigurationEvent>(event: T, listener: (payload: ConfigurationEventPayloads[T]) => void): this {
        return super.on(event, listener);
    }

    public off<T extends ConfigurationEvent>(event: T, listener: (payload: ConfigurationEventPayloads[T]) => void): this {
        return super.off(event, listener);
    }

    public async dispose(): Promise<void> {
        await this.watcher.close();
        this.removeAllListeners();
    }

    private registerWatchHandlers(): void {
        const handler = (filePath: string) => this.handleConfigChange(filePath);
        this.watcher.on("add", handler);
        this.watcher.on("change", handler);
        this.watcher.on("unlink", handler);
        this.watcher.on("error", error => {
            console.warn("[ConfigurationManager] watcher error", error);
        });
    }

    private handleConfigChange(filePath: string): void {
        const basename = path.basename(filePath);
        switch (basename) {
            case ".gitignore":
            case ".mcpignore": {
                this.ignorePatterns = this.loadIgnorePatterns();
                this.emit("ignoreChanged", {
                    filePath,
                    patterns: [...this.ignorePatterns]
                });
                break;
            }
            case "tsconfig.json": {
                this.emit("tsconfigChanged", { filePath });
                break;
            }
            case "jsconfig.json": {
                this.emit("jsconfigChanged", { filePath });
                break;
            }
            case "package.json": {
                this.emit("packageJsonChanged", { filePath });
                break;
            }
            default:
                break;
        }
    }

    private loadIgnorePatterns(): string[] {
        const patterns: string[] = [];
        for (const file of [".gitignore", ".mcpignore"]) {
            const absPath = path.join(this.rootPath, file);
            if (!fs.existsSync(absPath)) {
                continue;
            }
            try {
                const content = fs.readFileSync(absPath, "utf-8");
                const parsed = content
                    .split(/\r?\n/)
                    .map(line => line.trim())
                    .filter(line => line.length > 0 && !line.startsWith("#"));
                patterns.push(...parsed);
            } catch (error) {
                console.warn(`[ConfigurationManager] Failed to read ${file}:`, error);
            }
        }
        return patterns;
    }
}
