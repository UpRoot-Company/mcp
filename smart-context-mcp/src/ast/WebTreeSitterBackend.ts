import * as path from 'path';
import * as fs from 'fs';
import * as WebTreeSitterModule from 'web-tree-sitter';
import { AstBackend, AstDocument } from './AstBackend.js';

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

// Mapping file extensions to tree-sitter language identifiers
const EXT_TO_LANG: Record<string, string> = {
    '.ts': 'typescript',
    '.mts': 'typescript',
    '.cts': 'typescript',
    '.tsx': 'tsx',
    '.js': 'tsx', // Use tsx parser for JS files for better JSX support
    '.mjs': 'tsx', // Use tsx parser for MJS files
    '.cjs': 'tsx', // Use tsx parser for CJS files
    '.jsx': 'tsx', // Use tsx parser for JSX files
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

export class WebTreeSitterBackend implements AstBackend {
    name = "web-tree-sitter";
    capabilities = {
        supportsComments: true,
        supportsTypeAnnotations: true,
        supportsQueries: true,
        nodeTypeNormalization: 'tree-sitter' as const
    };

    private languages = new Map<string, any>(); // langName -> Language instance
    private parsers = new Map<string, any>();   // langName -> Parser instance
    private initialized = false;
    private parserCtor: any;
    private initFn: () => Promise<void>;
    private languageLoader: any;

    constructor() {
        this.parserCtor = resolveParserConstructor(WebTreeSitterModule);
        this.initFn = resolveInitFn(WebTreeSitterModule, this.parserCtor);
        this.languageLoader = resolveLanguageLoader(WebTreeSitterModule, this.parserCtor);
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
        const langName = languageHint || EXT_TO_LANG[ext];

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
        
        if (this.languages.has(languageId)) {
            return this.languages.get(languageId);
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
        if (this.parsers.has(langName)) {
            return this.parsers.get(langName)!;
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
        // Try to locate tree-sitter-wasms package
        try {
            const wasmPath = require.resolve(`tree-sitter-wasms/out/tree-sitter-${langName}.wasm`);
            return wasmPath;
        } catch (e) {
            // Fallback for local development or different layout
            return path.resolve(process.cwd(), `node_modules/tree-sitter-wasms/out/tree-sitter-${langName}.wasm`);
        }
    }
}
