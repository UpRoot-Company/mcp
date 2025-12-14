# Smart Context Architecture for AI Agents

**Technical deep dive into the Scout → Read → Edit pipeline architecture.**

---

## Overview

Smart Context implements a three-stage pipeline optimized for AI agents working with large codebases:

```
┌──────────────────────────────────────────────────────────────┐
│                   Scout → Read → Edit Pipeline              │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  SCOUT                   READ                      EDIT      │
│  (locate)               (understand)            (modify)     │
│                                                              │
│  • BM25F ranking        • Skeleton view        • Normalization
│  • Trigram filtering    • Full content        • Fuzzy matching
│  • Type-aware search    • AST analysis        • Transactions
│                         • Metadata            • Safety verify
│                         • Dependencies        • Rollback
│                                                              │
│  P50: 200ms            P50: 100-300ms        P50: 100-500ms │
│  Token: 800-2K         Token: 200-5K         Token: 500-2K  │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

**Design Goals:**
- **Token Efficiency:** 95-98% savings via skeleton views
- **Correctness:** Transactional semantics with rollback
- **Safety:** Multi-level normalization with confidence scoring
- **Speed:** SQLite indexing with LRU caching
- **Resilience:** Crash recovery via transaction logs

---

## Stage 1: Scout (Search & Discovery)

### BM25F Ranking Algorithm

The foundation of fast search across large codebases. Each symbol definition, export, comment, and code body is scored independently:

**Formula:**
```
BM25F_Score = Σ (IDF(term) × field_weight × BM25(term_in_field))

where:
  IDF = log(total_documents / documents_containing_term)
  BM25(term) = (term_frequency × (k1 + 1)) /
               (term_frequency + k1 × (1 - b + b × doc_length))

Field Weights:
  - symbolDefinition: 10.0 (highest priority)
  - exportedMember: 3.0
  - signature: 2.5
  - comment: 1.5
  - codeBody: 1.0 (lowest priority)
```

**Example scoring:**
```
Query: "authenticate"
├─ src/auth.ts:12 - "export function authenticate(...)"
│  Score: 0.95 (exact match in symbol definition field)
├─ src/middleware.ts:45 - "// authenticate request"
│  Score: 0.62 (partial match in comment field, lower weight)
└─ src/utils.ts:78 - "// helper to authenticate"
   Score: 0.58 (comment, less relevant)
```

### Trigram Indexing

Enables fuzzy search even with typos or partial names. Every file is indexed by all 3-character substrings:

```
Function name: "validateEmail"
Trigrams:
  val, ali, lid, ida, dat, ate, te_, e_E, _Em, Ema, mai, ail

Search for: "validat" (missing 'e')
Matching trigrams: val, ali, lid, ida, dat, ate (6/8 match)
Confidence: 75% → included in results
```

**Performance:**
- Index build: O(n × file_size)
- Query: O(trigrams × 400 max candidates)
- Typical project (10K files): 50-100ms

### Symbol Resolution (3-Tier Fallback)

When searching for a symbol name, tries progressively looser matching:

```
┌─────────────────────────────────────────────┐
│  Tier 1: EXACT MATCH (Highest Confidence)  │
│  symbolName === "MyClass"                  │
│  Confidence: 1.0                           │
│  Result: Exact type checking available     │
└─────────────────────────────────────────────┘
                    ↓
        (If no exact match found)
┌─────────────────────────────────────────────┐
│  Tier 2: IMPORTS & EXPORTS (Medium)         │
│  Check: import MyClass from ...             │
│  Confidence: 0.85-0.95                      │
│  Result: File location resolved             │
└─────────────────────────────────────────────┘
                    ↓
        (If still no match)
┌─────────────────────────────────────────────┐
│  Tier 3: FUZZY + CONTEXT (Lower)            │
│  Trigram match + code context analysis      │
│  Confidence: 0.60-0.80                      │
│  Result: Best guess with warnings           │
└─────────────────────────────────────────────┘
```

---

## Stage 2: Read (Code Understanding)

### Skeleton Generation (95-98% Token Savings)

Parses code via Tree-sitter into AST, then folds implementation details:

**Transformation:**
```typescript
// ORIGINAL (500+ tokens)
export class Editor {
  private cache: Map<string, CacheEntry> = new Map();
  private queue: EditQueue = [];

  constructor(config: EditorConfig) {
    this.cache.clear();
    this.queue = [];
  }

  async normalize(content: string): Promise<NormalizationResult> {
    let result = { ... };
    for (let i = 0; i < 1000; i++) {
      // Complex normalization logic
    }
    return result;
  }
}

// SKELETON (15 tokens - 97% savings!)
export class Editor {
  private cache: Map<string, CacheEntry> = /* ... */
  private queue: EditQueue = /* ... */

  constructor(config: EditorConfig) { /* ... implementation hidden ... */ }
  async normalize(content: string): Promise<NormalizationResult> { /* ... implementation hidden ... */ }
}
```

**Folding Rules by Language:**

| Language | Folding Rule | Example |
|----------|--------------|---------|
| TypeScript/JavaScript | `{ /* ... */ }` | `function foo() { /* ... implementation hidden ... */ }` |
| Python | `... # implementation hidden` | `def foo(): ... # implementation hidden` |
| Go | `{}` | `func Foo() {}` |
| Rust | `fn foo() {}` | `fn foo() {}` |

### Metadata Extraction

For each file, extract and cache:

```typescript
interface SmartFileProfile {
  metadata: {
    lineCount: number;           // Fast without reading content
    language: string;
    usesTabs: boolean;
    indentSize: number;
    lastModified: ISO8601Date;
  };
  structure: {
    skeleton: string;            // Folded view (50 tokens)
    symbols: SymbolInfo[];       // All definitions
    complexity: {
      functionCount: number;
      maxNestingDepth: number;
      linesOfCode: number;       // Code only, not comments/blanks
    };
  };
  usage: {
    incomingCount: number;       // Files importing this
    incomingFiles: string[];
    outgoingCount: number;       // Files this imports
    outgoingFiles: string[];
  };
}
```

---

## Stage 3: Edit (Safe Code Modification)

### 6-Level Normalization Hierarchy

Fuzzy matching strategy from strictest to loosest:

```
Level 0: EXACT
  Input:  "const x = 1;"
  Search: "const x = 1;"
  Match:  ✓ (100% exact)
  Confidence: 1.0

Level 1: LINE-ENDINGS
  Input:  "const x = 1;\r\n"    (Windows)
  Search: "const x = 1;\n"      (Unix)
  Match:  ✓ (normalized)
  Confidence: 0.99

Level 2: TRAILING-WHITESPACE
  Input:  "const x = 1;   "
  Search: "const x = 1;"
  Match:  ✓ (trailing ignored)
  Confidence: 0.98

Level 3: INDENTATION
  Input:  "    const x = 1;"    (4-space indent)
  Search: "  const x = 1;"      (2-space indent)
  Match:  ✓ (leading whitespace ignored)
  Confidence: 0.95

Level 4: WHITESPACE
  Input:  "const   x   =   1;"  (extra spaces)
  Search: "const x = 1;"        (single spaces)
  Match:  ✓ (all whitespace collapsed)
  Confidence: 0.90

Level 5: STRUCTURAL
  Input:  const x = 1;
  Search: const x=1;            (AST-aware, no spaces)
  Match:  ✓ (AST tokens match, formatting ignored)
  Confidence: 0.85
```

**Matching Flow:**
```typescript
function findMatch(file: string, target: string, normalization: Level) {
  // Try each level in sequence
  for (let level = 0; level <= normalization; level++) {
    const match = tryLevel(file, target, level);
    if (match) {
      return {
        found: true,
        confidence: 1.0 - (level * 0.05),
        matchType: getLevelName(level)
      };
    }
  }
  return { found: false };
}
```

### Fuzzy Matching Modes

**Whitespace Mode:**
```
Target:  "function foo() {\n  return 1;\n}"
Found:   "function foo(){\nreturn 1;\n}"
Diff:    Whitespace only → allows match even with formatting differences
Risk:    LOW (structure identical)
```

**Levenshtein Mode:**
```
Target:  "validateEmail"
Found:   "validateEmial"  (typo: 'i' and 'a' swapped)
Distance: 1 edit away → fuzzy match allowed
Threshold: 85% similarity minimum
Risk:    MEDIUM (could match wrong function, use with context)
```

### Transaction-Based Editing

**ACID Guarantees:**

```
Transaction Lifecycle:

STATE 1: SNAPSHOT
├─ Capture file content hash (xxHash64)
├─ Record original content for rollback
└─ Validate file hasn't changed since read

STATE 2: VALIDATE
├─ Run all matching strategies (6 levels)
├─ Check: does targetString exist?
├─ Score: how confident is this match?
└─ If confidence < threshold: fail with suggestions

STATE 3: APPLY
├─ Create in-memory copy with replacement
├─ Validate syntax (parse with Tree-sitter)
├─ Check: does code still compile?
└─ Record changes to transaction log

STATE 4: VERIFY
├─ Hash new content
├─ Compare against expected hash (if provided)
└─ Fail if mismatch (corruption detection)

STATE 5: COMMIT
├─ Write to disk
├─ Append to transaction log
├─ Update indexes
└─ Return transaction ID for undo/redo
```

**Rollback on Crash:**
```
1. Server crash during edit
2. Automatic recovery on startup:
   - Read transaction log
   - Find incomplete transactions (no COMMIT)
   - Delete partial writes
   - Restore from disk snapshot
3. Continue normally
```

### Hash Verification

Prevents TOCTOU (time-of-check-time-of-use) attacks:

```typescript
// Agent reads file
const original = readCode({ filePath: "src/auth.ts" });
// Agent computes hash
const hash = xxHash64(original.content);

// ... time passes, file might have changed ...

// Agent applies edit with hash verification
editCode({
  filePath: "src/auth.ts",
  targetString: "...",
  expectedHash: {
    algorithm: "xxhash",
    value: hash
  }
})
// Server rejects if hash doesn't match
// → guarantees original content is still there
```

---

## On-Disk Storage: SQLite Architecture

### Database Schema

```sql
-- Symbol definitions table (indexed by name + file path)
CREATE TABLE symbols (
  id INTEGER PRIMARY KEY,
  filePath TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,  -- 'function', 'class', 'variable', etc.
  startLine INTEGER,
  endLine INTEGER,
  signature TEXT,      -- Full function signature
  doc TEXT,            -- JSDoc/docstring
  UNIQUE(filePath, name, startLine)
);
CREATE INDEX idx_symbols_name ON symbols(name);
CREATE INDEX idx_symbols_file ON symbols(filePath);

-- File contents table (WAL for efficiency)
CREATE TABLE files (
  filePath TEXT PRIMARY KEY,
  content BLOB,
  hash TEXT,           -- xxHash64 for verification
  lineCount INTEGER,
  language TEXT,
  usesTabs BOOLEAN,
  indentSize INTEGER,
  lastModified INTEGER -- Unix timestamp
);

-- Dependencies table (who imports who)
CREATE TABLE dependencies (
  fromFile TEXT NOT NULL,
  toFile TEXT NOT NULL,
  importType TEXT,     -- 'named', 'default', 'namespace'
  PRIMARY KEY (fromFile, toFile)
);
CREATE INDEX idx_deps_from ON dependencies(fromFile);
CREATE INDEX idx_deps_to ON dependencies(toFile);
```

### Performance Optimization

**Write-Ahead Logging (WAL) Mode:**
```sql
PRAGMA journal_mode = WAL;
```
- Multiple readers can access DB while writes happen
- Crash recovery automatic
- P50 write: 5-20ms (vs 50-100ms without WAL)

**Batch Indexing:**
```typescript
// Build entire index in one transaction
BEGIN TRANSACTION;
  INSERT INTO symbols ...  (10,000 rows)
  INSERT INTO dependencies ... (50,000 rows)
COMMIT;
```
- Single transaction: 5-10s
- Individual inserts: 50-100s
- 10-100x faster

---

## Component Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    MCP Server                               │
│                   (index.ts)                                │
└────────┬────────────────────────────────────────────────────┘
         │
         ├─→ SearchEngine (src/engine/Search.ts)
         │   ├─ BM25F ranking
         │   ├─ Trigram filtering
         │   └─ Symbol/file/directory search
         │
         ├─→ ContextEngine (src/engine/Context.ts)
         │   ├─ Read full/skeleton/fragment
         │   ├─ AST analysis
         │   └─ Metadata extraction
         │
         ├─→ EditorEngine (src/engine/Editor.ts)
         │   ├─ 6-level normalization
         │   ├─ Fuzzy matching
         │   └─ Match confidence scoring
         │
         ├─→ EditCoordinator (src/engine/EditCoordinator.ts)
         │   ├─ Transaction orchestration
         │   ├─ Rollback management
         │   └─ Multi-file safety
         │
         ├─→ AstManager (src/ast/AstManager.ts)
         │   ├─ Tree-sitter parsing
         │   ├─ WASM module management
         │   └─ Language support routing
         │
         ├─→ SymbolIndex (src/ast/SymbolIndex.ts)
         │   ├─ Symbol extraction from AST
         │   ├─ Caching by file
         │   └─ Fast lookup
         │
         ├─→ CallGraphBuilder (src/ast/CallGraphBuilder.ts)
         │   ├─ Function call analysis
         │   ├─ Cross-file resolution
         │   └─ Call site location
         │
         ├─→ DependencyGraph (src/ast/DependencyGraph.ts)
         │   ├─ Import/export tracking
         │   ├─ Circular detection
         │   └─ Impact analysis
         │
         ├─→ DataFlowTracer (src/ast/DataFlowTracer.ts)
         │   ├─ Variable tracking
         │   ├─ Parameter passing
         │   └─ Return value analysis
         │
         └─→ IndexDatabase (src/indexing/IndexDatabase.ts)
             ├─ SQLite persistence
             ├─ Transaction logging
             └─ Crash recovery

Index Storage:
  ~/.mcp/smart-context/index.db (SQLite)
  ~/.mcp/smart-context/index.db-wal (Write-ahead log)
  ~/.mcp/smart-context/index.db-shm (Shared memory)
```

---

## Key Performance Characteristics

### Query Latencies (10K file project)

| Operation | P50 | P95 | P99 | Notes |
|-----------|-----|-----|-----|-------|
| search_project | 200ms | 500ms | 1.2s | BM25F + trigram |
| read_code (skeleton) | 100ms | 300ms | 800ms | Tree-sitter parse |
| read_code (full) | 150ms | 400ms | 1s | No parsing |
| read_fragment | 20ms | 50ms | 150ms | Line-range extract |
| edit_code (dryRun) | 100ms | 400ms | 1s | 1-10 edits |
| analyze_relationship | 300ms | 1s | 3s | Depends on graph |

### Memory Usage

| Component | 10K Files | 100K Files |
|-----------|-----------|-----------|
| Index DB (SQLite) | 500MB | 5GB |
| Hot cache (LRU) | 50MB | 100MB |
| Symbol index | 200MB | 2GB |
| Call graph (if built) | 100MB | 1GB |
| **Total** | **850MB** | **8GB** |

### Startup Timeline

```
1. Server initialization          50ms
2. SQLite index load (cold)       500ms
3. Query cache warm-up            200ms
4. AST parser (lazy)              0ms (on demand)
5. Ready for first request        750ms
```

---

## Design Patterns

### Lazy Loading

Don't parse a file unless necessary:

```
search_project() → Returns path only (0ms)
                    (no parse needed)
                         ↓
read_code() → Parse on demand (100ms)
               (only when requested)
```

### Streaming

Large result sets streamed, not buffered:

```
edit_code([1000 edits]) → Don't load all in RAM
                          Process in batches of 50
                          Stream results back
```

### Fallback Chain

Try best strategy first, fall back to safer but slower:

```
Exact match → no match
     ↓
Whitespace normalization → no match
     ↓
Levenshtein fuzzy → possible match
     ↓
Return with confidence: 0.70 (user decides)
```

### Confidence Scoring

Always return confidence, not just match/no-match:

```typescript
interface MatchResult {
  found: boolean;
  confidence: number;     // 0.0-1.0
  matchType: string;      // "exact" | "whitespace" | "fuzzy"
  similarity?: number;    // For fuzzy matches
  reason?: string;        // Why this match
}
```

---

## See Also

- [TOOL_REFERENCE.md](./TOOL_REFERENCE.md) - How to use each tool
- [AGENT_PLAYBOOK.md](./AGENT_PLAYBOOK.md) - Workflow patterns
- [../architecture/](../architecture/) - Detailed algorithm documentation
- [../guides/integration.md](../guides/integration.md) - Integration examples
