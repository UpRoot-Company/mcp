import * as path from 'path';
import * as WebTreeSitterModule from 'web-tree-sitter';
import { createRequire } from 'module';
import { AstBackend, AstDocument } from './AstBackend.js';
import { LRUCache } from '../utils/LRUCache.js';
import { BUILTIN_LANGUAGE_MAPPINGS } from '../config/LanguageConfig.js';

function resolveParserConstructor(moduleRef: any): any {
    if (typeof moduleRef === 'function') {
        return moduleRef;
    }
    if (moduleRef && typeof moduleRef.Parser === 'function') {
        return moduleRef.Parser;
    }
    throw new Error('web-tree-sitter Parser constructor not available');
}

function resolveInitFn(moduleRef: any, parserCtor: any): (() => Promise<void>) {
    if (moduleRef && typeof moduleRef.init === 'function') {
        return moduleRef.init.bind(moduleRef);
    }
    if (parserCtor && typeof parserCtor.init === 'function') {
        return parserCtor.init.bind(moduleRef || parserCtor);
    }
    throw new Error('web-tree-sitter init function not found');
}

function resolveLanguageLoader(moduleRef: any, parserCtor: any): any {
    if (moduleRef && moduleRef.Language) {
        return moduleRef.Language;
    }
    if (parserCtor && parserCtor.Language) {
        return parserCtor.Language;
    }
    throw new Error('web-tree-sitter Language loader not available');
}

export class WebTreeSitterBackend implements AstBackend {
    name = "web-tree-sitter";
    capabilities = {
        supportsComments: true,
        supportsTypeAnnotations: true,
        supportsQueries: true,
        nodeTypeNormalization: 'tree-sitter' as const
    };

    private languages: LRUCache<string, any>;
    private parsers: LRUCache<string, any>;
    private initialized = false;
    private parserCtor: any;
    private initFn: () => Promise<void>;
    private languageLoader: any;
    private cleanupInterval?: NodeJS.Timeout;
    private readonly localRequire = createRequire(import.meta.url);

    constructor() {
        this.parserCtor = resolveParserConstructor(WebTreeSitterModule);
        this.initFn = resolveInitFn(WebTreeSitterModule, this.parserCtor);
        this.languageLoader = resolveLanguageLoader(WebTreeSitterModule, this.parserCtor);

        this.languages = new LRUCache<string, any>(
            20,
            10 * 60 * 1000,
            (langName, lang) => {
                console.debug(`[WebTreeSitter] Evicting language ${langName}`);
                if (typeof lang?.delete === 'function') {
                    lang.delete();
                }
            }
        );
        this.parsers = new LRUCache<string, any>(
            10,
            5 * 60 * 1000,
            (langName, parser) => {
                console.debug(`[WebTreeSitter] Evicting parser ${langName}`);
                if (typeof parser?.delete === 'function') {
                    parser.delete();
                }
            }
        );
        const isTestEnv = process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined;
        if (!isTestEnv) {
            this.cleanupInterval = setInterval(() => {
                this.languages.cleanup();
                this.parsers.cleanup();
            }, 60 * 1000);
        }
    }

    async initialize(): Promise<void> {
        if (this.initialized) return;
        try {
            await this.initFn();
            this.initialized = true;
        } catch (error) {
            console.error("Failed to initialize web-tree-sitter:", error);
            throw error;
        }
    }

    async parseFile(absPath: string, content: string, languageHint?: string): Promise<AstDocument> {
        if (!this.initialized) await this.initialize();

        const ext = path.extname(absPath).toLowerCase();
        const langName = languageHint || BUILTIN_LANGUAGE_MAPPINGS[ext]?.languageId;

        if (!langName) {
            throw new Error(`Unsupported language for file: ${absPath}`);
        }

        const parser = await this.getParserForLanguage(langName);
        const tree = parser.parse(content);
        
        return {
            rootNode: tree.rootNode,
            languageId: langName,
            dispose: () => tree.delete()
        };
    }

    async getLanguage(languageId: string): Promise<any> {
        if (!this.initialized) await this.initialize();
        
        const cached = this.languages.get(languageId);
        if (cached) {
            return cached;
        }

        const wasmPath = this.getWasmPath(languageId);
        try {
            const lang = await this.languageLoader.load(wasmPath);
            this.languages.set(languageId, lang);
            return lang;
        } catch (error) {
            console.error(`Failed to load language ${languageId} from ${wasmPath}:`, error);
            throw error;
        }
    }

    private async getParserForLanguage(langName: string): Promise<any> {
        const cached = this.parsers.get(langName);
        if (cached) {
            return cached;
        }

        const lang = await this.getLanguage(langName);
        const parser = new this.parserCtor();
        parser.setLanguage(lang);
        this.parsers.set(langName, parser);
        return parser;
    }

    public async getParser(languageId: string): Promise<any> {
        if (!this.initialized) await this.initialize();
        return this.getParserForLanguage(languageId);
    }

    private getWasmPath(langName: string): string {
        const overrideDir = (process.env.SMART_CONTEXT_WASM_DIR || '').trim();
        if (overrideDir) {
            return path.resolve(overrideDir, `tree-sitter-${langName}.wasm`);
        }

        try {
            return this.localRequire.resolve(`tree-sitter-wasms/out/tree-sitter-${langName}.wasm`);
        } catch (e) {
            return path.resolve(process.cwd(), `node_modules/tree-sitter-wasms/out/tree-sitter-${langName}.wasm`);
        }
    }

    public dispose(): void {
        this.languages.clear();
        this.parsers.clear();
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = undefined;
        }
    }
}
