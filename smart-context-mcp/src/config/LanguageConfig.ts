import * as fs from "fs";
import * as path from "path";

export interface LanguageMapping {
    languageId: string;
    parserBackend: "web-tree-sitter" | "ts-compiler";
    wasmPath?: string;
}

export interface LanguageConfig {
    version: number;
    mappings: Record<string, LanguageMapping>;
}

export const BUILTIN_LANGUAGE_MAPPINGS: Record<string, LanguageMapping> = {
    ".ts": { languageId: "typescript", parserBackend: "web-tree-sitter" },
    ".mts": { languageId: "typescript", parserBackend: "web-tree-sitter" },
    ".cts": { languageId: "typescript", parserBackend: "web-tree-sitter" },
    ".tsx": { languageId: "tsx", parserBackend: "web-tree-sitter" },
    ".js": { languageId: "tsx", parserBackend: "web-tree-sitter" },
    ".jsx": { languageId: "tsx", parserBackend: "web-tree-sitter" },
    ".mjs": { languageId: "tsx", parserBackend: "web-tree-sitter" },
    ".cjs": { languageId: "tsx", parserBackend: "web-tree-sitter" },
    ".py": { languageId: "python", parserBackend: "web-tree-sitter" },
    ".go": { languageId: "go", parserBackend: "web-tree-sitter" },
    ".rs": { languageId: "rust", parserBackend: "web-tree-sitter" },
    ".java": { languageId: "java", parserBackend: "web-tree-sitter" },
    ".c": { languageId: "c", parserBackend: "web-tree-sitter" },
    ".cpp": { languageId: "cpp", parserBackend: "web-tree-sitter" },
    ".json": { languageId: "json", parserBackend: "web-tree-sitter" },
    ".yaml": { languageId: "yaml", parserBackend: "web-tree-sitter" },
    ".yml": { languageId: "yaml", parserBackend: "web-tree-sitter" },
    ".md": { languageId: "markdown", parserBackend: "web-tree-sitter" },
    ".css": { languageId: "css", parserBackend: "web-tree-sitter" },
    ".scss": { languageId: "scss", parserBackend: "web-tree-sitter" }
};

export class LanguageConfigLoader {
    private config: LanguageConfig;
    private watcher?: fs.FSWatcher;
    private readonly configPath: string;

    constructor(private readonly rootPath: string) {
        this.configPath = this.resolveConfigPath();
        this.config = this.loadConfig();
    }

    public getLanguageMapping(ext: string): LanguageMapping | undefined {
        const normalized = ext.toLowerCase();
        return this.config.mappings[normalized];
    }

    public reload(): void {
        this.config = this.loadConfig();
    }

    public watch(onChange: () => void): void {
        if (this.watcher) {
            return;
        }
        try {
            this.watcher = fs.watch(this.configPath, { persistent: false }, (event) => {
                if (event === "change" || event === "rename") {
                    this.reload();
                    onChange();
                }
            });
        } catch {
            // File might not exist yet; no-op
        }
    }

    public dispose(): void {
        this.watcher?.close();
        this.watcher = undefined;
    }

    private resolveConfigPath(): string {
        const primaryDir = path.join(this.rootPath, ".mcp", "smart-context");
        const primary = path.join(primaryDir, "languages.json");
        const legacy = path.join(this.rootPath, ".smart-context", "languages.json");

        if (fs.existsSync(primary)) {
            return primary;
        }
        if (fs.existsSync(legacy)) {
            return legacy;
        }
        return primary;
    }

    private loadConfig(): LanguageConfig {
        let userConfig: Partial<LanguageConfig> | undefined;
        try {
            if (fs.existsSync(this.configPath)) {
                const raw = fs.readFileSync(this.configPath, "utf-8");
                userConfig = JSON.parse(raw);
            }
        } catch (error) {
            console.warn(`[LanguageConfig] Failed to parse ${this.configPath}:`, error);
        }

        return {
            version: userConfig?.version ?? 1,
            mappings: { ...BUILTIN_LANGUAGE_MAPPINGS, ...(userConfig?.mappings ?? {}) }
        };
    }
}
