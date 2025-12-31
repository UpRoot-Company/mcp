import chokidar from 'chokidar';
import * as fs from 'fs';
import * as path from 'path';
import { SymbolIndex } from '../ast/SymbolIndex.js';
import { DependencyGraph } from '../ast/DependencyGraph.js';
import { IndexDatabase } from './IndexDatabase.js';
import { ModuleResolver } from '../ast/ModuleResolver.js';
import { ConfigurationEvent, ConfigurationManager } from '../config/ConfigurationManager.js';
import { metrics } from "../utils/MetricsCollector.js";
import { PathManager } from "../utils/PathManager.js";

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
const IGNORE_FILE = '.gitignore';
const CONFIG_FILES = ['tsconfig.json', 'jsconfig.json', 'package.json'];
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
    private processingPromise: Promise<void> | null = null;
    private watcher?: chokidar.FSWatcher;
    private stopped = false;
    private started = false;
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
        if (this.started) {
            console.warn('[IncrementalIndexer] start() called while already running');
            return;
        }
        this.started = true;
        this.stopped = false;

        console.log('[IncrementalIndexer] Starting with persistent index support...');

        // 1. Try to load existing index
        this.currentIndex = await this.indexManager.loadPersistedIndex();

        if (this.currentIndex) {
            // Restore in-memory state
            await this.restoreFromPersistedIndex(this.currentIndex);
        } else {
            this.currentIndex = this.indexManager.createEmptyIndex();
        }

        // 2. Initial scan
        if (this.options.initialScan !== false) {
            this.initialScanPromise = this.enqueueInitialScan();
        }

        // 3. Start watcher
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

            // Watch ignore file
            this.watcher.add(path.join(this.rootPath, IGNORE_FILE));

            // Watch config files
            for (const file of CONFIG_FILES) {
                this.watcher.add(path.join(this.rootPath, file));
            }

            this.watcher.on('add', file => this.enqueuePath(file, 'medium'));
            this.watcher.on('change', file => void this.handleFileChange(file));
            this.watcher.on('unlink', file => this.handleDeletion(file));
            this.watcher.on('unlinkDir', dir => this.handleDirectoryDeletion(dir));
            this.watcher.on('error', error => {
                console.warn('[IncrementalIndexer] watcher error', error);
            });
        }

        this.registerConfigurationEvents();
        this.startPeriodicPersistence();
    }

    private periodicPersistenceTimer?: NodeJS.Timeout;

        public async stop(): Promise<void> {
        console.log('[IncrementalIndexer] Stop called');
        this.stopped = true;
        this.started = false;

        this.unregisterConfigurationEvents();

        if (this.periodicPersistenceTimer) {
            console.log('[IncrementalIndexer] Clearing persistence timer');
            clearInterval(this.periodicPersistenceTimer);
        }

        // Wait for current processing batch to complete
        if (this.processingPromise) {
            console.log('[IncrementalIndexer] Waiting for processingPromise to resolve...');
            await this.processingPromise;
            console.log('[IncrementalIndexer] processingPromise resolved');
        }

        if (this.debouncedPersist) {
            console.log('[IncrementalIndexer] Cancelling debounced persist');
            this.debouncedPersist.cancel();
        }

        // Final persist before stop
        if (this.currentIndex) {
            console.log('[IncrementalIndexer] Persisting index before shutdown...');
            await this.indexManager.persistIndex(this.currentIndex);
        }

        if (this.watcher) {
            console.log('[IncrementalIndexer] Closing watcher');
            await this.watcher.close();
        }

        if (this.indexDatabase && typeof this.indexDatabase.close === 'function') {
            console.log('[IncrementalIndexer] Closing database');
            this.indexDatabase.close();
        }
        console.log('[IncrementalIndexer] Stop complete');
    }


    public async waitForInitialScan(): Promise<void> {
        if (this.initialScanPromise) {
            await this.initialScanPromise;
        }
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
            activity: this.activity ? {
                label: this.activity.label,
                detail: this.activity.detail,
                startedAt: new Date(this.activity.startedAt).toISOString()
            } : undefined
        };
    }

    private enqueuePath(filePath: string, priority: PriorityLevel = 'medium') {
        if (!this.isWithinRoot(filePath)) return;
        if (!this.symbolIndex.isSupported(filePath)) return;

        const normalized = path.resolve(filePath);
        const realpathSync = (fs as any).realpathSync?.native ?? fs.realpathSync;
        let finalPath = normalized;
        try {
            finalPath = realpathSync(normalized);
        } catch {
            // Ignore if path doesn't exist
        }

        const now = Date.now();
        const burstLimit = 1000; // 1 second
        if (now - this.lastEventBurst < burstLimit) {
            this.recentEventCount++;
        } else {
            this.recentEventCount = 1;
            this.lastEventBurst = now;
        }

        // Adaptive pacing based on event frequency
        if (this.recentEventCount > 50) {
            this.currentPauseMs = Math.min(this.currentPauseMs * 1.5, MAX_BATCH_PAUSE_MS);
        } else if (this.recentEventCount < 10) {
            this.currentPauseMs = Math.max(DEFAULT_BATCH_PAUSE_MS, this.currentPauseMs / 1.5);
        }

        this.removeFromQueues(finalPath);
        this.queues[priority].set(finalPath, now);

        const totalDepth = this.getTotalQueueSize();
        this.maxQueueDepthSeen = Math.max(this.maxQueueDepthSeen, totalDepth);

        metrics.inc("indexer.events");
        metrics.gauge("indexer.queue_depth", totalDepth);
        metrics.gauge("indexer.pause_ms", this.currentPauseMs);

        if (totalDepth > 100 && (now - this.lastDepthLogAt > 5000)) {
            console.info(`[IncrementalIndexer] High queue depth: ${totalDepth} (pause=${this.currentPauseMs}ms)`);
            this.lastDepthLogAt = now;
        }

                if (!this.processingPromise) {
            this.processingPromise = this.processQueue().finally(() => {
                this.processingPromise = null;
            });
        }

    }

    private async processQueue(): Promise<void> {
        if (this.processing || this.stopped) return;
        this.processing = true;

        while (this.getTotalQueueSize() > 0 && !this.stopped) {
            const batchDelay = Math.max(this.options.batchPauseMs ?? this.currentPauseMs, 50);
            await this.sleep(batchDelay);
            this.setActivity('queue_processing', `Processing ${this.getTotalQueueSize()} queued files`);

            const batchEntries = this.pullNextBatch();
            
            // Phase 1 (ADR-029): Parallel processing within batch
            const PARALLEL_LIMIT = 8;
            for (let i = 0; i < batchEntries.length; i += PARALLEL_LIMIT) {
                const chunk = batchEntries.slice(i, i + PARALLEL_LIMIT);
                await Promise.all(chunk.map(async (filePath) => {
                    if (this.stopped) {
                        return;
                    }
                    if (!(await this.fileExists(filePath))) {
                        return;
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
                }));
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

            const supportedFiles: string[] = [];
            for (const entry of entries) {
                const fullPath = path.join(current, entry.name);
                if (this.shouldIgnore(fullPath)) continue;

                if (entry.isDirectory()) {
                    stack.push(fullPath);
                } else if (this.symbolIndex.isSupported(fullPath)) {
                    supportedFiles.push(fullPath);
                }
            }

            // Phase 1 (ADR-029): Parallel check for reindexing
            const filesToIndex = await this.batchShouldReindex(supportedFiles);
            for (const filePath of filesToIndex) {
                this.enqueuePath(filePath, 'low');
            }

            // Yield control back to event loop periodically
            await this.sleep(0);
        }
    }

    private async handleFileChange(filePath: string): Promise<void> {
        const basename = path.basename(filePath);
        
        // If ignore file changed, we might need a full re-scan or at least re-evaluate current index
        if (basename === IGNORE_FILE) {
            await this.handleIgnoreChange();
            return;
        }

        if (CONFIG_FILES.includes(basename)) {
            await this.handleModuleConfigChange(filePath);
        }

        this.enqueuePath(filePath, 'medium');
    }

    private async handleIgnoreChange(): Promise<void> {
        try {
            if (!this.indexDatabase) {
                console.warn('[IncrementalIndexer] IndexDatabase not provided; skipping gitignore reindex');
                return;
            }

            console.info('[IncrementalIndexer] Detected .gitignore change; re-evaluating indexed files...');
            this.setActivity('gitignore_reindex', 'Re-evaluating ignore rules');

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
                if (this.shouldIgnore(fullPath)) continue;

                if (entry.isDirectory()) {
                    stack.push(fullPath);
                } else if (this.symbolIndex.isSupported(fullPath)) {
                    // Check if already in index
                    const relPath = path.relative(this.rootPath, fullPath);
                    const existing = this.indexDatabase?.getFile(relPath);
                    if (!existing) {
                        newFiles.push(fullPath);
                    }
                }
            }
            await this.sleep(0);
        }
        return newFiles;
    }

    private registerConfigurationEvents(): void {
        if (!this.configurationManager || this.configEventsRegistered) return;

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

        // Debounce config reload
        if (this.moduleConfigReloadPromise) return;
        this.moduleConfigReloadPromise = this.performModuleConfigReload(filePath).finally(() => {
            this.moduleConfigReloadPromise = undefined;
        });
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
        try {
                        if (!this.isWithinRoot(filePath)) return;
            const absolutePath = path.resolve(filePath);
            this.removeFromQueues(absolutePath);

            // Tier 3: Ghost Archeology - Register symbols from deleted file as ghosts
            if (this.indexDatabase) {
                const relativePath = path.relative(this.rootPath, absolutePath).replace(/\\\\/g, '/');
                const symbols = this.indexDatabase.readSymbols(relativePath);
                if (symbols && symbols.length > 0) {
                    for (const symbol of symbols) {
                        this.indexDatabase.addGhost({
                            name: symbol.name,
                            lastSeenPath: relativePath,
                            type: symbol.type,
                            lastKnownSignature: 'signature' in symbol ? symbol.signature : undefined,
                            deletedAt: Date.now()
                        });
                    }
                }
            }

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
        try {
            if (!this.isWithinRoot(dirPath)) return;
            const normalizedDir = path.resolve(dirPath);
            this.removeMatchingFromQueues(queued => queued.startsWith(normalizedDir));

            await this.dependencyGraph.removeDirectory(dirPath);
        } catch (error) {
            console.warn(`[IncrementalIndexer] failed to remove directory ${dirPath}:`, error);
        }
    }

    private shouldIgnore(absolutePath: string): boolean {
        if (!this.isWithinRoot(absolutePath)) return true;
        const relative = path.relative(this.rootPath, absolutePath);
        
        // HardcodedMCP ignore
        const normalized = relative.split(path.sep).join('/');
        const ignoredRoots = ['.mcp', '.smart-context', '.smart-context-index'];
        if (ignoredRoots.some(root => normalized === root || normalized.startsWith(`${root}/`))) {
            return true;
        }

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
        let entries: string[] = [];
        
        entries = entries.concat(this.flushQueue('high'));
        if (entries.length >= 50) return entries;

        entries = entries.concat(this.flushQueue('medium'));
        if (entries.length >= 100) return entries;

        entries = entries.concat(this.flushQueue('low'));
        return entries;
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
        return { high, medium, low, total: high + medium + low };
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

    private async batchShouldReindex(files: string[]): Promise<string[]> {
        const results = await Promise.all(
            files.map(async file => {
                if (this.stopped) {
                    return null;
                }

                const needsReindex = await this.shouldReindex(file);
                return needsReindex ? file : null;
            })
        );

        return results.filter((filePath): filePath is string => filePath !== null);
    }

    private async shouldReindex(filePath: string): Promise<boolean> {
        if (!this.currentIndex) return true;

        // Normalize path to match keys in currentIndex.files
        let normalized = path.resolve(filePath);
        try {
            normalized = await fs.promises.realpath(normalized);
        } catch {
            normalized = path.resolve(filePath);
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

        const restorePromises = Object.entries(index.files).map(([filePath, entry]) => {
            const resolvedEdges = entry.imports
                ?.filter(imp => !!imp.resolvedPath)
                .map(imp => ({
                    from: filePath,
                    to: imp.resolvedPath!,
                    type: 'import' as const,
                    what: imp.what.join(', '),
                    line: imp.line
                })) ?? [];

            return Promise.all([
                Promise.resolve(this.symbolIndex.restoreFromCache(filePath, entry.symbols, entry.mtime)),
                resolvedEdges.length > 0
                    ? this.dependencyGraph.restoreEdges(filePath, resolvedEdges)
                    : Promise.resolve()
            ]);
        });

        await Promise.all(restorePromises);

        console.log('[IncrementalIndexer] Restore complete');
    }

    private debouncedPersist = debounce(async () => {
        if (this.currentIndex) {
            await this.indexManager.persistIndex(this.currentIndex);
        }
    }, 5000); // Wait 5 seconds after last change

    private startPeriodicPersistence(): void {
        // Wait 5 seconds after last change
        if (this.periodicPersistenceTimer) {
            clearInterval(this.periodicPersistenceTimer);
        }
        this.periodicPersistenceTimer = setInterval(async () => {
            if (this.currentIndex && !this.stopped) {
                await this.indexManager.persistIndex(this.currentIndex);
            }
        }, 5 * 60 * 1000);
        this.periodicPersistenceTimer.unref?.();
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
        timeout.unref?.();
    };

    debounced.cancel = () => {
        if (timeout) clearTimeout(timeout);
    };

    return debounced;
}
