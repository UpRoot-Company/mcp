import chokidar from 'chokidar';
import * as fs from 'fs';
import * as path from 'path';
import { SymbolIndex } from '../ast/SymbolIndex.js';
import { DependencyGraph } from '../ast/DependencyGraph.js';
import { metrics } from "../utils/MetricsCollector.js";

export interface IncrementalIndexerOptions {
    watch?: boolean;
    initialScan?: boolean;
    batchPauseMs?: number;
}

const DEFAULT_BATCH_PAUSE_MS = 50;
const MAX_BATCH_PAUSE_MS = 500;

export class IncrementalIndexer {
    private readonly queue = new Map<string, number>();
    private processing = false;
    private watcher?: chokidar.FSWatcher;
    private stopped = false;
    private initialScanPromise?: Promise<void>;
    private currentPauseMs = DEFAULT_BATCH_PAUSE_MS;
    private recentEventCount = 0;
    private lastEventBurst = 0;
    private maxQueueDepthSeen = 0;
    private lastDepthLogAt = 0;

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
                    stabilityThreshold: 300,
                    pollInterval: 150
                },
                atomic: true
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

    public getQueueStats(): { currentDepth: number; maxDepthSeen: number; currentPauseMs: number } {
        return {
            currentDepth: this.queue.size,
            maxDepthSeen: this.maxQueueDepthSeen,
            currentPauseMs: this.currentPauseMs
        };
    }

    private enqueuePath(filePath: string) {
        if (!this.isWithinRoot(filePath)) return;
        if (!this.symbolIndex.isSupported(filePath)) return;
        let normalized = path.resolve(filePath);
        try {
            const realpathSync = (fs as any).realpathSync?.native ?? fs.realpathSync;
            normalized = realpathSync(normalized);
        } catch {
            // Fallback to resolved path when realpath fails (e.g., transient deletes).
        }
        const now = Date.now();

        if (now - this.lastEventBurst < 1000) {
            this.recentEventCount++;
        } else {
            this.recentEventCount = 1;
            this.lastEventBurst = now;
        }

        if (this.recentEventCount > 10) {
            this.currentPauseMs = Math.min(this.currentPauseMs * 1.5, MAX_BATCH_PAUSE_MS);
        } else if (this.recentEventCount <= 2) {
            this.currentPauseMs = Math.max(DEFAULT_BATCH_PAUSE_MS, this.currentPauseMs / 1.5);
        }

        this.queue.set(normalized, now);
        if (this.queue.size > this.maxQueueDepthSeen) {
            this.maxQueueDepthSeen = this.queue.size;
        }
        metrics.inc("indexer.events");
        metrics.gauge("indexer.queue_depth", this.queue.size);
        metrics.gauge("indexer.pause_ms", this.currentPauseMs);
        if (this.queue.size >= 200 && now - this.lastDepthLogAt > 5000) {
            console.info(`[IncrementalIndexer] High queue depth: ${this.queue.size} (pause=${this.currentPauseMs}ms)`);
            this.lastDepthLogAt = now;
        }
        void this.processQueue();
    }

    private async processQueue(): Promise<void> {
        if (this.processing || this.stopped) return;
        this.processing = true;
        while (this.queue.size > 0 && !this.stopped) {
            const batchDelay = Math.max(this.options.batchPauseMs ?? this.currentPauseMs, 50);
            await this.sleep(batchDelay);

            const batchEntries = Array.from(this.queue.keys());
            this.queue.clear();

            for (const filePath of batchEntries) {
                if (!(await this.fileExists(filePath))) {
                    continue;
                }

                try {
                    const symbols = await this.symbolIndex.getSymbolsForFile(filePath);
                    await this.dependencyGraph.updateFileDependencies(filePath, symbols);
                } catch (error) {
                    console.warn(`[IncrementalIndexer] failed to index ${filePath}:`, error);
                }
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
        for (const queued of Array.from(this.queue.keys())) {
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
