import * as path from 'path';
import { AstBackend, AstDocument } from './AstBackend.js';
import { WebTreeSitterBackend } from './WebTreeSitterBackend.js';
import { JsAstBackend } from './JsAstBackend.js';
import { SnapshotBackend } from './SnapshotBackend.js';
import { EngineConfig } from '../types.js';

const EXT_TO_LANG: Record<string, string> = {
    '.ts': 'typescript',
    '.mts': 'typescript',
    '.cts': 'typescript',
    '.tsx': 'tsx',
    '.js': 'tsx',
    '.mjs': 'tsx',
    '.cjs': 'tsx',
    '.jsx': 'tsx',
    '.py': 'python',
    '.go': 'go',
    '.rs': 'rust',
    '.java': 'java',
    '.c': 'c',
    '.cpp': 'cpp',
    '.json': 'json',
    '.yaml': 'yaml',
    '.yml': 'yaml'
};

export class AstManager {
    private static instance: AstManager;
    private initialized = false;
    private backend: AstBackend;
    private engineConfig: EngineConfig;
    private activeBackend?: string;

    private constructor() {
        this.backend = new WebTreeSitterBackend();
        this.engineConfig = { mode: 'prod', parserBackend: 'auto' };
    }

    public static getInstance(): AstManager {
        if (!AstManager.instance) {
            AstManager.instance = new AstManager();
        }
        return AstManager.instance;
    }

    public static resetForTesting(): void {
        if (AstManager.instance) {
            AstManager.instance.initialized = false;
            AstManager.instance.backend = new WebTreeSitterBackend();
            AstManager.instance.engineConfig = { mode: 'prod', parserBackend: 'auto' };
            AstManager.instance.activeBackend = undefined;
        }
    }

    public async init(config?: EngineConfig): Promise<void> {
        const resolved = this.resolveConfig(config);
        this.engineConfig = resolved;

        if (this.initialized) {
            return;
        }

        await this.initializeBackend();
    }

    public async warmup(languages: string[] = ['tsx', 'python', 'json']): Promise<void> {
        // Backend specific warmup could be added to interface, for now assume initialized
        if (!this.initialized) await this.init();
    }

    public async parseFile(filePath: string, content: string): Promise<AstDocument> {
        if (!this.initialized) await this.init();
        return this.backend.parseFile(filePath, content);
    }

    public async getParserForFile(filePath: string): Promise<any> {
        if (!this.initialized) await this.init();
        let langName: string;
        try {
            langName = this.resolveLanguageId(filePath);
        } catch {
            return null;
        }
        if (typeof (this.backend as any).getParser === 'function') {
            try {
                return await (this.backend as any).getParser(langName);
            } catch (error) {
                console.warn(`Failed to retrieve parser for ${filePath}:`, error);
                return null;
            }
        }
        return null;
    }

    public async getLanguageForFile(filePath: string): Promise<any> {
        if (!this.initialized) await this.init();
        
        // This assumes backend can return a language object compatible with what caller needs (Query)
        // WebTreeSitterBackend returns a tree-sitter Language.
        // We need to map filePath to languageId.
        // WebTreeSitterBackend has this logic inside parseFile.
        // We need to expose it or duplicate it. 
        // Ideally AstBackend has 'identifyLanguage(filePath)'?
        // Or we just pass the extension/hint to getLanguage.
        
        const ext = path.extname(filePath).toLowerCase();
        // Duplicate map for now or move to shared? 
        // It's in WebTreeSitterBackend. 
        // Let's rely on standard extension mapping or ask backend.
        // For now, let's hardcode common ones or use a shared constant.
        // I'll stick to the one in WebTreeSitterBackend but I can't access it easily.
        // I'll just copy the map here for getLanguage resolution if needed, OR 
        // better: AstBackend should have getLanguageId(filePath).
        
        // For minimal changes:
        const langName = this.resolveLanguageId(filePath);
        return this.backend.getLanguage(langName);
    }

    public getLanguageId(filePath: string): string {
        return this.resolveLanguageId(filePath);
    }

    public getActiveBackend(): string | undefined {
        return this.activeBackend;
    }

    public supportsQueries(): boolean {
        return this.backend.capabilities.supportsQueries;
    }

    private resolveConfig(overrides?: EngineConfig): EngineConfig {
        const envMode = process.env.SMART_CONTEXT_ENGINE_MODE as EngineConfig['mode'] | undefined;
        const envBackend = process.env.SMART_CONTEXT_PARSER_BACKEND as EngineConfig['parserBackend'] | undefined;
        const envSnapshot = process.env.SMART_CONTEXT_SNAPSHOT_DIR;
        const envRoot = process.env.SMART_CONTEXT_ROOT_PATH || process.env.SMART_CONTEXT_ROOT;

        return {
            mode: overrides?.mode ?? envMode ?? this.engineConfig.mode ?? 'prod',
            parserBackend: overrides?.parserBackend ?? envBackend ?? this.engineConfig.parserBackend ?? 'auto',
            snapshotDir: overrides?.snapshotDir ?? envSnapshot ?? this.engineConfig.snapshotDir,
            rootPath: overrides?.rootPath ?? this.engineConfig.rootPath ?? envRoot ?? process.cwd()
        };
    }

    private getBackendPriority(): Array<NonNullable<EngineConfig['parserBackend']>> {
        const mode = this.engineConfig.mode ?? 'prod';
        const requested = this.engineConfig.parserBackend ?? 'auto';

        if (requested !== 'auto') {
            return [requested];
        }

        switch (mode) {
            case 'test':
                return ['snapshot', 'wasm', 'js'];
            case 'ci':
                return ['wasm', 'js'];
            case 'prod':
            default:
                return ['wasm', 'js'];
        }
    }

    private instantiateBackend(kind: string): AstBackend {
        switch (kind) {
            case 'wasm':
                return new WebTreeSitterBackend();
            case 'js':
                return new JsAstBackend();
            case 'snapshot':
                if (!this.engineConfig.snapshotDir || !this.engineConfig.rootPath) {
                    throw new Error('Snapshot backend requires snapshotDir and rootPath');
                }
                return new SnapshotBackend({
                    snapshotDir: this.engineConfig.snapshotDir,
                    rootPath: this.engineConfig.rootPath
                });
            default:
                throw new Error(`Unknown parser backend: ${kind}`);
        }
    }

    private async initializeBackend(): Promise<void> {
        const candidates = this.getBackendPriority();
        const errors: string[] = [];

        for (const candidate of candidates) {
            try {
                const backend = this.instantiateBackend(candidate);
                await backend.initialize();
                this.backend = backend;
                this.initialized = true;
                this.activeBackend = candidate;
                return;
            } catch (error: any) {
                errors.push(`${candidate}: ${error.message}`);
            }
        }

        throw new Error(`Failed to initialize AST backend. Attempts: ${errors.join('; ')}`);
    }

    private resolveLanguageId(filePath: string): string {
        const ext = path.extname(filePath).toLowerCase();
        const langName = EXT_TO_LANG[ext];
        if (!langName) {
            throw new Error(`Unsupported language for ${filePath}`);
        }
        return langName;
    }
}
