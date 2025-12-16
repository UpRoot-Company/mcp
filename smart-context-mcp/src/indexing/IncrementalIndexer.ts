import chokidar from 'chokidar';
import * as fs from 'fs';
import * as path from 'path';
import { SymbolIndex } from '../ast/SymbolIndex.js';
import { DependencyGraph } from '../ast/DependencyGraph.js';
import { IndexDatabase } from './IndexDatabase.js';
import { ModuleResolver } from '../ast/ModuleResolver.js';
import { ConfigurationEvent, ConfigurationManager } from '../config/ConfigurationManager.js';
import { metrics } from "../utils/MetricsCollector.js";

import { ProjectIndexManager } from './ProjectIndexManager.js';
import type { ProjectIndex, FileIndexEntry } from './ProjectIndex.js';
import { ImportExtractor } from '../ast/ImportExtractor.js';
import { ExportExtractor } from '../ast/ExportExtractor.js';

export interface IncrementalIndexerOptions {
    watch?: boolean;
    initialScan?: boolean;
    batchPauseMs?: number;
}

const DEFAULT_BATCH_PAUSE_MS = 50;
const MAX_BATCH_PAUSE_MS = 500;
type PriorityLevel = 'high' | 'medium' | 'low';

export interface IndexerStatusSnapshot {
    queueDepth: { high: number; medium: number; low: number; total: number };
    currentPauseMs: number;
    maxQueueDepthSeen: number;
    processing: boolean;
    activity?: {
        label: string;
        detail?: string;
        startedAt: string;
    };
}

export class IncrementalIndexer {
    private readonly queues: Record<PriorityLevel, Map<string, number>> = {
        high: new Map(),
        medium: new Map(),
        low: new Map()
    };
    private processing = false;
    private watcher?: chokidar.FSWatcher;
    private stopped = false;
    private initialScanPromise?: Promise<void>;
    private currentPauseMs = DEFAULT_BATCH_PAUSE_MS;
    private recentEventCount = 0;
    private lastEventBurst = 0;
    private maxQueueDepthSeen = 0;
    private lastDepthLogAt = 0;

    private moduleConfigReloadPromise?: Promise<void>;
    private configurationSubscriptions: Array<{ event: ConfigurationEvent; handler: (payload: any) => void }> = [];
        private configEventsRegistered = false;
    private activity?: { label: string; detail?: string; startedAt: number };

    private indexManager: ProjectIndexManager;
    private currentIndex: ProjectIndex | null = null;
    private importExtractor: ImportExtractor;
    private exportExtractor: ExportExtractor;

    constructor(
        private readonly rootPath: string,
        private readonly symbolIndex: SymbolIndex,
        private readonly dependencyGraph: DependencyGraph,
        private readonly indexDatabase?: IndexDatabase,
        private readonly moduleResolver?: ModuleResolver,
        private readonly configurationManager?: ConfigurationManager,
                private readonly options: IncrementalIndexerOptions = {}
    ) {
        this.indexManager = new ProjectIndexManager(rootPath);
        this.importExtractor = new ImportExtractor(rootPath);
        this.exportExtractor = new ExportExtractor(rootPath);
    }

    public async start(): Promise<void> {
        console.log('[IncrementalIndexer] Starting with persistent index support...');
        
        // Step 1: Load existing index (if available)
        this.currentIndex = await this.indexManager.loadPersistedIndex();
        
        // Step 2: If index exists, restore in-memory state
        if (this.currentIndex) {
            await this.restoreFromPersistedIndex(this.currentIndex);
        } else {
            this.currentIndex = this.indexManager.createEmptyIndex();
        }

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

            this.watcher.on('add', file => this.enqueuePath(file, 'medium'));
            this.watcher.on('change', file => void this.handleFileChange(file));
            this.watcher.on('unlink', file => this.handleDeletion(file));
            this.watcher.on('unlinkDir', dir => this.handleDirectoryDeletion(dir));
            this.watcher.on('error', error => {
                console.warn('[IncrementalIndexer] watcher error', error);
            });
        }

        if (this.configurationManager && !this.configEventsRegistered) {
            this.registerConfigurationEvents();
        }
    }

            private periodicPersistenceTimer?: NodeJS.Timeout;

    public async stop(): Promise<void> {
        this.stopped = true;
        this.unregisterConfigurationEvents();
        
        // Cancel pending persistence
        if (this.debouncedPersist && typeof this.debouncedPersist.cancel === 'function') {
            this.debouncedPersist.cancel();
        }
        
        // Stop periodic persistence
        if (this.periodicPersistenceTimer) {
            clearInterval(this.periodicPersistenceTimer);
            this.periodicPersistenceTimer = undefined;
        }

        // Final persist before closing
        if (this.currentIndex) {
            console.log('[IncrementalIndexer] Persisting index before shutdown...');
            await this.indexManager.persistIndex(this.currentIndex);
        }

        if (this.watcher) {
            await this.watcher.close();
        }
    }

    public async waitForInitialScan(): Promise<void> {
        await this.initialScanPromise;
    }

    public getQueueStats(): { currentDepth: number; maxDepthSeen: number; currentPauseMs: number } {
        const depth = this.getQueueDepth();
        return {
            currentDepth: depth.total,
            maxDepthSeen: this.maxQueueDepthSeen,
            currentPauseMs: this.currentPauseMs
        };
    }

    public getActivitySnapshot(): IndexerStatusSnapshot {
        const depth = this.getQueueDepth();
        return {
            queueDepth: depth,
            currentPauseMs: this.currentPauseMs,
            maxQueueDepthSeen: this.maxQueueDepthSeen,
            processing: this.processing,
            activity: this.activity
                ? {
                    label: this.activity.label,
                    detail: this.activity.detail,
                    startedAt: new Date(this.activity.startedAt).toISOString()
                }
                : undefined
        };
    }

    private enqueuePath(filePath: string, priority: PriorityLevel = 'medium') {
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

        this.removeFromQueues(normalized);
        this.queues[priority].set(normalized, now);
        const totalDepth = this.getTotalQueueSize();
        if (totalDepth > this.maxQueueDepthSeen) {
            this.maxQueueDepthSeen = totalDepth;
        }
        metrics.inc("indexer.events");
        metrics.gauge("indexer.queue_depth", totalDepth);
        metrics.gauge("indexer.pause_ms", this.currentPauseMs);
        if (totalDepth >= 200 && now - this.lastDepthLogAt > 5000) {
            console.info(`[IncrementalIndexer] High queue depth: ${totalDepth} (pause=${this.currentPauseMs}ms)`);
            this.lastDepthLogAt = now;
        }
        void this.processQueue();
    }

    private async processQueue(): Promise<void> {
        if (this.processing || this.stopped) return;
        this.processing = true;
        while (this.getTotalQueueSize() > 0 && !this.stopped) {
            const batchDelay = Math.max(this.options.batchPauseMs ?? this.currentPauseMs, 50);
            await this.sleep(batchDelay);
            this.setActivity('queue_processing', `Processing ${this.getTotalQueueSize()} queued files`);

            const batchEntries = this.pullNextBatch();
            for (const filePath of batchEntries) {
                if (this.stopped) {
                    break;
                }
                if (!(await this.fileExists(filePath))) {
                    continue;
                }

                                try {
                    const symbols = await this.symbolIndex.getSymbolsForFile(filePath);
                    const imports = await this.importExtractor.extractImports(filePath);
                    const exports = await this.exportExtractor.extractExports(filePath);

                    await this.dependencyGraph.updateFileDependencies(filePath);

                    // Update persistent index
                    if (this.currentIndex && !this.stopped) {
                        const stat = await fs.promises.stat(filePath).catch(() => undefined);
                        if (stat) {
                            const entry: FileIndexEntry = {
                                mtime: stat.mtimeMs,
                                symbols,
                                imports,
                                exports,
                                trigrams: {
                                    wordCount: 0,
                                    uniqueTrigramCount: 0
                                }
                            };
                            this.indexManager.updateFileEntry(this.currentIndex, filePath, entry);
                        }
                    }
                } catch (error) {
                    console.warn(`[IncrementalIndexer] failed to index ${filePath}:`, error);
                }
            }
            this.debouncedPersist();
        }
        this.clearActivity('queue_processing');
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
                    // Check if file needs reindexing
                    if (await this.shouldReindex(fullPath)) {
                        this.enqueuePath(fullPath, 'low');
                    } else {
                        // console.debug(`[IncrementalIndexer] Skipping unchanged file: ${fullPath}`);
                    }
                }
            }
            await this.sleep(0);
        }
    }

    private async handleFileChange(filePath: string): Promise<void> {
        this.enqueuePath(filePath);
    }

    private async handleIgnoreChange(): Promise<void> {
        if (!this.indexDatabase) {
            console.warn('[IncrementalIndexer] IndexDatabase not provided; skipping gitignore reindex');
            return;
        }

        console.info('[IncrementalIndexer] Detected .gitignore change; re-evaluating indexed files...');
        this.setActivity('gitignore_reindex', 'Re-evaluating ignore rules');
        try {
            const indexedFiles = this.indexDatabase.listFiles();
            const filesToRemove: string[] = [];

            for (const fileRecord of indexedFiles) {
                const absolutePath = path.join(this.rootPath, fileRecord.path);
                if (this.shouldIgnore(absolutePath)) {
                    filesToRemove.push(fileRecord.path);
                }
            }

            for (const relPath of filesToRemove) {
                try {
                    this.indexDatabase.deleteFile(relPath);
                    console.debug(`[IncrementalIndexer] Removed ignored file from index: ${relPath}`);
                } catch (error) {
                    console.warn(`[IncrementalIndexer] Failed to remove ${relPath} from index:`, error);
                }
            }

            const newFiles = await this.scanForNewFiles();
            for (const filePath of newFiles) {
                this.enqueuePath(filePath, 'high');
            }

            console.info(`[IncrementalIndexer] Gitignore reindex: removed ${filesToRemove.length} files, enqueued ${newFiles.length} new files`);
        } catch (error) {
            console.error('[IncrementalIndexer] Error handling .gitignore change:', error);
        } finally {
            this.clearActivity('gitignore_reindex');
        }
    }

    private async scanForNewFiles(): Promise<string[]> {
        if (!this.indexDatabase) {
            return [];
        }

        const newFiles: string[] = [];
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
                    continue;
                }

                if (!this.symbolIndex.isSupported(fullPath)) {
                    continue;
                }

                const relPath = path.relative(this.rootPath, fullPath);
                const existing = this.indexDatabase.getFile(relPath);
                if (!existing) {
                    newFiles.push(fullPath);
                }
            }

            await this.sleep(0);
        }

        return newFiles;
    }

        private registerConfigurationEvents(): void {
        if (!this.configurationManager) return;
        const ignoreHandler = () => void this.handleIgnoreChange();
        const tsconfigHandler = (payload: { filePath: string }) => void this.handleModuleConfigChange(payload.filePath);
        const packageHandler = (payload: { filePath: string }) => void this.handleModuleConfigChange(payload.filePath);

        this.configurationManager.on("ignoreChanged", ignoreHandler);
        this.configurationSubscriptions.push({ event: "ignoreChanged", handler: ignoreHandler });

        this.configurationManager.on("tsconfigChanged", tsconfigHandler);
        this.configurationSubscriptions.push({ event: "tsconfigChanged", handler: tsconfigHandler });

        this.configurationManager.on("jsconfigChanged", tsconfigHandler);
        this.configurationSubscriptions.push({ event: "jsconfigChanged", handler: tsconfigHandler });

        this.configurationManager.on("packageJsonChanged", packageHandler);
        this.configurationSubscriptions.push({ event: "packageJsonChanged", handler: packageHandler });

        this.configEventsRegistered = true;
    }

        private unregisterConfigurationEvents(): void {
        if (!this.configurationManager) return;
        for (const subscription of this.configurationSubscriptions) {
            this.configurationManager.off(subscription.event as ConfigurationEvent, subscription.handler);
        }
        this.configurationSubscriptions = [];
        this.configEventsRegistered = false;
    }

    private async handleModuleConfigChange(filePath: string): Promise<void> {
        if (!this.moduleResolver) {
            console.warn('[IncrementalIndexer] ModuleResolver not provided; skipping config reload');
            return;
        }

        if (!this.moduleConfigReloadPromise) {
            this.moduleConfigReloadPromise = this.performModuleConfigReload(filePath).finally(() => {
                this.moduleConfigReloadPromise = undefined;
            });
        }

        try {
            await this.moduleConfigReloadPromise;
        } catch {
            // Errors already logged in performModuleConfigReload
        }
    }

    private async performModuleConfigReload(filePath: string): Promise<void> {
        const basename = path.basename(filePath);
        console.info(`[IncrementalIndexer] Detected configuration change (${basename}); reloading module resolver and rebuilding unresolved dependencies...`);
        this.setActivity('config_reload', `Reloading configuration from ${basename}`);
        try {
            this.moduleResolver!.reloadConfig();
            await this.dependencyGraph.rebuildUnresolved();
            console.info('[IncrementalIndexer] Configuration reload complete.');
        } catch (error) {
            console.error('[IncrementalIndexer] Error handling configuration change:', error);
        } finally {
            this.clearActivity('config_reload');
        }
    }

        private async handleDeletion(filePath: string): Promise<void> {
        if (!this.isWithinRoot(filePath)) return;
        this.removeFromQueues(path.resolve(filePath));
        try {
            await this.dependencyGraph.removeFile(filePath);
            
            if (this.currentIndex) {
                this.indexManager.removeFileEntry(this.currentIndex, filePath);
                this.debouncedPersist();
            }
        } catch (error) {
            console.warn(`[IncrementalIndexer] failed to remove ${filePath}:`, error);
        }
    }

    private async handleDirectoryDeletion(dirPath: string): Promise<void> {
        if (!this.isWithinRoot(dirPath)) return;
        const normalizedDir = path.resolve(dirPath);
        this.removeMatchingFromQueues(queued => queued.startsWith(normalizedDir));
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
                if (relative.startsWith('.mcp')) return true;
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

    private pullNextBatch(): string[] {
        if (this.queues.high.size > 0) {
            return this.flushQueue('high');
        }
        if (this.queues.medium.size > 0) {
            return this.flushQueue('medium');
        }
        if (this.queues.low.size > 0) {
            return this.flushQueue('low');
        }
        return [];
    }

    private flushQueue(priority: PriorityLevel): string[] {
        const queue = this.queues[priority];
        const entries = Array.from(queue.keys());
        queue.clear();
        return entries;
    }

    private getTotalQueueSize(): number {
        return this.queues.high.size + this.queues.medium.size + this.queues.low.size;
    }

    private getQueueDepth() {
        const high = this.queues.high.size;
        const medium = this.queues.medium.size;
        const low = this.queues.low.size;
        return {
            high,
            medium,
            low,
            total: high + medium + low
        };
    }

    private removeFromQueues(filePath: string): void {
        for (const queue of Object.values(this.queues)) {
            queue.delete(filePath);
        }
    }

    private removeMatchingFromQueues(predicate: (path: string) => boolean): void {
        for (const queue of Object.values(this.queues)) {
            for (const key of Array.from(queue.keys())) {
                if (predicate(key)) {
                    queue.delete(key);
                }
            }
        }
    }

    private setActivity(label: string, detail?: string): void {
        this.activity = { label, detail, startedAt: Date.now() };
    }

        private clearActivity(label?: string): void {
        if (!label || (this.activity && this.activity.label === label)) {
            this.activity = undefined;
        }
    }

    private async shouldReindex(filePath: string): Promise<boolean> {
        if (!this.currentIndex) return true;
        
        // Normalize path to match keys in currentIndex.files
        let normalized = path.resolve(filePath);
        try {
            const realpathSync = (fs as any).realpathSync?.native ?? fs.realpathSync;
            normalized = realpathSync(normalized);
        } catch {
            // Fallback to resolved path when realpath fails
        }
        
        const entry = this.currentIndex.files[normalized];
        if (!entry) return true; // New file
        
        try {
            const stat = await fs.promises.stat(filePath);
            return stat.mtimeMs > entry.mtime; // Changed if mtime newer
        } catch {
            return true; // Stat failed → reindex to be safe
        }
    }

    private async restoreFromPersistedIndex(index: ProjectIndex): Promise<void> {
        console.log(`[IncrementalIndexer] Restoring from persisted index (${Object.keys(index.files).length} files)...`);
        
        // Restore symbols to SymbolIndex
        for (const [filePath, entry] of Object.entries(index.files)) {
            this.symbolIndex.restoreFromCache(filePath, entry.symbols, entry.mtime);
        }
        
        // Restore dependencies to DependencyGraph
        for (const [filePath, entry] of Object.entries(index.files)) {
            if (entry.imports && entry.imports.length > 0) {
                const edges = entry.imports.map(imp => ({
                    from: filePath,
                    to: imp.from,
                    type: 'import' as const,
                    what: imp.what.join(', '),
                    line: imp.line
                }));
                await this.dependencyGraph.restoreEdges(filePath, edges);
            }
        }
        
        console.log('[IncrementalIndexer] Restore complete');
    }

    private debouncedPersist = debounce(async () => {
        if (this.currentIndex) {
            await this.indexManager.persistIndex(this.currentIndex);
        }
    }, 5000); // Wait 5 seconds after last change

        private startPeriodicPersistence(): void {
        if (this.periodicPersistenceTimer) {
            clearInterval(this.periodicPersistenceTimer);
        }
        this.periodicPersistenceTimer = setInterval(async () => {
            if (this.currentIndex && !this.stopped) {
                await this.indexManager.persistIndex(this.currentIndex);
            }
        }, 5 * 60 * 1000); // Every 5 minutes
    }
}

interface DebouncedFunction<T extends (...args: any[]) => any> {
    (...args: Parameters<T>): void;
    cancel: () => void;
}

function debounce<T extends (...args: any[]) => any>(
    func: T,
    wait: number
): DebouncedFunction<T> {
    let timeout: NodeJS.Timeout | null = null;
    
    const debounced = (...args: Parameters<T>) => {
        if (timeout) clearTimeout(timeout);
        timeout = setTimeout(() => func(...args), wait);
    };

    debounced.cancel = () => {
        if (timeout) {
            clearTimeout(timeout);
            timeout = null;
        }
    };

    return debounced;
}
