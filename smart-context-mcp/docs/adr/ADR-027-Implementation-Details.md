# ADR 027: Implementation Details & Code-Based Design

## Executive Summary

This document provides detailed implementation specifications for ADR-027, based on the actual codebase structure of `smart-context-mcp`. It outlines concrete code changes, dependencies, and integration points for Stage 1 (Immediate Critical Fixes).

---

## Current Architecture Overview

### Key Components

1. **IncrementalIndexer** (`src/indexing/IncrementalIndexer.ts`)
   - Watches file system via `chokidar`
   - Batches changes with configurable delays (50ms - 500ms)
   - Manages a queue of files to be indexed
   - Updates `SymbolIndex` and `DependencyGraph` incrementally
   - **Gap**: No `.gitignore` or `tsconfig.json` specific handling

2. **IndexDatabase** (`src/indexing/IndexDatabase.ts`)
   - SQLite-based persistent storage
   - Stores file records, symbols, dependencies, and unresolved imports
   - Provides `listFiles()`, `deleteFile()`, `replaceSymbols()`, `replaceDependencies()` methods
   - **Gap**: Missing atomic clear method for full re-index

3. **ModuleResolver** (`src/ast/ModuleResolver.ts`)
   - Resolves module imports (relative, absolute, aliases, node_modules)
   - Maintains caches: `resolutionCache`, `fileExistsCache`, `dirExistsCache`
   - Initializes `tsconfigMatchers` on construction
   - **Gap**: Has `clearCache()` but lacks config reload capability

4. **DependencyGraph** (`src/ast/DependencyGraph.ts`)
   - Builds dependency relationships from symbols
   - Handles resolution failures and unresolved imports
   - Stores data via `IndexDatabase`
   - **Gap**: Missing method to rebuild unresolved dependencies after config changes

5. **SmartContextServer** (`src/index.ts`)
   - MCP server orchestrating all components
   - `executeManageProject()` handles commands (undo, redo, guidance, status, metrics)
   - Initializes and starts `IncrementalIndexer` at startup
   - **Gap**: Missing `reindex` command for manual full re-indexing

---

## Stage 1 Implementation Specifications

### 3.1 `.gitignore` Change Detection and Index Cleanup

#### File: `src/indexing/IncrementalIndexer.ts`

**Change 1.1: Constructor Modification**

Add `IndexDatabase` parameter to constructor:

```typescript
constructor(
    private readonly rootPath: string,
    private readonly symbolIndex: SymbolIndex,
    private readonly dependencyGraph: DependencyGraph,
    private readonly indexDatabase?: IndexDatabase,  // NEW
    private readonly options: IncrementalIndexerOptions = {}
) {}
```

**Change 1.2: Add Constants**

Add after `MAX_BATCH_PAUSE_MS`:

```typescript
private static readonly IGNORE_FILE = '.gitignore';
private static readonly CONFIG_FILES = ['tsconfig.json', 'jsconfig.json', 'package.json'];
```

**Change 1.3: Enhance `start()` Method**

Add explicit watching for configuration files:

```typescript
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
        
        // NEW: Explicitly watch ignore and config files
        this.watcher.add(path.join(this.rootPath, IncrementalIndexer.IGNORE_FILE));
        IncrementalIndexer.CONFIG_FILES.forEach(file => {
            const configPath = path.join(this.rootPath, file);
            try {
                this.watcher!.add(configPath);
            } catch {
                // Config file may not exist, which is fine
            }
        });
        
        this.watcher.on('add', file => this.enqueuePath(file));
        this.watcher.on('change', file => this.handleFileChange(file));  // MODIFIED
        this.watcher.on('unlink', file => this.handleDeletion(file));
        this.watcher.on('unlinkDir', dir => this.handleDirectoryDeletion(dir));
        this.watcher.on('error', error => {
            console.warn('[IncrementalIndexer] watcher error', error);
        });
    }
}
```

**Change 1.4: Add File Change Router**

New method to route file changes:

```typescript
private async handleFileChange(filePath: string): Promise<void> {
    const basename = path.basename(filePath);
    
    if (basename === IncrementalIndexer.IGNORE_FILE) {
        await this.handleIgnoreChange();
    } else if (IncrementalIndexer.CONFIG_FILES.includes(basename)) {
        // Deferred to Stage 1.2
        // await this.handleModuleConfigChange(filePath);
    } else {
        this.enqueuePath(filePath);
    }
}
```

**Change 1.5: Implement `.gitignore` Change Handler**

New method to handle gitignore changes:

```typescript
private async handleIgnoreChange(): Promise<void> {
    if (!this.indexDatabase) {
        console.warn('[IncrementalIndexer] IndexDatabase not provided; skipping gitignore reindex');
        return;
    }
    
    console.info('[IncrementalIndexer] Detected .gitignore change; re-evaluating indexed files...');
    
    try {
        // Step 1: Get all currently indexed files
        const indexedFiles = this.indexDatabase.listFiles();
        
        // Step 2: Separate files into "should now be ignored"
        const filesToRemove: string[] = [];
        
        for (const fileRecord of indexedFiles) {
            const absolutePath = path.join(this.rootPath, fileRecord.path);
            if (this.shouldIgnore(absolutePath)) {
                filesToRemove.push(fileRecord.path);
            }
        }
        
        // Step 3: Delete files that are now ignored
        for (const relPath of filesToRemove) {
            try {
                this.indexDatabase.deleteFile(relPath);
                console.debug(`[IncrementalIndexer] Removed ignored file from index: ${relPath}`);
            } catch (error) {
                console.warn(`[IncrementalIndexer] Failed to remove ${relPath} from index:`, error);
            }
        }
        
        // Step 4: Scan file system for newly unignored files
        const newFiles = await this.scanForNewFiles();
        for (const filePath of newFiles) {
            this.enqueuePath(filePath);
        }
        
        console.info(`[IncrementalIndexer] Gitignore reindex: removed ${filesToRemove.length} files, enqueued ${newFiles.length} new files`);
    } catch (error) {
        console.error('[IncrementalIndexer] Error handling .gitignore change:', error);
    }
}
```

**Change 1.6: Add File System Scanner Helper**

Helper method for scanning new files:

```typescript
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
            
            if (this.shouldIgnore(fullPath)) {
                continue;
            }
            
            if (entry.isDirectory()) {
                stack.push(fullPath);
            } else if (this.symbolIndex.isSupported(fullPath)) {
                // Check if already indexed
                const relPath = path.relative(this.rootPath, fullPath);
                const existing = this.indexDatabase?.getFile(relPath);
                if (!existing) {
                    newFiles.push(fullPath);
                }
            }
        }
        
        await this.sleep(0);  // Allow other async operations
    }
    
    return newFiles;
}
```

#### File: `src/indexing/IndexDatabase.ts`

**Change 1.7: Add Atomic Clear Method**

New public method:

```typescript
public clearAllFiles(): void {
    const db = this.getHandle();
    try {
        db.exec('DELETE FROM symbols');
        db.exec('DELETE FROM dependencies');
        db.exec('DELETE FROM unresolved');
        db.exec('DELETE FROM files');
        console.info('[IndexDatabase] All indexed files cleared');
    } catch (error) {
        throw new Error(`Failed to clear index database: ${error instanceof Error ? error.message : String(error)}`);
    }
}
```

---

### 3.2 `tsconfig.json` / `jsconfig.json` Change Detection and Module Resolver Reset

#### File: `src/ast/ModuleResolver.ts`

**Change 2.1: Add Configuration Reload Method**

New public method:

```typescript
public reloadConfig(): void {
    console.info('[ModuleResolver] Reloading configuration...');
    
    // Clear all caches
    this.resolutionCache.clear();
    this.fileExistsCache.clear();
    this.dirExistsCache.clear();
    
    // Re-initialize tsconfig matchers
    this.tsconfigMatchers = [];
    this.initializeTsconfigMatchers();
    
    console.info('[ModuleResolver] Configuration reload complete');
}
```

**Change 2.2: Ensure Idempotency**

Verify `initializeTsconfigMatchers()` can be called multiple times safely. Check constructor to ensure matchers are properly reset.

#### File: `src/ast/DependencyGraph.ts`

**Change 2.3: Add Unresolved Dependencies Rebuild Method**

New public method:

```typescript
public async rebuildUnresolved(): Promise<void> {
    if (!this.db) {
        console.warn('[DependencyGraph] IndexDatabase not available; skipping unresolved rebuild');
        return;
    }
    
    console.info('[DependencyGraph] Rebuilding unresolved dependencies...');
    
    try {
        // Get all unresolved imports
        const unresolved = this.db.listUnresolved();
        const filePathSet = new Set<string>();
        
        for (const item of unresolved) {
            filePathSet.add(item.filePath);
        }
        
        // Re-analyze symbols for each affected file
        let rebuiltCount = 0;
        for (const filePath of filePathSet) {
            try {
                const symbols = await this.symbolIndex.getSymbolsForFile(filePath);
                if (symbols) {
                    await this.updateFileDependencies(filePath, symbols);
                    rebuiltCount++;
                }
            } catch (error) {
                console.warn(`[DependencyGraph] Failed to rebuild dependencies for ${filePath}:`, error);
            }
        }
        
        console.info(`[DependencyGraph] Rebuilt dependencies for ${rebuiltCount} files with previously unresolved imports`);
    } catch (error) {
        console.error('[DependencyGraph] Error rebuilding unresolved dependencies:', error);
    }
}
```

---

### 3.3 Manual Synchronization Command

#### File: `src/index.ts` (SmartContextServer)

**Change 3.1: Extend `executeManageProject()` with Reindex Command**

Add new case in `executeManageProject()` switch statement:

```typescript
case "reindex": {
    const startTime = Date.now();
    try {
        console.info('[SmartContextServer] Starting full project reindex...');
        
        // Step 1: Clear the IndexDatabase
        console.debug('[SmartContextServer] Clearing index database...');
        this.indexDatabase.clearAllFiles?.();
        
        // Step 2: Stop current indexer if running
        if (this.incrementalIndexer) {
            console.debug('[SmartContextServer] Stopping incremental indexer...');
            await this.incrementalIndexer.stop();
        }
        
        // Step 3: Reset module resolver configuration
        console.debug('[SmartContextServer] Reloading module resolver config...');
        this.moduleResolver.reloadConfig();
        
        // Step 4: Clear any in-memory caches
        console.debug('[SmartContextServer] Clearing caches...');
        this.callGraphBuilder.clearCaches?.();
        this.typeDependencyTracker.clearCaches?.();
        
        // Step 5: Restart incremental indexer with fresh state
        if (this.incrementalIndexer) {
            console.debug('[SmartContextServer] Starting incremental indexer for full scan...');
            this.incrementalIndexer.start();
            
            // Wait for initial scan to complete
            await this.incrementalIndexer.waitForInitialScan();
        }
        
        const elapsed = Date.now() - startTime;
        console.info(`[SmartContextServer] Full project reindex completed in ${elapsed}ms`);
        
        return {
            output: `Project re-indexed successfully in ${elapsed}ms`,
            data: {
                status: "complete",
                durationMs: elapsed,
                timestamp: new Date().toISOString()
            }
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[SmartContextServer] Reindex failed:', message);
        throw new McpError(
            ErrorCode.InternalError,
            `Re-indexing failed: ${message}`
        );
    }
}
```

**Change 3.2: Update Tool Definition**

Update tool documentation in `listIntentTools()` to include reindex command.

---

## Integration Points

### Constructor Parameters Update Chain

**File: `src/index.ts` (SmartContextServer.constructor)**

Update initialization order:

```typescript
// Ensure proper dependency chain
this.indexDatabase = new IndexDatabase(rootPath);
this.symbolIndex = new SymbolIndex(rootPath);
this.moduleResolver = new ModuleResolver(rootPath);
this.dependencyGraph = new DependencyGraph(
    rootPath, 
    this.symbolIndex, 
    this.moduleResolver, 
    this.indexDatabase
);

// Pass database and resolver to indexer
this.incrementalIndexer = new IncrementalIndexer(
    rootPath,
    this.symbolIndex,
    this.dependencyGraph,
    this.indexDatabase,  // NEW
    { watch: true, initialScan: true }
);
```

---

## Testing Strategy

### Unit Tests

1. **IncrementalIndexer**
   - Test `handleIgnoreChange()` with mock IndexDatabase
   - Test `handleFileChange()` routing logic
   - Test `scanForNewFiles()` discovery
   - Verify `.gitignore` file is explicitly watched

2. **ModuleResolver**
   - Test `reloadConfig()` clears all caches
   - Test idempotency of `initializeTsconfigMatchers()`
   - Test path alias resolution after reload

3. **DependencyGraph**
   - Test `rebuildUnresolved()` with mock unresolved list
   - Test re-resolution after config reload

4. **SmartContextServer**
   - Test `manage_project reindex` command
   - Test proper cleanup sequence
   - Test error handling and recovery

### Integration Tests

1. Modify `.gitignore` and verify file removal from index
2. Modify `tsconfig.json` with path aliases and verify re-resolution
3. Call `manage_project reindex` and verify full re-scan
4. Large project re-index performance validation

---

## Backwards Compatibility

- All changes are **additive** (new methods, new commands)
- Existing API signatures not modified (except constructor additions)
- No breaking changes to existing functionality
- Optional parameters maintain compatibility

---

## Rollout Plan

### Phase 1: Implementation
- Implement all Stage 1 code changes
- Add unit tests for individual components
- Code review and approval

### Phase 2: Integration Testing
- Run integration tests
- Performance validation
- Edge case verification

### Phase 3: Beta Deployment
- Deploy to select users
- Monitor for issues

### Phase 4: General Availability
- Full rollout
- User documentation

---

## Success Criteria

✅ `.gitignore` changes automatically purge/re-index affected files
✅ `tsconfig.json` changes trigger module resolver reload
✅ Manual `manage_project reindex` command works reliably
✅ No performance regression on large projects
✅ All unit and integration tests pass
✅ No breaking changes to existing APIs
