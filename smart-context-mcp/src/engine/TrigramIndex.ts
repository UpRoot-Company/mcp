import path from "path";
import * as fsp from "fs/promises";
import ignore from "ignore";
import { IFileSystem } from "../platform/FileSystem.js";
import { PathManager } from "../utils/PathManager.js";

const createIgnore = () => (ignore as any).default ? (ignore as any).default() : (ignore as any)();

const TRIGRAM_INDEX_VERSION = 1;

export interface TrigramIndexOptions {
    ignoreGlobs?: string[];
    maxFileBytes?: number;
    includeExtensions?: string[];
}

type IgnoreInstance = ReturnType<typeof createIgnore>;

interface FileEntry {
    path: string;
    mtime: number;
    size: number;
    trigramFreq: Map<string, number>;
    trigramCount: number;
}

interface SearchCandidate {
    filePath: string;
    score: number;
}

interface SerializedFileEntry {
    path: string;
    mtime: number;
    size: number;
    trigramCount: number;
    trigramFreq: Array<[string, number]>;
}

interface SerializedTrigramIndex {
    version: number;
    projectRoot: string;
    entries: SerializedFileEntry[];
}

export class TrigramIndex {
    private readonly rootPath: string;
    private readonly fileSystem: IFileSystem;
    private ignoreFilter: IgnoreInstance;
    private options: Required<TrigramIndexOptions>;
    private readonly fileEntries = new Map<string, FileEntry>();
    private readonly postings = new Map<string, Map<string, number>>();
    private isReady = false;
    private buildPromise?: Promise<void>;
    private readonly cacheDir: string;
    private readonly persistPath: string;
    private persistTimer?: NodeJS.Timeout;
    private disposed = false;
    private persistPromise?: Promise<void>;
    private isBuilding = false;
    private needsPersistAfterBuild = false;

    constructor(rootPath: string, fileSystem: IFileSystem, options: TrigramIndexOptions = {}) {
        this.rootPath = path.resolve(rootPath);
        this.fileSystem = fileSystem;
        this.options = {
            ignoreGlobs: options.ignoreGlobs ?? [],
            maxFileBytes: options.maxFileBytes ?? 512 * 1024,
            includeExtensions: options.includeExtensions ?? [
                ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
                ".py", ".go", ".java", ".cs", ".rs", ".rb",
                ".php", ".kt", ".swift", ".scala",
                ".json", ".yaml", ".yml", ".toml",
                ".md", ".txt", ".css", ".scss", ".less",
                ".html", ".astro"
            ]
        };
        this.ignoreFilter = createIgnore().add(this.options.ignoreGlobs);
        this.cacheDir = PathManager.getIndexDir();
        this.persistPath = path.join(this.cacheDir, "trigram-index.json");
    }

    public async ensureReady(): Promise<void> {
        if (!this.isReady && !this.isBuilding && !this.buildPromise) {
            this.buildPromise = this.buildIndex();
        }
        if (this.buildPromise) {
            await this.buildPromise;
        }
    }

    public async rebuild(options: { logEvery?: number; logger?: (message: string) => void; logTotals?: boolean } = {}): Promise<void> {
        this.isReady = false;
        this.fileEntries.clear();
        this.postings.clear();
        this.buildPromise = this.buildIndex(options);
        await this.buildPromise;
    }

    public async updateIgnoreGlobs(globs: string[]): Promise<void> {
        this.options.ignoreGlobs = globs;
        this.ignoreFilter = createIgnore().add(globs);
        await this.rebuild();
    }

    public listFiles(): string[] {
        return Array.from(this.fileEntries.keys());
    }

    public async refreshFile(absPath: string): Promise<void> {
        const relPath = this.normalizeRelative(absPath);
        if (!relPath || this.ignoreFilter.ignores(relPath)) return;

        try {
            const stats = await this.fileSystem.stat(absPath);
            if (this.shouldIndexFile(relPath, stats.size)) {
                await this.indexFile(absPath, relPath, stats.mtime, stats.size);
                this.schedulePersist();
            } else if (this.fileEntries.has(relPath)) {
                this.removeEntry(relPath);
                this.schedulePersist();
            }
        } catch {
            // File might have been deleted
            await this.removeFile(absPath);
        }
    }

    public async removeFile(absPath: string): Promise<void> {
        const relPath = this.normalizeRelative(absPath);
        if (relPath && this.fileEntries.has(relPath)) {
            this.removeEntry(relPath);
            this.schedulePersist();
        }
    }

    public async refreshDirectory(absDir: string): Promise<void> {
        // Simple strategy: re-walk the directory
        await this.walk(absDir);
        this.schedulePersist();
    }

    public async search(term: string, limit: number = 200): Promise<SearchCandidate[]> {
        await this.ensureReady();
        
        const query = TrigramIndex.normalizeQuery(term);
        if (query.length < 3) {
            // Fallback to substring search for very short terms if needed
            return this.searchBySubstring(query, limit);
        }

        const queryTrigrams: string[] = [];
        for (let i = 0; i <= query.length - 3; i++) {
            queryTrigrams.push(query.substring(i, i + 3));
        }

        if (queryTrigrams.length === 0) return [];

        const scores = new Map<string, number>();
        
        // Simple overlap scoring
        for (const trigram of queryTrigrams) {
            const postings = this.postings.get(trigram);
            if (!postings) continue;

            for (const [path, freq] of postings) {
                const current = scores.get(path) || 0;
                // Basic TF scoring
                scores.set(path, current + (freq / (this.fileEntries.get(path)?.trigramCount || 1)));
            }
        }

        return Array.from(scores.entries())
            .map(([filePath, score]) => ({ filePath, score }))
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);
    }

    private async buildIndex(options?: { logEvery?: number; logger?: (message: string) => void; logTotals?: boolean }): Promise<void> {
        if (this.isBuilding) return;
        this.isBuilding = true;
        const logger = options?.logger;
        const logEvery = options?.logEvery ?? 500;
        const progress = logger
            ? {
                  indexed: 0,
                  lastLogged: 0,
                  logEvery,
                  logger,
                  total: options?.logTotals ? 0 : undefined
              }
            : undefined;

        try {
            // 1. Try to load from disk
            await this.loadPersistedIndex();

            if (progress && options?.logTotals) {
                const countStartedAt = Date.now();
                progress.logger("[TrigramIndex] Counting indexable files...");
                progress.total = await this.countIndexableFiles(this.rootPath, {
                    logger: progress.logger,
                    logEvery: Math.max(1000, progress.logEvery)
                });
                const countElapsed = Date.now() - countStartedAt;
                progress.logger(`[TrigramIndex] Counted ${progress.total} files in ${countElapsed}ms.`);
                progress.logger(`[TrigramIndex] Indexing 0/${progress.total} files (0%).`);
            } else if (progress) {
                progress.logger("[TrigramIndex] Indexing started.");
            }

            // 2. Walk filesystem to find new/changed files
            const visited = new Set<string>();
            await this.walk(this.rootPath, visited, progress);

            // 3. Prune entries no longer on disk
            await this.pruneStaleEntries(visited);

            this.isReady = true;
            if (progress) {
                if (typeof progress.total === "number") {
                    const percent = progress.total > 0 ? Math.round((progress.indexed / progress.total) * 100) : 100;
                    progress.logger(`[TrigramIndex] Indexed ${progress.indexed}/${progress.total} files (${percent}%).`);
                } else {
                    progress.logger(`[TrigramIndex] Indexed ${progress.indexed} files.`);
                }
            }
            
            if (this.needsPersistAfterBuild) {
                await this.persistIndex();
                this.needsPersistAfterBuild = false;
            }
        } catch (error) {
            console.error("[TrigramIndex] Failed to build index:", error);
        } finally {
            this.isBuilding = false;
        }
    }

    private async walk(
        absDir: string,
        visited?: Set<string>,
        progress?: { indexed: number; lastLogged: number; logEvery: number; logger: (message: string) => void; total?: number }
    ): Promise<void> {
        let entries: string[];
        try {
            entries = await this.fileSystem.readDir(absDir);
        } catch {
            return;
        }

        for (const name of entries) {
            const absPath = path.join(absDir, name);
            const relPath = this.normalizeRelative(absPath);
            
            if (!relPath || this.ignoreFilter.ignores(relPath)) continue;

            try {
                const stats = await this.fileSystem.stat(absPath);
                if (stats.isDirectory()) {
                    await this.walk(absPath, visited, progress);
                } else if (this.shouldIndexFile(relPath, stats.size)) {
                    if (visited) visited.add(relPath);
                    
                    const existing = this.fileEntries.get(relPath);
                    if (!existing || existing.mtime !== stats.mtime) {
                        await this.indexFile(absPath, relPath, stats.mtime, stats.size);
                        this.markDirty();
                        if (progress) {
                            progress.indexed += 1;
                            if (progress.indexed - progress.lastLogged >= progress.logEvery) {
                                progress.lastLogged = progress.indexed;
                                if (typeof progress.total === "number") {
                                    const percent = progress.total > 0
                                        ? Math.round((progress.indexed / progress.total) * 100)
                                        : 100;
                                    progress.logger(`[TrigramIndex] Indexed ${progress.indexed}/${progress.total} files (${percent}%).`);
                                } else {
                                    progress.logger(`[TrigramIndex] Indexed ${progress.indexed} files...`);
                                }
                            }
                        }
                    }
                }
            } catch {
                // Ignore stat errors
            }
        }
    }

    private async countIndexableFiles(
        absDir: string,
        options: { logger?: (message: string) => void; logEvery?: number } = {}
    ): Promise<number> {
        let count = 0;
        let scanned = 0;
        let lastLogged = 0;
        const stack = [absDir];
        const logEvery = options.logEvery ?? 5000;
        while (stack.length > 0) {
            const current = stack.pop()!;
            let entries: string[];
            try {
                entries = await this.fileSystem.readDir(current);
            } catch {
                continue;
            }
            for (const name of entries) {
                const absPath = path.join(current, name);
                const relPath = this.normalizeRelative(absPath);
                if (!relPath || this.ignoreFilter.ignores(relPath)) continue;
                try {
                    const stats = await this.fileSystem.stat(absPath);
                    scanned += 1;
                    if (options.logger && scanned - lastLogged >= logEvery) {
                        lastLogged = scanned;
                        options.logger(`[TrigramIndex] Counting... scanned ${scanned} entries.`);
                    }
                    if (stats.isDirectory()) {
                        stack.push(absPath);
                    } else if (this.shouldIndexFile(relPath, stats.size)) {
                        count += 1;
                    }
                } catch {
                    // Ignore stat errors
                }
            }
        }
        return count;
    }

    private shouldIndexFile(relativePath: string, size: number): boolean {
        if (size > this.options.maxFileBytes) return false;
        const ext = path.extname(relativePath).toLowerCase();
        return this.options.includeExtensions.includes(ext);
    }

    private async indexFile(absPath: string, relativePath: string, mtime?: number, size?: number): Promise<void> {
        try {
            const content = await this.fileSystem.readFile(absPath);
            const counts = TrigramIndex.extractTrigramCounts(content);
            
            // Remove old postings if updating
            this.removeEntry(relativePath);

            let totalTrigrams = 0;
            for (const [trigram, count] of counts) {
                let postings = this.postings.get(trigram);
                if (!postings) {
                    postings = new Map();
                    this.postings.set(trigram, postings);
                }
                postings.set(relativePath, count);
                totalTrigrams += count;
            }

            this.fileEntries.set(relativePath, {
                path: relativePath,
                mtime: mtime ?? Date.now(),
                size: size ?? content.length,
                trigramFreq: counts,
                trigramCount: totalTrigrams
            });
        } catch (error) {
            console.warn(`[TrigramIndex] Failed to index ${relativePath}:`, error);
        }
    }

    private removeEntry(relativePath: string): void {
        const entry = this.fileEntries.get(relativePath);
        if (!entry) return;

        for (const trigram of entry.trigramFreq.keys()) {
            const postings = this.postings.get(trigram);
            if (postings) {
                postings.delete(relativePath);
                if (postings.size === 0) {
                    this.postings.delete(trigram);
                }
            }
        }
        this.fileEntries.delete(relativePath);
    }

    private async loadPersistedIndex(): Promise<void> {
        try {
            if (!(await fsp.access(this.persistPath).then(() => true).catch(() => false))) {
                return;
            }

            const data = await fsp.readFile(this.persistPath, 'utf-8');
            const serialized = JSON.parse(data) as SerializedTrigramIndex;

            if (serialized.version !== TRIGRAM_INDEX_VERSION || serialized.projectRoot !== this.rootPath) {
                return;
            }

            console.info(`[TrigramIndex] Restored ${serialized.entries.length} files from persisted index`);

            for (const entry of serialized.entries) {
                const freqMap = new Map(entry.trigramFreq);
                this.fileEntries.set(entry.path, {
                    path: entry.path,
                    mtime: entry.mtime,
                    size: entry.size,
                    trigramCount: entry.trigramCount,
                    trigramFreq: freqMap
                });

                for (const [trigram, count] of entry.trigramFreq) {
                    let postings = this.postings.get(trigram);
                    if (!postings) {
                        postings = new Map();
                        this.postings.set(trigram, postings);
                    }
                    postings.set(entry.path, count);
                }
            }
        } catch (error) {
            console.warn("[TrigramIndex] Failed to load persisted index:", error);
            try {
                await fsp.rm(this.persistPath, { force: true });
                this.needsPersistAfterBuild = true;
            } catch {
                // ignore cleanup errors
            }
        }
    }

    private async pruneStaleEntries(visited: Set<string>): Promise<void> {
        for (const relPath of this.fileEntries.keys()) {
            if (!visited.has(relPath)) {
                this.removeEntry(relPath);
                this.markDirty();
            }
        }
    }

    private markDirty(): void {
        this.needsPersistAfterBuild = true;
    }

    public async dispose(): Promise<void> {
        this.disposed = true;
        if (this.persistTimer) {
            clearTimeout(this.persistTimer);
            this.persistTimer = undefined;
        }
        if (this.persistPromise) {
            await this.persistPromise;
        }
    }

    private schedulePersist(): void {
        if (this.disposed) {
            return;
        }
        if (this.persistTimer) clearTimeout(this.persistTimer);
        this.persistTimer = setTimeout(() => void this.persistIndex(), 5000);
        this.persistTimer.unref?.();
    }

    private async persistIndex(): Promise<void> {
        if (this.persistPromise) return this.persistPromise;
        if (this.isBuilding) {
            this.needsPersistAfterBuild = true;
            return;
        }

        this.persistPromise = (async () => {
            try {
                const serialized: SerializedTrigramIndex = {
                    version: TRIGRAM_INDEX_VERSION,
                    projectRoot: this.rootPath,
                    entries: Array.from(this.fileEntries.values()).map(e => ({
                        path: e.path,
                        mtime: e.mtime,
                        size: e.size,
                        trigramCount: e.trigramCount,
                        trigramFreq: Array.from(e.trigramFreq.entries())
                    }))
                };

                await fsp.mkdir(this.cacheDir, { recursive: true });
                await fsp.writeFile(this.persistPath, JSON.stringify(serialized), 'utf-8');
            } catch (error) {
                console.warn("[TrigramIndex] Failed to persist trigram index:", error);
            } finally {
                this.persistPromise = undefined;
            }
        })();

        return this.persistPromise;
    }

    public static extractTrigramCounts(content: string): Map<string, number> {
        const query = this.normalizeQuery(content);
        const counts = new Map<string, number>();
        
        if (query.length < 3) return counts;

        for (let i = 0; i <= query.length - 3; i++) {
            const trigram = query.substring(i, i + 3);
            counts.set(trigram, (counts.get(trigram) || 0) + 1);
        }
        return counts;
    }

    private async searchBySubstring(term: string, limit: number): Promise<SearchCandidate[]> {
        const matches: SearchCandidate[] = [];
        const lowerTerm = term.toLowerCase();

        for (const [path, entry] of this.fileEntries) {
            if (path.toLowerCase().includes(lowerTerm)) {
                matches.push({ filePath: path, score: 1.0 });
            }
            if (matches.length >= limit) break;
        }
        return matches;
    }

    public static normalizeQuery(input: string): string {
        return input.toLowerCase().replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
    }

    private normalizeRelative(absPath: string): string | null {
        try {
            const rel = path.relative(this.rootPath, absPath);
            return rel.startsWith('..') ? null : rel.replace(/\\/g, '/');
        } catch {
            return null;
        }
    }
}
