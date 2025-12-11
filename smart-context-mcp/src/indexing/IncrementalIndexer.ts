import chokidar from 'chokidar';
import * as fs from 'fs';
import * as path from 'path';
import { SymbolIndex } from '../ast/SymbolIndex.js';
import { DependencyGraph } from '../ast/DependencyGraph.js';

export interface IncrementalIndexerOptions {
    watch?: boolean;
    initialScan?: boolean;
    batchPauseMs?: number;
}

const DEFAULT_BATCH_PAUSE_MS = 5;

export class IncrementalIndexer {
    private readonly queue = new Set<string>();
    private processing = false;
    private watcher?: chokidar.FSWatcher;
    private stopped = false;
    private initialScanPromise?: Promise<void>;

    constructor(
        private readonly rootPath: string,
        private readonly symbolIndex: SymbolIndex,
        private readonly dependencyGraph: DependencyGraph,
        private readonly options: IncrementalIndexerOptions = {}
    ) {}

    public start(): void {
        if (this.options.initialScan !== false) {
            this.initialScanPromise = this.enqueueInitialScan();
        }
        if (this.options.watch !== false) {
            this.watcher = chokidar.watch(this.rootPath, {
                ignoreInitial: true,
                persistent: true,
                ignored: (watchedPath: string) => this.shouldIgnore(watchedPath),
                awaitWriteFinish: {
                    stabilityThreshold: 200,
                    pollInterval: 100
                }
            });
            this.watcher.on('add', file => this.enqueuePath(file));
            this.watcher.on('change', file => this.enqueuePath(file));
            this.watcher.on('unlink', file => this.handleDeletion(file));
            this.watcher.on('unlinkDir', dir => this.handleDirectoryDeletion(dir));
            this.watcher.on('error', error => {
                console.warn('[IncrementalIndexer] watcher error', error);
            });
        }
    }

    public async stop(): Promise<void> {
        this.stopped = true;
        if (this.watcher) {
            await this.watcher.close();
        }
    }

    public async waitForInitialScan(): Promise<void> {
        await this.initialScanPromise;
    }

    private enqueuePath(filePath: string) {
        if (!this.isWithinRoot(filePath)) return;
        if (!this.symbolIndex.isSupported(filePath)) return;
        const normalized = path.resolve(filePath);
        if (this.queue.has(normalized)) return;
        this.queue.add(normalized);
        void this.processQueue();
    }

    private async processQueue(): Promise<void> {
        if (this.processing || this.stopped) return;
        this.processing = true;
        const pause = this.options.batchPauseMs ?? DEFAULT_BATCH_PAUSE_MS;
        while (this.queue.size > 0 && !this.stopped) {
            const iterator = this.queue.values().next();
            if (iterator.done) break;
            const filePath = iterator.value;
            this.queue.delete(filePath);

            if (!(await this.fileExists(filePath))) {
                continue;
            }

            try {
                const symbols = await this.symbolIndex.getSymbolsForFile(filePath);
                await this.dependencyGraph.updateFileDependencies(filePath, symbols);
            } catch (error) {
                console.warn(`[IncrementalIndexer] failed to index ${filePath}:`, error);
            }

            if (pause > 0) {
                await this.sleep(pause);
            }
        }
        this.processing = false;
    }

    private async enqueueInitialScan(): Promise<void> {
        const stack: string[] = [this.rootPath];
        while (stack.length > 0 && !this.stopped) {
            const current = stack.pop()!;
            let entries: fs.Dirent[];
            try {
                entries = await fs.promises.readdir(current, { withFileTypes: true });
            } catch {
                continue;
            }

            for (const entry of entries) {
                const fullPath = path.join(current, entry.name);
                const relative = path.relative(this.rootPath, fullPath);
                if (this.shouldIgnore(fullPath)) {
                    continue;
                }
                if (entry.isDirectory()) {
                    stack.push(fullPath);
                } else if (this.symbolIndex.isSupported(fullPath)) {
                    this.enqueuePath(fullPath);
                }
            }
            await this.sleep(0);
        }
    }

    private async handleDeletion(filePath: string): Promise<void> {
        if (!this.isWithinRoot(filePath)) return;
        this.queue.delete(path.resolve(filePath));
        try {
            await this.dependencyGraph.removeFile(filePath);
        } catch (error) {
            console.warn(`[IncrementalIndexer] failed to remove ${filePath}:`, error);
        }
    }

    private async handleDirectoryDeletion(dirPath: string): Promise<void> {
        if (!this.isWithinRoot(dirPath)) return;
        for (const queued of Array.from(this.queue)) {
            if (queued.startsWith(path.resolve(dirPath))) {
                this.queue.delete(queued);
            }
        }
        try {
            await this.dependencyGraph.removeDirectory(dirPath);
        } catch (error) {
            console.warn(`[IncrementalIndexer] failed to remove directory ${dirPath}:`, error);
        }
    }

    private shouldIgnore(absolutePath: string): boolean {
        if (!this.isWithinRoot(absolutePath)) return true;
        const relative = path.relative(this.rootPath, absolutePath);
        if (!relative) return false;
        if (relative.startsWith('.smart-context')) return true;
        return this.symbolIndex.shouldIgnore(relative);
    }

    private isWithinRoot(filePath: string): boolean {
        const normalized = path.resolve(filePath);
        return normalized.startsWith(this.rootPath);
    }

    private async fileExists(filePath: string): Promise<boolean> {
        try {
            await fs.promises.access(filePath, fs.constants.F_OK);
            return true;
        } catch {
            return false;
        }
    }

    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
