import path from "path";
import * as fsp from "fs/promises";
import ignore from "ignore";
import { IFileSystem } from "../platform/FileSystem.js";

const createIgnore = () => {
    const factory = (ignore as any).default ?? ignore;
    return factory();
};

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
                this.cacheDir = path.join(this.rootPath, ".mcp", "smart-context");
        this.persistPath = path.join(this.cacheDir, "trigram-index.json");
    }

    public async ensureReady(): Promise<void> {
        if (this.isReady) {
            return;
        }
        if (!this.buildPromise) {
            this.buildPromise = this.buildIndex();
        }
        await this.buildPromise;
    }

    public async rebuild(): Promise<void> {
        this.fileEntries.clear();
        this.postings.clear();
        this.isReady = false;
        this.buildPromise = this.buildIndex();
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
        const normalized = this.normalizeRelative(absPath);
        if (!normalized) {
            return;
        }
        await this.ensureReady();
        await this.indexFile(absPath, normalized);
    }

    public async removeFile(absPath: string): Promise<void> {
        const normalized = this.normalizeRelative(absPath);
        if (!normalized) {
            return;
        }
        await this.ensureReady();
        this.removeEntry(normalized);
    }

    public async refreshDirectory(absDir: string): Promise<void> {
        const normalizedDir = this.normalizeRelative(absDir);
        if (!normalizedDir) {
            return;
        }
        await this.ensureReady();
        for (const filePath of Array.from(this.fileEntries.keys())) {
            if (filePath === normalizedDir || filePath.startsWith(`${normalizedDir}/`)) {
                this.removeEntry(filePath);
            }
        }
        const absPath = path.isAbsolute(absDir) ? absDir : path.join(this.rootPath, absDir);
        await this.walk(absPath);
    }

    public async search(term: string, limit: number = 200): Promise<SearchCandidate[]> {
        await this.ensureReady();
        const sanitized = TrigramIndex.normalizeQuery(term);
        if (!sanitized) {
            return [];
        }
        if (sanitized.length < 3) {
            return this.searchBySubstring(sanitized, limit);
        }
        const trigramCounts = TrigramIndex.extractTrigramCounts(sanitized);
        if (trigramCounts.size === 0) {
            return [];
        }
        const docCount = Math.max(1, this.fileEntries.size);
        const scores = new Map<string, number>();
        let totalQueryWeight = 0;

        for (const [trigram, qCount] of trigramCounts) {
            const posting = this.postings.get(trigram);
            if (!posting) {
                continue;
            }
            const df = posting.size;
            const idf = Math.log((docCount - df + 0.5) / (df + 0.5) + 1);
            totalQueryWeight += qCount * idf;
            for (const [filePath, freq] of posting) {
                const shared = Math.min(freq, qCount);
                const gain = shared * idf;
                scores.set(filePath, (scores.get(filePath) || 0) + gain);
            }
        }

        if (scores.size === 0) {
            return [];
        }
        const divisor = totalQueryWeight || 1;
        return Array.from(scores.entries())
            .map(([filePath, rawScore]) => ({ filePath, score: rawScore / divisor }))
            .sort((a, b) => b.score - a.score)
            .slice(0, limit);
    }

    private async buildIndex(): Promise<void> {
        this.isBuilding = true;
        const visited = new Set<string>();
        try {
            await this.loadPersistedIndex();
            await this.walk(this.rootPath, visited);
            await this.pruneStaleEntries(visited);
            this.isReady = true;
        } finally {
            this.isBuilding = false;
        }

        if (this.needsPersistAfterBuild) {
            await this.persistIndex();
            this.needsPersistAfterBuild = false;
        }
    }

    private async walk(absDir: string, visited?: Set<string>): Promise<void> {
        let entries: string[] = [];
        try {
            entries = await this.fileSystem.readDir(absDir);
        } catch {
            return;
        }
        for (const entry of entries) {
            const absPath = path.join(absDir, entry);
            const relative = this.normalizeRelative(absPath);
            if (!relative) {
                continue;
            }
            if (this.ignoreFilter.ignores(relative)) {
                continue;
            }
            let stats;
            try {
                stats = await this.fileSystem.stat(absPath);
            } catch {
                continue;
            }
            if (stats.isDirectory()) {
                await this.walk(absPath, visited);
                continue;
            }
            if (!this.shouldIndexFile(relative, stats.size)) {
                continue;
            }
            visited?.add(relative);
            await this.indexFile(absPath, relative, stats.mtime, stats.size);
        }
    }

    private shouldIndexFile(relativePath: string, size: number): boolean {
        if (size > this.options.maxFileBytes) {
            return false;
        }
        const ext = path.extname(relativePath).toLowerCase();
        if (!ext) {
            return false;
        }
        return this.options.includeExtensions.includes(ext);
    }

    private async indexFile(absPath: string, relativePath: string, mtime?: number, size?: number): Promise<void> {
        let statsMtime = mtime;
        let statsSize = size;
        if (statsMtime === undefined || statsSize === undefined) {
            try {
                const stats = await this.fileSystem.stat(absPath);
                statsMtime = stats.mtime;
                statsSize = stats.size;
            } catch {
                return;
            }
        }
        const previous = this.fileEntries.get(relativePath);
        if (previous && previous.mtime === statsMtime && previous.size === statsSize) {
            return;
        }
        let content: string;
        try {
            content = await this.fileSystem.readFile(absPath);
        } catch {
            return;
        }
        const trigramFreq = TrigramIndex.extractTrigramCounts(content);
        this.removeEntry(relativePath);
        const entry: FileEntry = {
            path: relativePath,
            mtime: statsMtime ?? Date.now(),
            size: statsSize ?? content.length,
            trigramFreq,
            trigramCount: Array.from(trigramFreq.values()).reduce((sum, value) => sum + value, 0)
        };
        this.fileEntries.set(relativePath, entry);
        for (const [trigram, count] of trigramFreq) {
            let posting = this.postings.get(trigram);
            if (!posting) {
                posting = new Map();
                this.postings.set(trigram, posting);
            }
            posting.set(relativePath, count);
        }
        this.markDirty();
    }

    private removeEntry(relativePath: string): void {
        const existing = this.fileEntries.get(relativePath);
        if (!existing) {
            return;
        }
        this.fileEntries.delete(relativePath);
        for (const [trigram, posting] of this.postings) {
            posting.delete(relativePath);
            if (posting.size === 0) {
                this.postings.delete(trigram);
            }
        }
        this.markDirty();
    }

    private async loadPersistedIndex(): Promise<void> {
        try {
            const data = await fsp.readFile(this.persistPath, "utf-8");
            const parsed = JSON.parse(data) as SerializedTrigramIndex;
            if (parsed.version !== TRIGRAM_INDEX_VERSION) {
                console.info(`[TrigramIndex] Ignoring persisted index (version ${parsed.version})`);
                return;
            }
            if (path.resolve(parsed.projectRoot) !== this.rootPath) {
                console.info("[TrigramIndex] Ignoring persisted index (project root changed)");
                return;
            }
            this.fileEntries.clear();
            this.postings.clear();
            for (const entry of parsed.entries) {
                const freq = new Map<string, number>(entry.trigramFreq);
                this.fileEntries.set(entry.path, {
                    path: entry.path,
                    mtime: entry.mtime,
                    size: entry.size,
                    trigramCount: entry.trigramCount,
                    trigramFreq: freq
                });
                for (const [trigram, count] of freq) {
                    let posting = this.postings.get(trigram);
                    if (!posting) {
                        posting = new Map();
                        this.postings.set(trigram, posting);
                    }
                    posting.set(entry.path, count);
                }
            }
            console.info(`[TrigramIndex] Restored ${parsed.entries.length} files from persisted index`);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException)?.code;
            if (code && code !== "ENOENT") {
                console.warn("[TrigramIndex] Failed to read persisted index:", error);
            }
        }
    }

    private async pruneStaleEntries(visited: Set<string>): Promise<void> {
        for (const relativePath of Array.from(this.fileEntries.keys())) {
            if (!visited.has(relativePath)) {
                this.removeEntry(relativePath);
            }
        }
    }

    private markDirty(): void {
        if (this.isBuilding) {
            this.needsPersistAfterBuild = true;
            return;
        }
        this.schedulePersist();
    }

    private schedulePersist(): void {
        if (this.persistTimer) {
            return;
        }
        this.persistTimer = setTimeout(() => {
            this.persistTimer = undefined;
            void this.persistIndex();
        }, 2000);
    }

    private async persistIndex(): Promise<void> {
        if (this.persistPromise) {
            return this.persistPromise;
        }
        this.persistPromise = (async () => {
            try {
                await fsp.mkdir(this.cacheDir, { recursive: true });
                const entries: SerializedFileEntry[] = Array.from(this.fileEntries.values()).map(entry => ({
                    path: entry.path,
                    mtime: entry.mtime,
                    size: entry.size,
                    trigramCount: entry.trigramCount,
                    trigramFreq: Array.from(entry.trigramFreq.entries())
                }));
                const payload: SerializedTrigramIndex = {
                    version: TRIGRAM_INDEX_VERSION,
                    projectRoot: this.rootPath,
                    entries
                };
                await fsp.writeFile(this.persistPath, JSON.stringify(payload));
            } catch (error) {
                console.warn("[TrigramIndex] Failed to persist trigram index:", error);
            } finally {
                this.persistPromise = undefined;
            }
        })();
        return this.persistPromise;
    }

    public static extractTrigramCounts(content: string): Map<string, number> {
        const freq = new Map<string, number>();
        const normalized = content.replace(/[\r\n]+/g, " ").toLowerCase();
        if (normalized.length < 3) {
            if (normalized.trim().length > 0) {
                freq.set(normalized.trim(), 1);
            }
            return freq;
        }
        for (let i = 0; i <= normalized.length - 3; i++) {
            const trigram = normalized.slice(i, i + 3);
            if (trigram.trim().length < 3) {
                continue;
            }
            freq.set(trigram, (freq.get(trigram) || 0) + 1);
        }
        return freq;
    }

    private async searchBySubstring(term: string, limit: number): Promise<SearchCandidate[]> {
        const normalizedTerm = term.toLowerCase();
        const results: SearchCandidate[] = [];
        for (const [filePath] of this.fileEntries) {
            const absPath = path.join(this.rootPath, filePath);
            let content: string;
            try {
                content = await this.fileSystem.readFile(absPath);
            } catch {
                continue;
            }
            if (content.toLowerCase().includes(normalizedTerm)) {
                results.push({ filePath, score: 1 });
                if (results.length >= limit) {
                    break;
                }
            }
        }
        return results;
    }

    public static normalizeQuery(input: string): string {
        return input.normalize("NFKC").trim().toLowerCase();
    }

    private normalizeRelative(absPath: string): string | null {
        const absolute = path.isAbsolute(absPath) ? absPath : path.join(this.rootPath, absPath);
        if (!absolute.startsWith(this.rootPath)) {
            return null;
        }
        const relative = path.relative(this.rootPath, absolute);
        return relative.replace(/\\/g, "/");
    }
}
