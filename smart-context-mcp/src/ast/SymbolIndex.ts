import * as fs from 'fs';
import * as path from 'path';
import ignore from 'ignore';
import { LRUCache } from 'lru-cache';
import { SkeletonGenerator } from './SkeletonGenerator.js';
import { SymbolInfo } from '../types.js';
import { IndexDatabase } from '../indexing/IndexDatabase.js';

const SUPPORTED_EXTENSIONS = new Set<string>(['.ts', '.tsx', '.js', '.jsx', '.py']);
const HOT_CACHE_SIZE = 50;

export interface SymbolSearchResult {
    filePath: string;
    symbol: SymbolInfo;
}

interface CacheEntry {
    mtime: number;
    symbols: SymbolInfo[];
}

export class SymbolIndex {
    private readonly cache: LRUCache<string, CacheEntry>;
    private readonly rootPath: string;
    private readonly skeletonGenerator: SkeletonGenerator;
    private readonly ignoreFilter: ReturnType<typeof ignore.default>;
    private readonly db: IndexDatabase;

    constructor(rootPath: string, skeletonGenerator: SkeletonGenerator, ignorePatterns: string[], db?: IndexDatabase) {
        this.rootPath = rootPath;
        this.skeletonGenerator = skeletonGenerator;
        this.ignoreFilter = ignore.default().add(ignorePatterns);
        this.ignoreFilter.add(['.git', 'node_modules', '.mcp', '.smart-context', 'dist', 'coverage', '.DS_Store']);
        this.db = db ?? new IndexDatabase(this.rootPath);
        this.cache = new LRUCache({ max: HOT_CACHE_SIZE });
    }

    public invalidateFile(filePath: string) {
        const relativePath = this.toRelative(filePath);
        this.cache.delete(relativePath);
    }

    public invalidateDirectory(dirPath: string) {
        const relativePath = this.toRelative(dirPath);
        if (!relativePath) {
            this.cache.clear();
            return;
        }
        for (const key of this.cache.keys()) {
            if (key === relativePath || key.startsWith(`${relativePath}/`)) {
                this.cache.delete(key);
            }
        }
    }

    public dropFileFromIndex(filePath: string) {
        const relative = this.toRelative(filePath);
        this.cache.delete(relative);
        this.db.deleteFile(relative);
    }

    public dropDirectoryFromIndex(dirPath: string) {
        const relative = this.toRelative(dirPath);
        if (!relative) {
            this.cache.clear();
        } else {
            for (const key of this.cache.keys()) {
                if (key === relative || key.startsWith(`${relative}/`)) {
                    this.cache.delete(key);
                }
            }
        }
        this.db.deleteFilesByPrefix(relative ?? '');
    }

    public clearCache() {
        this.cache.clear();
    }

    public async search(query: string): Promise<SymbolSearchResult[]> {
        const results: SymbolSearchResult[] = [];
        const queryLower = query.toLowerCase();
        const symbolMap = this.db.streamAllSymbols();
        for (const [relativePath, symbols] of symbolMap) {
            for (const symbol of symbols) {
                if (symbol.name.toLowerCase().includes(queryLower)) {
                    results.push({ filePath: relativePath, symbol });
                }
            }
        }
        return results.slice(0, 100);
    }

    public async getAllSymbols(): Promise<Map<string, SymbolInfo[]>> {
        return this.db.streamAllSymbols();
    }

    public async getSymbolsForFile(filePath: string): Promise<SymbolInfo[]> {
        let stats: fs.Stats;
        try {
            stats = fs.statSync(filePath);
        } catch {
            this.dropFileFromIndex(filePath);
            return [];
        }
        const currentMtime = stats.mtimeMs;
        const relativePath = this.toRelative(filePath);
        const cached = this.cache.get(relativePath);
        if (cached && cached.mtime === currentMtime) {
            return cached.symbols;
        }

        const record = this.db.getFile(relativePath);
        if (record && record.last_modified === currentMtime) {
            const storedSymbols = this.db.readSymbols(relativePath);
            if (storedSymbols) {
                this.cache.set(relativePath, { mtime: currentMtime, symbols: storedSymbols });
                return storedSymbols;
            }
        }

        if (!this.isSupported(filePath)) {
            this.cache.set(relativePath, { mtime: currentMtime, symbols: [] });
            this.db.replaceSymbols({ relativePath, lastModified: currentMtime, symbols: [] });
            return [];
        }

        const content = fs.readFileSync(filePath, 'utf-8');
        const symbols = await this.extractSymbols(filePath, content);
        let language: string | null | undefined;
        try {
            language = await this.skeletonGenerator.getLanguageForFile(filePath);
        } catch {
            language = undefined;
        }
        this.cache.set(relativePath, { mtime: currentMtime, symbols });
        this.db.replaceSymbols({
            relativePath,
            lastModified: currentMtime,
            language,
            symbols
        });
        return symbols;
    }

    public isSupported(filePath: string): boolean {
        const ext = path.extname(filePath).toLowerCase();
        return SUPPORTED_EXTENSIONS.has(ext);
    }

    public shouldIgnore(relativePath: string): boolean {
        return !!relativePath && this.ignoreFilter.ignores(relativePath);
    }

    public getDatabase(): IndexDatabase {
        return this.db;
    }

    public getRootPath(): string {
        return this.rootPath;
    }

    private async extractSymbols(filePath: string, content: string): Promise<SymbolInfo[]> {
        try {
            const structure = await this.skeletonGenerator.generateStructureJson(filePath, content);
            return structure.map(symbol => {
                if (!symbol.content && symbol.range && typeof symbol.range.startByte === 'number' && typeof symbol.range.endByte === 'number') {
                    return {
                        ...symbol,
                        content: content.substring(symbol.range.startByte, symbol.range.endByte)
                    } as SymbolInfo;
                }
                return symbol;
            });
        } catch (error) {
            console.warn(`Symbol extraction failed for ${filePath}:`, error);
            return [];
        }
    }

    private toRelative(filePath: string): string {
        const absPath = path.isAbsolute(filePath) ? filePath : path.join(this.rootPath, filePath);
        return path.relative(this.rootPath, absPath).replace(/\\/g, '/');
    }
}
