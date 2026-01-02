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

    // ADR-042-005: Phase A4 - ENV Configuration Getters
    public static get(key: string, defaultValue?: any): any {
        const envValue = process.env[key];
        if (envValue === undefined) {
            return defaultValue;
        }
        // Boolean conversion
        if (defaultValue === true || defaultValue === false) {
            return envValue === 'true';
        }
        // Number conversion
        if (typeof defaultValue === 'number') {
            const parsed = Number(envValue);
            return isNaN(parsed) ? defaultValue : parsed;
        }
        // String or other types
        return envValue;
    }

    public static getEditorV2Enabled(): boolean {
        return ConfigurationManager.get('SMART_CONTEXT_EDITOR_V2', false);
    }

    public static getEditorV2Mode(): 'off' | 'dryrun' | 'apply' {
        const mode = ConfigurationManager.get('SMART_CONTEXT_EDITOR_V2_MODE', 'off');
        if (mode === 'dryrun' || mode === 'apply') {
            return mode;
        }
        return 'off';
    }

    public static getResolveTimeoutMs(): number {
        return ConfigurationManager.get('SMART_CONTEXT_EDITOR_RESOLVE_TIMEOUT_MS', 1500);
    }

    public static getMinLevenshteinTargetLen(): number {
        return ConfigurationManager.get('SMART_CONTEXT_CHANGE_MIN_LEVENSHTEIN_TARGET_LEN', 20);
    }

    public static getMaxLevenshteinFileBytes(): number {
        return ConfigurationManager.get('SMART_CONTEXT_CHANGE_MAX_LEVENSHTEIN_FILE_BYTES', 100000);
    }

    public static getAllowAmbiguousAutoPick(): boolean {
        // v2 모드에서는 기본적으로 false
        const v2Enabled = ConfigurationManager.getEditorV2Enabled();
        const v2Mode = ConfigurationManager.getEditorV2Mode();
        if (v2Enabled && v2Mode !== 'off') {
            return ConfigurationManager.get('SMART_CONTEXT_EDITOR_ALLOW_AMBIGUOUS_AUTOPICK', false);
        }
        // v1 모드에서는 기본적으로 true
        return ConfigurationManager.get('SMART_CONTEXT_EDITOR_ALLOW_AMBIGUOUS_AUTOPICK', true);
    }
}
