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
    "tsconfig.json",
    "jsconfig.json",
    "package.json"
];
const IGNORE_FILES = [".gitignore", ".mcpignore"];
const IGNORE_SCAN_EXCLUDES = new Set([
    ".git",
    "node_modules",
    ".mcp",
    ".smart-context",
    ".smart-context-index",
    "dist",
    "coverage"
]);

export class ConfigurationManager extends EventEmitter {
    private readonly watcher?: chokidar.FSWatcher;
    private ignorePatterns: string[];

    constructor(private readonly rootPath: string) {
        super();
        this.ignorePatterns = this.loadIgnorePatterns();
        
        const isTestEnv = process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined;
        if (!isTestEnv) {
            const ignoreTargets = this.collectIgnoreFiles();
            const watchTargets = [
                ...WATCH_FILES.map(file => path.join(this.rootPath, file)),
                ...ignoreTargets
            ];
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
        if (this.watcher) {
            await this.watcher.close();
        }
        this.removeAllListeners();
    }

    private registerWatchHandlers(): void {
        if (!this.watcher) return;
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
        const ignoreFiles = this.collectIgnoreFiles();
        for (const absPath of ignoreFiles) {
            try {
                const content = fs.readFileSync(absPath, "utf-8");
                const relDir = path.relative(this.rootPath, path.dirname(absPath)).replace(/\\/g, "/");
                const parsed = content
                    .split(/\r?\n/)
                    .map(line => line.trim())
                    .filter(line => line.length > 0 && !line.startsWith("#"))
                    .map(line => this.normalizeIgnorePattern(line, relDir));
                patterns.push(...parsed);
            } catch (error) {
                console.warn(`[ConfigurationManager] Failed to read ${path.basename(absPath)}:`, error);
            }
        }
        return patterns;
    }

    private collectIgnoreFiles(): string[] {
        const ignoreFiles: string[] = [];
        const stack = [this.rootPath];
        while (stack.length > 0) {
            const current = stack.pop()!;
            let entries: fs.Dirent[] = [];
            try {
                entries = fs.readdirSync(current, { withFileTypes: true });
            } catch {
                continue;
            }
            for (const entry of entries) {
                if (entry.isSymbolicLink()) {
                    continue;
                }
                const entryPath = path.join(current, entry.name);
                if (entry.isDirectory()) {
                    if (IGNORE_SCAN_EXCLUDES.has(entry.name)) {
                        continue;
                    }
                    stack.push(entryPath);
                    continue;
                }
                if (IGNORE_FILES.includes(entry.name)) {
                    ignoreFiles.push(entryPath);
                }
            }
        }
        return ignoreFiles;
    }

    private normalizeIgnorePattern(pattern: string, relDir: string): string {
        if (!pattern) return pattern;
        let negation = "";
        let normalized = pattern;
        if (normalized.startsWith("!")) {
            negation = "!";
            normalized = normalized.slice(1);
        }
        if (normalized.startsWith("/")) {
            normalized = normalized.slice(1);
        }
        if (relDir && relDir.length > 0) {
            normalized = `${relDir}/${normalized}`;
        }
        return `${negation}${normalized}`;
    }
}
