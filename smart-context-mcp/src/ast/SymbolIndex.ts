import * as fs from 'fs';
import * as path from 'path';
import ignore from 'ignore';
import { SkeletonGenerator } from './SkeletonGenerator.js';
import { SymbolInfo } from '../types.js';

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

    private async getSymbolsForFile(filePath: string): Promise<SymbolInfo[]> {
        const stats = fs.statSync(filePath);
        const currentMtime = stats.mtimeMs;
        const relativePath = path.relative(this.rootPath, filePath);

        const cached = this.cache.get(relativePath);
        if (cached && cached.mtime === currentMtime) {
            return cached.symbols;
        }

        const content = fs.readFileSync(filePath, 'utf-8');
        const symbols = await this.skeletonGenerator.generateStructureJson(filePath, content);
        this.cache.set(relativePath, { mtime: currentMtime, symbols });
        return symbols;
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
                    if (['.ts', '.tsx', '.js', '.jsx', '.py'].includes(ext)) {
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
