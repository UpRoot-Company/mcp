import * as fs from 'fs';
import * as path from 'path';
import ignore from 'ignore';
import { SkeletonGenerator } from './SkeletonGenerator.js';
import { SymbolInfo } from '../types.js';

const SUPPORTED_EXTENSIONS = new Set<string>(['.ts', '.tsx', '.js', '.jsx', '.py']);

export interface SymbolSearchResult {
    filePath: string;
    symbol: SymbolInfo;
}

export class SymbolIndex {
    private cache = new Map<string, { mtime: number; symbols: SymbolInfo[] }>();
    private rootPath: string;
    private skeletonGenerator: SkeletonGenerator;
    private ignoreFilter: any;

    constructor(rootPath: string, skeletonGenerator: SkeletonGenerator, ignorePatterns: string[]) {
        this.rootPath = rootPath;
        this.skeletonGenerator = skeletonGenerator;
        this.ignoreFilter = ignore.default().add(ignorePatterns);
        // Always ignore common artifacts to prevent massive scans
        this.ignoreFilter.add(['.git', 'node_modules', '.mcp', 'dist', 'coverage', '.DS_Store']);
    }

    public invalidateFile(filePath: string) {
        const absPath = path.isAbsolute(filePath) ? filePath : path.join(this.rootPath, filePath);
        const relativePath = path.relative(this.rootPath, absPath);
        this.cache.delete(relativePath);
    }

    public invalidateDirectory(dirPath: string) {
        const absPath = path.isAbsolute(dirPath) ? dirPath : path.join(this.rootPath, dirPath);
        const relativePath = path.relative(this.rootPath, absPath);
        if (!relativePath) {
            this.cache.clear();
            return;
        }
        for (const key of Array.from(this.cache.keys())) {
            if (key === relativePath || key.startsWith(`${relativePath}${path.sep}`) || key.startsWith(`${relativePath}/`)) {
                this.cache.delete(key);
            }
        }
    }

    public clearCache() {
        this.cache.clear();
    }

    public async search(query: string): Promise<SymbolSearchResult[]> {
        const files = this.scanFiles(this.rootPath);
        const results: SymbolSearchResult[] = [];
        const queryLower = query.toLowerCase();

        for (const file of files) {
            try {
                const symbols = await this.getSymbolsForFile(file);
                for (const symbol of symbols) {
                    if (symbol.name.toLowerCase().includes(queryLower)) {
                        results.push({
                            filePath: path.relative(this.rootPath, file),
                            symbol
                        });
                    }
                }
            } catch (error) {
                // Ignore errors for individual files during search
            }
        }
        
        // Limit results to avoid token overflow
        return results.slice(0, 100);
    }

    public async getAllSymbols(): Promise<Map<string, SymbolInfo[]>> {
        const files = this.scanFiles(this.rootPath);
        const result = new Map<string, SymbolInfo[]>();
        
        for (const file of files) {
            try {
                const relativePath = path.relative(this.rootPath, file);
                const symbols = await this.getSymbolsForFile(file);
                result.set(relativePath, symbols);
            } catch (e) {
                // ignore
            }
        }
        return result;
    }

    public async getSymbolsForFile(filePath: string): Promise<SymbolInfo[]> {
        const stats = fs.statSync(filePath);
        const currentMtime = stats.mtimeMs;
        const relativePath = path.relative(this.rootPath, filePath);

        const cached = this.cache.get(relativePath);
        if (cached && cached.mtime === currentMtime) {
            return cached.symbols;
        }

        const ext = path.extname(filePath).toLowerCase();
        if (!SUPPORTED_EXTENSIONS.has(ext)) {
            this.cache.set(relativePath, { mtime: currentMtime, symbols: [] });
            return [];
        }

        const content = fs.readFileSync(filePath, 'utf-8');
        try {
            const structure = await this.skeletonGenerator.generateStructureJson(filePath, content);
            const enriched = structure.map(symbol => {
                if (!symbol.content && symbol.range && typeof symbol.range.startByte === 'number' && typeof symbol.range.endByte === 'number') {
                    return {
                        ...symbol,
                        content: content.substring(symbol.range.startByte, symbol.range.endByte)
                    } as SymbolInfo;
                }
                return symbol;
            });

            this.cache.set(relativePath, { mtime: currentMtime, symbols: enriched });
            return enriched;
        } catch (error) {
            console.warn(`Symbol extraction failed for ${filePath}:`, error);
            this.cache.set(relativePath, { mtime: currentMtime, symbols: [] });
            return [];
        }
    }


    private scanFiles(dir: string): string[] {
        let results: string[] = [];
        let list: string[] = [];
        try {
            list = fs.readdirSync(dir);
        } catch (e) {
            return [];
        }
        
        for (const file of list) {
            const absPath = path.join(dir, file);
            const relPath = path.relative(this.rootPath, absPath);
            
            if (relPath && this.ignoreFilter.ignores(relPath)) {
                continue;
            }

            try {
                const stat = fs.statSync(absPath);
                if (stat && stat.isDirectory()) {
                    results = results.concat(this.scanFiles(absPath));
                } else {
                    const ext = path.extname(file).toLowerCase();
                    if (SUPPORTED_EXTENSIONS.has(ext)) {
                        results.push(absPath);
                    }
                }
            } catch (e) {
                // Ignore access errors
            }
        }
        return results;
    }
}
