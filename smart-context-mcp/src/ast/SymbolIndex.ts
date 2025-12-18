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
    private ignoreFilter: ReturnType<typeof ignore.default>;
    private readonly db: IndexDatabase;
    private userIgnorePatterns: string[];

    private baselinePromise?: Promise<void>;
    private editTracker: Map<string, number> = new Map();
    private pendingUpdates: Set<string> = new Set();
    private updateDebounceTimer?: NodeJS.Timeout;


    constructor(rootPath: string, skeletonGenerator: SkeletonGenerator, ignorePatterns: string[], db?: IndexDatabase) {
        this.rootPath = rootPath;
        this.skeletonGenerator = skeletonGenerator;
        this.userIgnorePatterns = [...ignorePatterns];
        this.ignoreFilter = this.createIgnoreFilter(this.userIgnorePatterns);
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

    public updateIgnorePatterns(patterns: string[]): void {
        this.userIgnorePatterns = [...patterns];
        this.ignoreFilter = this.createIgnoreFilter(this.userIgnorePatterns);
    }

    public async search(query: string): Promise<SymbolSearchResult[]> {
        await this.ensureBaselineIndex();
        
        const pattern = `%${query}%`;
        const rows = this.db.searchSymbols(pattern, 100);
        
        const results = rows.map(row => ({
            filePath: row.path,
            symbol: JSON.parse(row.data_json) as SymbolInfo
        }));
        
        if (results.length > 0) {
            return results;
        }

        return this.fuzzySearch(query, { maxEditDistance: 2 });
    }

    public async findFilesBySymbolName(keywords: string[]): Promise<string[]> {
        await this.ensureBaselineIndex();
        const filePaths = new Set<string>();
        
        for (const keyword of keywords) {
            const pattern = `%${keyword}%`;
            const rows = this.db.searchSymbols(pattern, 200);
            for (const row of rows) {
                filePaths.add(row.path);
            }
        }
        
        return Array.from(filePaths);
    }

    public async getAllSymbols(): Promise<Map<string, SymbolInfo[]>> {
        await this.ensureBaselineIndex();
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
        this.cache.set(relativePath, { mtime: currentMtime, symbols });
        this.db.replaceSymbols({
            relativePath,
            lastModified: currentMtime,
            language: null,
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

    public restoreFromCache(filePath: string, symbols: SymbolInfo[], mtime: number): void {
        const relativePath = this.toRelative(filePath);
        this.cache.set(relativePath, { mtime, symbols });
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

    private async ensureBaselineIndex(): Promise<void> {
        if (this.baselinePromise) {
            return this.baselinePromise;
        }
        this.baselinePromise = this.syncWithDisk();
        try {
            await this.baselinePromise;
        } finally {
            this.baselinePromise = undefined;
        }
    }

    private async syncWithDisk(): Promise<void> {
        const records = this.db.listFiles();
        const recordMap = new Map(records.map(record => [record.path, record]));
        const files = this.scanFiles(this.rootPath);
        const seen = new Set<string>();

        for (const filePath of files) {
            const relative = this.toRelative(filePath);
            seen.add(relative);
            let stats: fs.Stats;
            try {
                stats = fs.statSync(filePath);
            } catch {
                continue;
            }
            const record = recordMap.get(relative);
            if (!record || record.last_modified !== stats.mtimeMs) {
                await this.getSymbolsForFile(filePath);
            }
        }

        for (const record of recordMap.values()) {
            if (!seen.has(record.path)) {
                this.db.deleteFile(record.path);
                this.cache.delete(record.path);
            }
        }

    }

    private scanFiles(dir: string): string[] {
        let results: string[] = [];
        let list: string[] = [];
        try {
            list = fs.readdirSync(dir);
        } catch {
            return [];
        }
        for (const entry of list) {
            const absPath = path.join(dir, entry);
            const relPath = path.relative(this.rootPath, absPath);
            if (relPath && this.shouldIgnore(relPath)) {
                continue;
            }
            try {
                const stat = fs.statSync(absPath);
                if (stat.isDirectory()) {
                    results = results.concat(this.scanFiles(absPath));
                } else if (this.isSupported(absPath)) {
                    results.push(absPath);
                }
            } catch {
                continue;
            }
        }
        return results;
    }

    public fuzzySearch(
        query: string,
        options: { maxEditDistance: number; scoreThreshold?: number }
    ): SymbolSearchResult[] {
        const symbolMap = this.db.streamAllSymbols();
        const candidates: { result: SymbolSearchResult; distance: number; score: number }[] = [];

        for (const [filePath, symbols] of symbolMap) {
            for (const symbol of symbols) {
                const distance = this.levenshteinDistance(query.toLowerCase(), symbol.name.toLowerCase());
                const score = this.calculateFuzzyScore(query, symbol.name);
                
                if (distance <= options.maxEditDistance && (!options.scoreThreshold || score >= options.scoreThreshold)) {
                    candidates.push({
                        result: { filePath, symbol },
                        distance,
                        score
                    });
                }
            }
        }

        return candidates
            .sort((a, b) => b.score - a.score)
            .slice(0, 100)
            .map(c => c.result);
    }

    private calculateFuzzyScore(query: string, symbolName: string): number {
        const distance = this.levenshteinDistance(
            query.toLowerCase(),
            symbolName.toLowerCase()
        );
        const maxLength = Math.max(query.length, symbolName.length);
        const similarity = 1 - (distance / maxLength);

        // Boost score for prefix matches
        const prefixBoost = symbolName.toLowerCase().startsWith(query.toLowerCase()) ? 0.2 : 0;

        // Boost score for case-insensitive exact matches
        const exactBoost = query.toLowerCase() === symbolName.toLowerCase() ? 0.3 : 0;

        return Math.min(1.0, similarity + prefixBoost + exactBoost);
    }

    private levenshteinDistance(a: string, b: string): number {
        const matrix: number[][] = [];

        for (let i = 0; i <= b.length; i++) {
            matrix[i] = [i];
        }

        for (let j = 0; j <= a.length; j++) {
            matrix[0][j] = j;
        }

        for (let i = 1; i <= b.length; i++) {
            for (let j = 1; j <= a.length; j++) {
                if (b.charAt(i - 1) === a.charAt(j - 1)) {
                    matrix[i][j] = matrix[i - 1][j - 1];
                } else {
                    matrix[i][j] = Math.min(
                        matrix[i - 1][j - 1] + 1, // substitution
                        matrix[i][j - 1] + 1,     // insertion
                        matrix[i - 1][j] + 1      // deletion
                    );
                }
            }
        }

        return matrix[b.length][a.length];
    }

    public markFileModified(filepath: string): void {
        this.editTracker.set(filepath, Date.now());
        this.pendingUpdates.add(filepath);
        this.scheduleIncrementalUpdate();
    }

    private scheduleIncrementalUpdate(): void {
        if (this.updateDebounceTimer) {
            clearTimeout(this.updateDebounceTimer);
        }

        this.updateDebounceTimer = setTimeout(() => {
            void this.incrementalUpdate();
        }, 500);
    }

    private async incrementalUpdate(): Promise<void> {
        if (this.pendingUpdates.size === 0) return;

        const filesToUpdate = Array.from(this.pendingUpdates);
        this.pendingUpdates.clear();

        for (const relativePath of filesToUpdate) {
            try {
                // Check if file still exists
                const fullPath = path.join(this.rootPath, relativePath);
                if (!fs.existsSync(fullPath)) {
                    this.db.deleteFile(relativePath);
                    this.cache.delete(relativePath);
                    continue;
                }

                // Re-index this file only
                const content = fs.readFileSync(fullPath, 'utf-8');
                const symbols = await this.extractSymbols(fullPath, content);
                this.cache.set(relativePath, { mtime: Date.now(), symbols });
                this.db.replaceSymbols({
                    relativePath,
                    lastModified: Date.now(),
                    language: null,
                    symbols
                });
            } catch (error) {
                console.error(`Failed to incrementally update ${relativePath}:`, error);
            }
        }
    }

    public getRecentlyModified(timeWindowMs: number): string[] {
        const cutoff = Date.now() - timeWindowMs;
        const result: string[] = [];
        for (const [filepath, timestamp] of this.editTracker.entries()) {
            if (timestamp > cutoff) {
                result.push(path.join(this.rootPath, filepath));
            }
        }
        return result;
    }

    public findSimilar(query: string, limit: number = 5): SymbolInfo[] {
        const results = this.fuzzySearch(query, { maxEditDistance: 2 });
        return results.slice(0, limit).map(r => r.symbol);
    }

    private createIgnoreFilter(patterns: string[]) {
        const filter = ignore.default().add(patterns);
                filter.add(['.git', 'node_modules', '.mcp', 'dist', 'coverage', '.DS_Store']);
        return filter;
    }
}

