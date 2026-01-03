# ADR-009: Persistent Index Layer for Scalable Monorepo Support

## Status
**Proposed** | 2025-12-11

## Context

### Problem Statement
The current `smart-context-mcp` architecture suffers from two critical scalability issues:

1. **Memory Exhaustion (OOM)** on large projects (1M+ LOC monorepos)
2. **Linear Startup Time** — indexing scales O(n) with project size

### Root Cause Analysis

| Component | Memory Footprint | Startup Cost |
|-----------|------------------|--------------|
| `TrigramIndex.postings` | `Map<trigram, Map<file, freq>>` — unbounded growth | Full recursive walk + file reads |
| `SymbolIndex.cache` | `Map<file, {mtime, symbols[]}>` — retains all parsed ASTs | Lazy but fills on first search |
| `DependencyGraph.edges` | `Map<file, Set<file>>` × 2 (in/out) | Requires full symbol resolution |
| `ClusterCache` | In-memory response cache (TTL-based) | N/A |

For a 10K-file TypeScript monorepo:
- Trigram postings: ~300MB (est. 30KB/file average)
- Symbol cache: ~150MB (AST retention)
- Dependency edges: ~50MB
- **Total baseline: ~500MB before any queries**

Scaling to 50K files pushes beyond 2GB, triggering Node.js heap exhaustion.

### Current Mitigations (Band-Aids)
- `ClusterCache` with `maxEntries: 50` + TTL eviction
- `maxFileBytes: 512KB` limit in TrigramIndex
- Environment flag `SMART_CONTEXT_DISABLE_PRECOMPUTE`

These do not address the fundamental issue: **all index data lives in process memory**.

## Decision

Adopt a **three-tier persistent index architecture** inspired by Google/Meta/Sourcegraph patterns:

```
┌─────────────────────────────────────────────────────────────┐
│                     HOT TIER (In-Memory)                    │
│  • LRU Cache (configurable size, default 50MB)              │
│  • Recently accessed files, symbols, query results          │
│  • Working set estimation via access frequency              │
└──────────────────────────┬──────────────────────────────────┘
                           │ cache miss
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                    WARM TIER (SQLite)                       │
│  • Persistent on-disk index database                        │
│  • Tables: trigrams, symbols, edges, file_metadata          │
│  • FTS5 for full-text search, B-tree for lookups            │
│  • Memory-mapped I/O for sub-ms random access               │
└──────────────────────────┬──────────────────────────────────┘
                           │ not indexed
                           ▼
┌─────────────────────────────────────────────────────────────┐
│                   COLD TIER (On-Demand)                     │
│  • File system reads for unindexed/stale files              │
│  • Lazy AST parsing only when accessed                      │
│  • Background indexing via worker threads                   │
└─────────────────────────────────────────────────────────────┘
```

### Core Components

#### 1. Persistent Index Store (`IndexStore`)
```typescript
interface IndexStore {
  // Trigram operations
  getTrigramPostings(trigram: string): Promise<Map<string, number>>;
  upsertTrigramPostings(file: string, trigrams: Map<string, number>): Promise<void>;
  
  // Symbol operations
  getSymbols(file: string): Promise<SymbolInfo[]>;
  upsertSymbols(file: string, symbols: SymbolInfo[], mtime: number): Promise<void>;
  searchSymbols(query: string, limit: number): Promise<SymbolSearchResult[]>;
  
  // Dependency graph
  getEdges(file: string, direction: 'in' | 'out'): Promise<string[]>;
  upsertEdges(file: string, outgoing: string[]): Promise<void>;
  
  // Metadata
  getFileMeta(file: string): Promise<{ mtime: number; hash: string } | null>;
  markStale(file: string): Promise<void>;
}
```

#### 2. LRU Memory Cache (`HotCache`)
```typescript
interface HotCacheConfig {
  maxSizeBytes: number;     // Default: 50MB
  maxEntries: number;       // Default: 1000 files
  ttlMs: number;            // Default: 5 minutes
  evictionPolicy: 'lru' | 'lfu' | 'arc';
}

class HotCache<K, V> {
  get(key: K): V | undefined;
  set(key: K, value: V, sizeBytes: number): void;
  invalidate(key: K): void;
  invalidatePrefix(prefix: string): void;  // For directory invalidation
  getStats(): { hits: number; misses: number; evictions: number };
}
```

#### 3. Streaming Indexer (`IncrementalIndexer`)
```typescript
interface IndexerConfig {
  batchSize: number;        // Files per batch (default: 100)
  yieldIntervalMs: number;  // Yield to event loop (default: 10ms)
  workerCount: number;      // Parallel workers (default: CPU cores - 1)
  priorityQueue: boolean;   // Prioritize recently accessed paths
}

class IncrementalIndexer {
  // Non-blocking startup
  startBackgroundIndex(): void;
  
  // Priority indexing for accessed files
  prioritize(files: string[]): void;
  
  // Progress reporting
  onProgress(callback: (indexed: number, total: number) => void): void;
  
  // File watcher integration
  handleFileChange(event: 'add' | 'change' | 'unlink', path: string): void;
}
```

### Database Schema (SQLite)

```sql
-- File metadata for staleness detection
CREATE TABLE files (
  path TEXT PRIMARY KEY,
  mtime INTEGER NOT NULL,
  size INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  indexed_at INTEGER NOT NULL
);

-- Trigram postings (inverted index)
CREATE TABLE trigram_postings (
  trigram TEXT NOT NULL,
  file_path TEXT NOT NULL,
  frequency INTEGER NOT NULL,
  PRIMARY KEY (trigram, file_path)
);
CREATE INDEX idx_trigram ON trigram_postings(trigram);

-- Symbol index with FTS5 for fuzzy search
CREATE VIRTUAL TABLE symbols_fts USING fts5(
  name, 
  type,
  signature,
  file_path,
  content='symbols',
  content_rowid='rowid'
);

CREATE TABLE symbols (
  rowid INTEGER PRIMARY KEY,
  file_path TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  signature TEXT,
  start_line INTEGER,
  end_line INTEGER,
  start_byte INTEGER,
  end_byte INTEGER,
  content TEXT
);

-- Dependency edges
CREATE TABLE edges (
  source_path TEXT NOT NULL,
  target_path TEXT NOT NULL,
  edge_type TEXT DEFAULT 'import',
  PRIMARY KEY (source_path, target_path)
);
CREATE INDEX idx_edge_target ON edges(target_path);

-- Query result cache (optional)
CREATE TABLE query_cache (
  query_hash TEXT PRIMARY KEY,
  result_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  hit_count INTEGER DEFAULT 0
);
```

### Migration Strategy

#### Phase 1: Parallel Implementation (Week 1-2)
- Implement `IndexStore` with SQLite backend using `better-sqlite3`
- Add feature flag: `SMART_CONTEXT_PERSISTENT_INDEX=true`
- Both systems run in parallel; validate consistency

#### Phase 2: Hot Cache Integration (Week 3)
- Implement `HotCache` with configurable memory limits
- Wire existing code paths through cache → store → cold fallback
- Add metrics collection for cache effectiveness

#### Phase 3: Streaming Indexer (Week 4)
- Replace synchronous `walk()` with generator-based streaming
- Implement worker thread pool for parallel AST parsing
- Add priority queue for recently accessed files

#### Phase 4: Deprecation (Week 5-6)
- Make persistent index the default
- Remove in-memory-only code paths
- Performance benchmarking and tuning

### API Changes

```typescript
// New constructor signature
class SmartContextServer {
  constructor(
    rootPath: string,
    options?: {
      fileSystem?: IFileSystem;
      indexConfig?: {
        persistent?: boolean;           // Default: true
        dbPath?: string;                 // Default: .mcp/index.db
        hotCacheSize?: number;           // Default: 50MB
        backgroundIndexing?: boolean;   // Default: true
      };
    }
  );
}

// New environment variables
SMART_CONTEXT_INDEX_DB_PATH=.mcp/index.db
SMART_CONTEXT_HOT_CACHE_MB=50
SMART_CONTEXT_WORKER_THREADS=4
SMART_CONTEXT_INDEX_BATCH_SIZE=100
```

## Consequences

### Positive
- **Memory footprint drops 80-90%** (from ~500MB to ~50MB for 10K files)
- **Startup time becomes O(1)** — index persists across restarts
- **Scales to 1M+ LOC** within 2GB RAM constraint
- **Incremental updates** — only changed files re-indexed
- **Crash recovery** — index survives process termination

### Negative
- **New dependency**: `better-sqlite3` (native module, ~5MB)
- **Initial index build** still requires full scan (one-time cost)
- **Disk I/O** for cache misses (mitigated by memory-mapped files)
- **Schema migrations** needed for future index changes

### Neutral
- `.mcp/index.db` added to typical `.gitignore` patterns
- Query latency for hot files unchanged; cold files add ~1-5ms
- Worker threads increase CPU utilization during indexing

## Performance Targets

| Metric | Current | Target |
|--------|---------|--------|
| Memory (10K files) | ~500MB | <100MB |
| Memory (50K files) | OOM | <150MB |
| Startup (10K files) | ~15s | <500ms |
| Search latency (hot) | <50ms | <50ms |
| Search latency (cold) | N/A | <100ms |
| Index rebuild (full) | N/A | <5min for 50K files |

## Alternatives Considered

### 1. LevelDB Instead of SQLite
- **Pros**: Simpler key-value model, no SQL overhead
- **Cons**: No FTS5, harder to query relationships, less tooling
- **Decision**: SQLite's query flexibility and FTS5 outweigh simplicity gains

### 2. Separate Index Process (LSP-style)
- **Pros**: Complete memory isolation, language-agnostic
- **Cons**: IPC overhead, deployment complexity, harder debugging
- **Decision**: Too much architectural change; in-process SQLite sufficient

### 3. Memory-Mapped File for Custom Format
- **Pros**: Maximum control, no dependencies
- **Cons**: Custom serialization, corruption risks, maintenance burden
- **Decision**: SQLite provides same benefits with battle-tested reliability

### 4. External Search Service (Elasticsearch/Meilisearch)
- **Pros**: Proven scale, rich query language
- **Cons**: Deployment dependency, network latency, overkill for local use
- **Decision**: Not suitable for local-first MCP server

## Implementation Notes

### SQLite Configuration for Performance
```typescript
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');          // Write-ahead logging
db.pragma('synchronous = NORMAL');        // Faster writes, safe enough
db.pragma('cache_size = -64000');         // 64MB page cache
db.pragma('mmap_size = 268435456');       // 256MB memory-mapped I/O
db.pragma('temp_store = MEMORY');         // In-memory temp tables
```

### File Watcher Integration
```typescript
// Existing ClusterSearchEngine.invalidateFile() hooks into:
this.indexStore.markStale(absPath);
this.hotCache.invalidate(absPath);
this.incrementalIndexer.prioritize([absPath]);
```

### Graceful Degradation
If SQLite fails to initialize (permissions, disk full):
1. Log warning
2. Fall back to in-memory mode
3. Set `persistent: false` in runtime config
4. Continue with degraded scalability

## References

- [Sourcegraph Architecture](https://handbook.sourcegraph.com/departments/engineering/dev/architecture/)
- [SQLite FTS5 Documentation](https://www.sqlite.org/fts5.html)
- [better-sqlite3 Performance](https://github.com/WiseLibs/better-sqlite3/blob/master/docs/performance.md)
- [Google Code Search Paper](https://static.googleusercontent.com/media/research.google.com/en//pubs/archive/45728.pdf)

## Appendix: Memory Estimation Formula

```
Hot Cache: configurable (default 50MB)
SQLite Page Cache: 64MB (pragma)
SQLite MMAP: up to 256MB (OS-managed, shared)
Working Buffers: ~10MB (batch processing)
─────────────────────────────────────────
Total Process Memory: ~130MB baseline + working set
```

For 50K files with 10% hot working set (5K files):
- Hot cache: 50MB
- SQLite overhead: ~20MB
- AST parsing buffers: ~30MB (transient)
- **Total: ~100MB** vs current ~2.5GB extrapolated
