# ADR-022: Scalable Memory Architecture (On-Disk, Lazy, Streaming)

## 1. Context & Problem
The `smart-context-mcp` currently relies on a **fully in-memory architecture** (`Map<string, SymbolInfo[]>`, `DependencyGraph` adjacency lists). 
*   **OOM Issues:** For large monorepos (1M+ LOC), heap usage exceeds 2GB, causing crashes.
*   **Slow Startup:** The aggressive `HotSpotDetector` and full-scan indexing blocks usability for minutes.
*   **Scaling Limit:** Memory usage grows linearly `O(n)` with project size, making it unsustainable for enterprise codebases.

The user explicitly requires adopting architectural patterns from industry leaders:
*   **Google (Kythe):** On-disk indexing with memory mapping.
*   **Meta (Glean):** Lazy loading of derived facts.
*   **Sourcegraph (LSIF):** Streaming and incremental processing.

## 2. Decision
We will transition `smart-context-mcp` from an **In-Memory** to a **Disk-Backed, Hybrid** architecture using **SQLite (`better-sqlite3`)**.

### 2.1 Core Architectural Pillars

#### A. On-Disk Indexing (Google Pattern)
Instead of keeping all ASTs and Symbols in RAM, we will persist them to a local SQLite database (`.smart-context/index.db`).
*   **Why SQLite?** Single-file portability, robust SQL for complex dependency queries, and efficient B-Tree storage.
*   **Mechanism:**
    *   **Symbols Table:** Stores symbol definitions, locations, and signatures.
    *   **References Table:** Stores edges (calls, imports, inheritance).
    *   **Hot Cache:** Only the "Hot Set" (currently open files + frequent search targets) is kept in a small LRU Cache in RAM.

#### B. Lazy Loading (Meta Pattern)
We will invert the control flow from "Push" (parse everything at start) to "Pull" (parse on demand).
*   **Startup:** Zero parsing. Only initialize the DB connection.
*   **On Request:** When `read_code(fileA)` is called:
    1.  Check DB for `fileA` metadata.
    2.  If missing or stale (`mtime` check), parse `fileA` and write to DB.
    3.  Return data.
*   **Deep Analysis:** For tasks like "Find References", we only traverse the graph edges stored in DB, loading file contents only if necessary to extract snippets.

#### C. Streaming & Incremental (Sourcegraph Pattern)
Long-running tasks (e.g., "Rebuild Index", "Cluster Search") must never block the event loop or load the full dataset.
*   **Streaming:** Use async iterators to process files one by one, flushing results to DB in small batches.
*   **Incremental:** Use file system watchers (`chokidar`) to detect changes. Only re-index changed files (`dirty` list) in the background.

## 3. Technical Design

### 3.1 Data Schema (SQLite)
```sql
CREATE TABLE files (
  id INTEGER PRIMARY KEY,
  path TEXT UNIQUE,
  last_modified INTEGER,
  language TEXT
);

CREATE TABLE symbols (
  id INTEGER PRIMARY KEY,
  file_id INTEGER,
  name TEXT,
  kind TEXT,
  signature TEXT,
  range_json TEXT, -- {start: {line, char}, end: ...}
  FOREIGN KEY(file_id) REFERENCES files(id)
);

CREATE TABLE dependencies (
  source_file_id INTEGER,
  target_file_id INTEGER,
  type TEXT, -- 'import', 'call', 'inherit'
  weight INTEGER
);

-- Indices for fast lookups
CREATE INDEX idx_symbols_name ON symbols(name);
CREATE INDEX idx_deps_source ON dependencies(source_file_id);
```

### 3.2 Component Changes

| Component | Current State | New State |
|-----------|---------------|-----------|
| `SymbolIndex` | `Map<Path, Symbol[]>` | Wrapper around SQLite Queries + `LRUCache<Path, Symbol[]>` (Size: 50) |
| `DependencyGraph` | In-Memory Adjacency List | SQL Queries (`SELECT target FROM dependencies WHERE ...`) |
| `ClusterPrecompute` | Scans all files | Background Worker (Thread) processing a priority queue of dirty files |

## 4. Consequences

### Positive
*   **Memory Stability:** Heap usage remains flat (~200MB) regardless of project size.
*   **Instant Startup:** Server is ready immediately; indexing happens in background or on-demand.
*   **Persistence:** Index survives restarts. "Warm" start is instant.

### Negative
*   **Complexity:** Requires managing DB schema migrations and connection pools.
*   **I/O Latency:** First-time access to cold data involves disk I/O (though SQLite is very fast).
*   **Deployment:** Requires writing to the local file system (user must allow `.smart-context` folder).

## 5. Roadmap
1.  **Phase 1:** Setup `better-sqlite3` and define Schema.
2.  **Phase 2:** Refactor `SymbolIndex` to read/write to DB.
3.  **Phase 3:** Refactor `DependencyGraph` to use SQL queries.
4.  **Phase 4:** Implement Background Worker for incremental indexing.
