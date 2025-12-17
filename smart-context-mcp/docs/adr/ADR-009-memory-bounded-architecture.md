# ADR-009: Memory-Bounded Architecture for Large Projects

## Status
**Proposed** | 2024-12-11

## Context

### Problem Statement
smart-context-mcp experiences Out-of-Memory (OOM) crashes on large projects (>2GB source, monorepos with 50k+ files) due to:

1. **Unbounded In-Memory Caching**: Multiple Maps grow indefinitely
   - `SymbolIndex.cache`: Stores full AST symbols per file (no eviction)
   - `TrigramIndex.fileEntries` + `postings`: O(files × trigrams) memory
   - `DependencyGraph` edge maps: O(edges²) worst-case
   - `ClusterCache`: Stores full cluster responses

2. **Eager Startup Precomputation**: 
   - `HotSpotDetector.detectHotSpots()` calls `symbolIndex.getAllSymbols()` → full scan
   - `TrigramIndex.buildIndex()` walks entire tree synchronously
   - `DependencyGraph.build()` parses all files upfront

3. **Full AST Parsing**: `SkeletonGenerator` parses complete files even for simple queries

### Current Memory Profile (Estimated)
| Component | Memory per 10k files | Scaling |
|-----------|---------------------|---------|
| SymbolIndex | ~200MB | O(n × symbols) |
| TrigramIndex | ~500MB | O(n × avg_trigrams) |
| DependencyGraph | ~100MB | O(edges) |
| ClusterCache | ~50MB | O(queries × cluster_size) |
| **Total baseline** | **~850MB** | **Linear+** |

With 50k files, projected usage exceeds 4GB, triggering OOM.

## Decision

Implement a **tiered memory architecture** with hard memory caps, lazy loading, and intelligent eviction.

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    Memory Budget Controller                      │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Target: 1.5GB soft / 2GB hard limit                     │   │
│  │  Monitors: process.memoryUsage().heapUsed                │   │
│  └──────────────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────────────┤
│                         Tier 1: Hot Cache                        │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐                   │
│  │SymbolIndex │ │TrigramIndex│ │ClusterCache│  ← LRU bounded    │
│  │  (200MB)   │ │  (300MB)   │ │  (100MB)   │                   │
│  └────────────┘ └────────────┘ └────────────┘                   │
├─────────────────────────────────────────────────────────────────┤
│                    Tier 2: Warm Index (Disk)                     │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  SQLite/LevelDB persistent store                          │   │
│  │  - Symbol definitions (file → symbols JSON)               │   │
│  │  - Trigram postings (trigram → file list)                 │   │
│  │  - Dependency edges (source → targets)                    │   │
│  └──────────────────────────────────────────────────────────┘   │
├─────────────────────────────────────────────────────────────────┤
│                    Tier 3: Cold (On-Demand)                      │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Files not yet indexed - parsed on first access           │   │
│  └──────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────┘
```

## Detailed Changes

### 1. Memory Budget Controller (New)

```typescript
// src/engine/MemoryBudget.ts
interface MemoryBudgetConfig {
  softLimitMB: number;    // Default: 1500
  hardLimitMB: number;    // Default: 2000
  checkIntervalMs: number; // Default: 5000
}

class MemoryBudgetController {
  private subscribers: Map<string, EvictableCache>;
  
  register(name: string, cache: EvictableCache, priority: number): void;
  
  // Called periodically or on allocation pressure
  async enforceLimit(): Promise<void> {
    const usage = process.memoryUsage().heapUsed / 1024 / 1024;
    if (usage > this.config.softLimitMB) {
      await this.evictByPriority(usage - this.config.softLimitMB * 0.8);
    }
  }
}

interface EvictableCache {
  getMemoryEstimate(): number;
  evict(targetBytes: number): Promise<number>; // Returns bytes freed
}
```

### 2. LRU-Bounded SymbolIndex

**Before:**
```typescript
// Unbounded Map
private cache = new Map<string, { mtime: number; symbols: SymbolInfo[] }>();
```

**After:**
```typescript
// src/ast/SymbolIndex.ts
interface SymbolCacheConfig {
  maxEntries: number;      // Default: 5000 files
  maxMemoryMB: number;     // Default: 200
  persistPath?: string;    // Optional disk backing
}

class SymbolIndex implements EvictableCache {
  private cache: LRUCache<string, CacheEntry>;
  private persistentStore?: PersistentSymbolStore;
  
  async getSymbolsForFile(filePath: string): Promise<SymbolInfo[]> {
    // 1. Check hot cache
    const cached = this.cache.get(relativePath);
    if (cached && cached.mtime === currentMtime) return cached.symbols;
    
    // 2. Check persistent store (if enabled)
    if (this.persistentStore) {
      const persisted = await this.persistentStore.get(relativePath, currentMtime);
      if (persisted) {
        this.cache.set(relativePath, persisted); // Promote to hot
        return persisted.symbols;
      }
    }
    
    // 3. Parse and cache
    const symbols = await this.parseFile(filePath, content);
    this.cache.set(relativePath, { mtime: currentMtime, symbols });
    this.persistentStore?.set(relativePath, currentMtime, symbols);
    return symbols;
  }
  
  // Called by MemoryBudgetController
  async evict(targetBytes: number): Promise<number> {
    let freed = 0;
    while (freed < targetBytes && this.cache.size > 100) {
      const oldest = this.cache.oldest();
      freed += this.estimateEntrySize(oldest);
      this.cache.delete(oldest.key);
    }
    return freed;
  }
}
```

### 3. Streaming TrigramIndex

**Before:**
```typescript
// Loads all trigrams into memory at startup
private async buildIndex(): Promise<void> {
  await this.walk(this.rootPath); // Synchronous full scan
}
```

**After:**
```typescript
// src/engine/TrigramIndex.ts
class TrigramIndex implements EvictableCache {
  private hotPostings: LRUCache<string, Map<string, number>>; // Trigram → file frequencies
  private fileIndex: LRUCache<string, FileEntry>;
  private persistentStore?: LevelDBTrigramStore;
  private indexedPaths = new Set<string>(); // Track what's indexed
  
  constructor(config: TrigramIndexConfig) {
    this.hotPostings = new LRUCache({
      max: config.maxTrigramsInMemory ?? 100000, // ~50MB
      sizeCalculation: (v) => v.size * 50 // ~50 bytes per posting
    });
  }
  
  // Lazy indexing - only index on first search
  async search(term: string, limit: number): Promise<SearchCandidate[]> {
    const trigrams = this.extractTrigramCounts(term);
    
    for (const [trigram] of trigrams) {
      if (!this.hotPostings.has(trigram)) {
        // Load from persistent store or mark for background indexing
        const persisted = await this.persistentStore?.getPosting(trigram);
        if (persisted) {
          this.hotPostings.set(trigram, persisted);
        }
      }
    }
    
    // ... rest of search logic
  }
  
  // Background incremental indexing
  async indexIncrementally(batchSize: number = 100): Promise<boolean> {
    const unindexed = await this.findUnindexedFiles(batchSize);
    for (const file of unindexed) {
      await this.indexFile(file);
      this.indexedPaths.add(file);
    }
    return unindexed.length === batchSize; // More work remaining
  }
}
```

### 4. Lazy DependencyGraph

**Before:**
```typescript
// Full graph built on first getDependencies call
public async getDependencies(filePath: string, direction: 'incoming' | 'outgoing'): Promise<string[]> {
  if (this.needsRebuild || (this.outgoingEdges.size === 0)) {
    await this.build(); // Parses ALL files
  }
}
```

**After:**
```typescript
// src/ast/DependencyGraph.ts
class DependencyGraph implements EvictableCache {
  private localEdges: LRUCache<string, { incoming: Set<string>; outgoing: Set<string> }>;
  private persistentStore?: PersistentDependencyStore;
  private fullyIndexed = new Set<string>();
  
  async getDependencies(filePath: string, direction: 'incoming' | 'outgoing'): Promise<string[]> {
    const normalized = this.normalizePath(filePath);
    
    // Check if file is locally cached
    const local = this.localEdges.get(normalized);
    if (local && this.fullyIndexed.has(normalized)) {
      return Array.from(direction === 'outgoing' ? local.outgoing : local.incoming);
    }
    
    // Check persistent store
    if (this.persistentStore) {
      const persisted = await this.persistentStore.getEdges(normalized);
      if (persisted) {
        this.localEdges.set(normalized, persisted);
        this.fullyIndexed.add(normalized);
        return Array.from(direction === 'outgoing' ? persisted.outgoing : persisted.incoming);
      }
    }
    
    // Index just this file (and its imports)
    await this.indexFileAndImports(normalized);
    return this.getDependencies(filePath, direction); // Recurse
  }
  
  private async indexFileAndImports(filePath: string): Promise<void> {
    const symbols = await this.symbolIndex.getSymbolsForFile(filePath);
    const outgoing = new Set<string>();
    const incoming = this.localEdges.get(filePath)?.incoming ?? new Set();
    
    for (const symbol of symbols) {
      if (symbol.type === 'import') {
        const resolved = this.resolver.resolve(filePath, symbol.source);
        if (resolved) {
          outgoing.add(resolved);
          // Update reverse edge lazily
          this.addIncomingEdge(resolved, filePath);
        }
      }
    }
    
    this.localEdges.set(filePath, { incoming, outgoing });
    this.fullyIndexed.add(filePath);
    this.persistentStore?.setEdges(filePath, { incoming, outgoing });
  }
}
```

### 5. Deferred HotSpot Detection

**Before:**
```typescript
// Scans ALL symbols at startup
async detectHotSpots(): Promise<HotSpot[]> {
  const allSymbols = await this.symbolIndex.getAllSymbols(); // OOM trigger!
}
```

**After:**
```typescript
// src/engine/ClusterSearch/HotSpotDetector.ts
class HotSpotDetector {
  private cachedHotSpots: HotSpot[] = [];
  private lastComputedAt = 0;
  private computeInProgress = false;
  
  async detectHotSpots(): Promise<HotSpot[]> {
    // Return cached if fresh (< 5 minutes)
    if (Date.now() - this.lastComputedAt < 5 * 60 * 1000) {
      return this.cachedHotSpots;
    }
    
    // Use sampling strategy instead of full scan
    return this.detectHotSpotsSampled();
  }
  
  private async detectHotSpotsSampled(): Promise<HotSpot[]> {
    const candidates: HotSpot[] = [];
    
    // Strategy 1: Recently modified files (git-based)
    const recentFiles = await this.getRecentlyModifiedFiles(100);
    for (const file of recentFiles) {
      const symbols = await this.symbolIndex.getSymbolsForFile(file);
      candidates.push(...this.scoreSymbols(file, symbols));
    }
    
    // Strategy 2: Entry points (index.ts, main.ts, etc.)
    const entryPoints = await this.findEntryPoints();
    for (const file of entryPoints) {
      const symbols = await this.symbolIndex.getSymbolsForFile(file);
      candidates.push(...this.scoreSymbols(file, symbols));
    }
    
    // Strategy 3: Files with most imports (hub files)
    const hubFiles = await this.findHubFiles(50);
    // ... similar scoring
    
    this.cachedHotSpots = candidates.sort((a, b) => b.score - a.score).slice(0, 30);
    this.lastComputedAt = Date.now();
    return this.cachedHotSpots;
  }
  
  private async getRecentlyModifiedFiles(limit: number): Promise<string[]> {
    // Use git log or mtime sorting
    const { stdout } = await exec('git log --name-only --pretty=format: -n 200');
    const files = [...new Set(stdout.split('\n').filter(f => f))];
    return files.slice(0, limit);
  }
}
```

### 6. Bounded ClusterCache with Disk Spillover

```typescript
// src/engine/ClusterSearch/ClusterCache.ts
interface ClusterCacheConfig {
  maxMemoryMB: number;     // Default: 100
  maxEntries: number;      // Default: 50
  diskCachePath?: string;  // Optional disk backing
}

class ClusterCache implements EvictableCache {
  private memoryCache: LRUCache<string, CacheEntry>;
  private diskCache?: DiskLRUCache;
  
  storeResponse(query: string, options: CacheableSearchOptions, response: ClusterSearchResponse): void {
    const entry = this.buildEntry(query, options, response);
    const size = this.estimateSize(entry);
    
    // If too large for memory, store on disk only
    if (size > this.config.maxMemoryMB * 1024 * 1024 * 0.1) {
      this.diskCache?.set(cacheKey, entry);
      return;
    }
    
    this.memoryCache.set(cacheKey, entry);
    this.diskCache?.set(cacheKey, entry); // Write-through
  }
  
  getCachedResponse(query: string, options: CacheableSearchOptions): CacheEntry | null {
    const cacheKey = this.buildCacheKey(query, options);
    
    // Check memory first
    const memEntry = this.memoryCache.get(cacheKey);
    if (memEntry) return memEntry;
    
    // Check disk
    const diskEntry = this.diskCache?.get(cacheKey);
    if (diskEntry) {
      this.memoryCache.set(cacheKey, diskEntry); // Promote
      return diskEntry;
    }
    
    return null;
  }
}
```

## Implementation Phases

### Phase 1: Memory Caps (Week 1-2)
- [ ] Add `MemoryBudgetController`
- [ ] Convert `SymbolIndex.cache` to LRU with 5000 entry cap
- [ ] Convert `ClusterCache` to LRU with 100MB cap
- [ ] Add memory monitoring logging

### Phase 2: Lazy Loading (Week 3-4)
- [ ] Implement lazy `DependencyGraph.indexFileAndImports()`
- [ ] Implement sampled `HotSpotDetector`
- [ ] Add incremental `TrigramIndex.indexIncrementally()`
- [ ] Defer startup scans to background

### Phase 3: Persistence Layer (Week 5-6)
- [ ] Add SQLite or LevelDB persistent store
- [ ] Implement `PersistentSymbolStore`
- [ ] Implement `PersistentDependencyStore`
- [ ] Add disk-backed trigram postings

### Phase 4: Optimization (Week 7-8)
- [ ] Profile and tune LRU sizes
- [ ] Add adaptive eviction based on usage patterns
- [ ] Implement cache warming for frequently accessed files
- [ ] Benchmark against monorepo test cases

## Performance Considerations

### Search Latency Impact
| Scenario | Before | After (Cold) | After (Warm) |
|----------|--------|--------------|--------------|
| Symbol search | 50ms | 150ms | 30ms |
| Trigram search | 100ms | 300ms | 80ms |
| Dependency lookup | 20ms | 100ms | 15ms |

**Mitigation:**
- Maintain "hot file" tracking based on access patterns
- Pre-warm cache with recently modified files on startup
- Use background indexing during idle time

### Hot File Optimization
```typescript
class HotFileTracker {
  private accessCounts = new Map<string, number>();
  private recentAccess: string[] = []; // Ring buffer
  
  recordAccess(filePath: string): void {
    this.accessCounts.set(filePath, (this.accessCounts.get(filePath) ?? 0) + 1);
    this.recentAccess.push(filePath);
    if (this.recentAccess.length > 1000) this.recentAccess.shift();
  }
  
  getHotFiles(limit: number): string[] {
    return [...this.accessCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([path]) => path);
  }
}
```

## Alternatives Considered

### 1. External Search Service (Elasticsearch/Meilisearch)
- **Pros:** Unlimited scale, advanced search features
- **Cons:** External dependency, deployment complexity, latency
- **Decision:** Rejected for simplicity; MCP should be self-contained

### 2. Memory-Mapped Files
- **Pros:** OS-managed paging, simple API
- **Cons:** Platform differences, complex for structured data
- **Decision:** Rejected; LevelDB provides better guarantees

### 3. Full Disk-Only Index
- **Pros:** Minimal memory usage
- **Cons:** Poor latency for all operations
- **Decision:** Rejected; tiered approach preserves hot-path performance

## Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Regression in hot-file latency | Medium | High | Maintain LRU for frequently accessed files; benchmark continuously |
| Disk I/O bottleneck | Low | Medium | Use async I/O; batch writes; SSD recommended |
| Complex state management | Medium | Medium | Clear cache invalidation rules; thorough testing |
| Persistence format migration | Low | Low | Version schema; add migration tooling |

## Success Metrics

1. **Memory Usage**: Peak heap < 2GB on 50k file monorepo
2. **Startup Time**: Cold start < 5s (vs current ~30s on large repos)
3. **Search Latency**: 
   - Hot files: < 50ms (no regression)
   - Cold files: < 500ms (acceptable for first access)
4. **OOM Incidents**: Zero under normal operation

## References

- [LRU Cache Implementation](https://github.com/isaacs/node-lru-cache)
- [LevelDB Node Bindings](https://github.com/Level/level)
- [Node.js Memory Management](https://nodejs.org/api/process.html#processmemoryusage)
