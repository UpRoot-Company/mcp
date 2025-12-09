import * as path from 'path';
import * as fs from 'fs';
import { Parser, Language } from 'web-tree-sitter';

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

export class AstManager {
    private static instance: AstManager;
    private initialized = false;
    private languages = new Map<string, any>(); // langName -> Language instance
    private parsers = new Map<string, any>();   // langName -> Parser instance

    private constructor() {}

    public static getInstance(): AstManager {
        if (!AstManager.instance) {
            AstManager.instance = new AstManager();
        }
        return AstManager.instance;
    }

    public async init(): Promise<void> {
        if (this.initialized) return;
        
        try {
            await Parser.init();
            this.initialized = true;
        } catch (error) {
            console.error('Failed to initialize web-tree-sitter:', error);
            throw error;
        }
    }

    /**
     * Pre-loads common language WASM files asynchronously.
     * This helps reduce latency on the first parse request.
     * Errors during warmup are logged but do not prevent other languages from loading.
     */
    public async warmup(languages: string[] = ['tsx', 'python', 'json']): Promise<void> {
        if (!this.initialized) await this.init(); // Ensure Parser is initialized
        
        const loadPromises = languages.map(async (langName) => {
            try {
                // Use getLanguageForName to leverage existing caching logic
                await this.getLanguageForName(langName);
            } catch (error) {
                console.warn(`Warmup: Failed to load grammar for ${langName}:`, error);
            }
        });

        await Promise.all(loadPromises);
    }

    /**
     * Returns a cached Language instance for a given language name.
     * Loads the WASM file if not already cached.
     */
    private async getLanguageForName(langName: string): Promise<any> {
        if (!this.initialized) await this.init();

        let lang = this.languages.get(langName);
        if (!lang) {
            try {
                const wasmPath = this.getWasmPath(langName);
                lang = await Language.load(wasmPath);

                // Ensure the language object reports its name without breaking the native instance
                try {
                    Object.defineProperty(lang, 'name', {
                        configurable: true,
                        enumerable: true,
                        value: langName
                    });
                } catch (defineError) {
                    // Fallback assignment for environments that allow direct mutation
                    (lang as any).name = langName;
                }

                this.languages.set(langName, lang);
            } catch (error) {
                console.warn(`Failed to load grammar for language ${langName}:`, error);
                throw error; // Re-throw to indicate specific language load failure
            }
        }
        return lang;
    }

    /**
     * Returns a cached Language instance for a given file path's language.
     * Delegates to getLanguageForName internally.
     */
    public async getLanguageForFile(filePath: string): Promise<any> {
        const ext = path.extname(filePath).toLowerCase();
        const langName = EXT_TO_LANG[ext];
        
        if (!langName) {
            return null;
        }
        return this.getLanguageForName(langName);
    }

    /**
     * Returns a cached parser instance configured for the given file's language.
     * Do NOT delete this parser.
     */
    public async getParserForFile(filePath: string): Promise<any> {
        const lang = await this.getLanguageForFile(filePath);
        if (!lang) return null;

        const ext = path.extname(filePath).toLowerCase();
        const langName = EXT_TO_LANG[ext];

        let parser = this.parsers.get(langName);
        if (!parser) {
            parser = new Parser();
            parser.setLanguage(lang);
            this.parsers.set(langName, parser);
        }
        return parser;
    }

    private getWasmPath(langName: string): string {
        try {
            const currentDir = path.dirname(new URL(import.meta.url).pathname);
            const projectRoot = path.resolve(currentDir, '../../');
            const wasmPath = path.join(projectRoot, 'node_modules', 'tree-sitter-wasms', 'out', `tree-sitter-${langName}.wasm`);
            return wasmPath;
        } catch (error) {
            return path.join(process.cwd(), 'node_modules', 'tree-sitter-wasms', 'out', `tree-sitter-${langName}.wasm`);
        }
    }
}
