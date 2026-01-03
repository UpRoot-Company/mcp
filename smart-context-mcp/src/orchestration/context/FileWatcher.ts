import * as chokidar from 'chokidar';
import { UnifiedContextGraph } from './UnifiedContextGraph.js';
import { FeatureFlags } from '../../config/FeatureFlags.js';

/**
 * File watcher for automatic UCG invalidation on file changes.
 */
export class FileWatcher {
    private watcher?: chokidar.FSWatcher;
    private ucg: UnifiedContextGraph;
    private rootPath: string;
    private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
    private readonly DEBOUNCE_MS = 100;
    
    constructor(ucg: UnifiedContextGraph, rootPath: string) {
        this.ucg = ucg;
        this.rootPath = rootPath;
    }
    
    start(): void {
        if (this.watcher || !FeatureFlags.isEnabled(FeatureFlags.ADAPTIVE_FLOW_ENABLED)) return;
        
        console.log('[FileWatcher] Starting file watcher in: ' + this.rootPath);
        
        this.watcher = chokidar.watch(this.rootPath, {
            ignored: [
                '**/node_modules/**',
                '**/.git/**',
                '**/.smart-context/**',
                '**/dist/**',
                '**/build/**'
            ],
            persistent: true,
            ignoreInitial: true
        });
        
        this.watcher
            .on('change', (path) => this.handleFileChange(path, 'change'))
            .on('unlink', (path) => this.handleFileChange(path, 'delete'))
            .on('add', (path) => this.handleFileChange(path, 'add'));
    }
    
    async stop(): Promise<void> {
        if (this.watcher) {
            await this.watcher.close();
            this.watcher = undefined;
        }
        for (const timer of this.debounceTimers.values()) clearTimeout(timer);
        this.debounceTimers.clear();
    }
    
    private handleFileChange(filePath: string, event: 'change' | 'delete' | 'add'): void {
        const existing = this.debounceTimers.get(filePath);
        if (existing) clearTimeout(existing);
        
        const timer = setTimeout(() => {
            this.processChange(filePath, event);
            this.debounceTimers.delete(filePath);
        }, this.DEBOUNCE_MS);
        
        this.debounceTimers.set(filePath, timer);
    }
    
    private processChange(filePath: string, event: 'change' | 'delete' | 'add'): void {
        const node = this.ucg.getNode(filePath);
        if (!node) return;
        
        if (event === 'delete') {
            console.log('[FileWatcher] Removing node: ' + filePath);
            // UnifiedContextGraph에 removeNode 구현 필요
            (this.ucg as any).removeNode?.(filePath);
        } else if (event === 'change') {
            console.log('[FileWatcher] Invalidating node: ' + filePath);
            this.ucg.invalidate(filePath, true);
        }
    }
}
