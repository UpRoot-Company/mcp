# System Overview

**High-level architecture and design philosophy of Smart Context MCP.**

---

## 🎯 Core Mission

Smart Context enables AI agents to **efficiently understand and modify large codebases** via a small, intent-based interface (**Five Pillars**, ADR-040). Internally, it still relies on search/read/edit style capabilities, but those details are orchestrated for the agent.

```
┌──────────────────────────────────────────────────────────────┐
│                     Five Pillars (“What”)                     │
├──────────────────────────────────────────────────────────────┤
│  explore  understand  change  write  manage                  │
├──────────────────────────────────────────────────────────────┤
│                 Orchestration (“How”, internal)               │
├──────────────────────────────────────────────────────────────┤
│  search/index  skeleton/profile  graphs/impact  transactions  │
└──────────────────────────────────────────────────────────────┘
```

---

## 🏗️ Architecture Layers

### Layer 1: Discovery (Scout)
**Purpose:** Locate relevant code in large codebases (10K+ files)

**Technologies:**
- BM25F ranking (field-weighted search)
- Trigram indexing (fuzzy matching)
- Symbol resolution (3-tier fallback)

**Performance:** 150-300ms P50 latency, 2-8KB tokens

**Learn More:** [02-core-engine.md - Advanced Search Algorithms](./02-core-engine.md#2-advanced-search-algorithms)

### Layer 2: Understanding (Read)
**Purpose:** Retrieve code in token-efficient formats

**Technologies:**
- Skeleton generation (95-98% token savings)
- AST-based analysis
- Metadata extraction

**Efficiency:** 
- Full file: 500 tokens
- Skeleton: 15 tokens (97% savings!)
- Fragment: 50-100 tokens (80-90% savings)

**Learn More:** [05-semantic-analysis.md - Skeleton Generation](./05-semantic-analysis.md#3-skeleton-generation-algorithm)

### Layer 3: Modification (Edit)
**Purpose:** Apply code changes safely with transactional guarantees

**Technologies:**
- 6-level normalization (fuzzy matching)
- ACID transactions (all-or-nothing)
- Crash recovery (write-ahead logging)
- Safety verification (hashing, sandboxing)

**Safety:** Hash verification, confidence scoring, path sandboxing

**Learn More:** [06-reliability-engineering.md - Safety Mechanisms](./06-reliability-engineering.md#4-safety-mechanisms)

---

## 🗂️ Component Architecture

```
┌────────────────────────────────────────────────┐
│           MCP Server (index.ts)                │
├────────────────────────────────────────────────┤
│                                                │
│  ┌─────────────────┐    ┌──────────────────┐   │
│  │  SearchEngine   │    │  ContextEngine   │   │
│  │  • BM25F        │    │  • Read full     │   │
│  │  • Trigram      │    │  • Skeleton      │   │
│  │  • Symbol res.  │    │  • Fragment      │   │
│  └─────────────────┘    │  • Metadata      │   │
│                         └──────────────────┘   │
│                                                │
│  ┌──────────────────┐   ┌──────────────────┐   │
│  │  EditorEngine    │   │ EditCoordinator  │   │
│  │  • Normalization │   │ • Transactions   │   │
│  │  • Fuzzy match   │   │ • Rollback       │   │
│  │  • Confidence    │   │ • Recovery       │   │
│  └──────────────────┘   └──────────────────┘   │
│                                                │
│  ┌──────────────────┐   ┌──────────────────┐   │
│  │   AstManager     │   │ CallGraphBuilder │   │
│  │ • Tree-sitter    │   │ • Function calls │   │
│  │ • Symbol extract │   │ • Dependencies   │   │
│  │ • Error recovery │   │ • Type hierarchy │   │
│  └──────────────────┘   └──────────────────┘   │
│                                                │
│  ┌──────────────────────────────────────────┐  │
│  │       IndexDatabase (SQLite)             │  │
│  │  • Files table                           │  │
│  │  • Symbols table (indexed)               │  │
│  │  • Dependencies table (graph)            │  │
│  │  • Transaction log (recovery)            │  │
│  └──────────────────────────────────────────┘  │
│                                                │
└────────────────────────────────────────────────┘
```

---

## 📊 Data Flow Example

**Agent: "Rename `validateEmail` to `isValidEmail` across project"**

```
1. SCOUT PHASE (search_project)
   ├─ Query: "validateEmail"
   ├─ BM25F ranking scans symbols table
   ├─ Trigram index pre-filters candidates (max 400)
   └─ Returns: 12 matches with scores

2. READ PHASE (read_code with beforeContext/afterContext)
   ├─ For each match: fetch surrounding code
   ├─ Skeleton view: 95% token savings
   ├─ Verify match is actually a function definition
   └─ Collect line numbers for each occurrence

3. EDIT PHASE (edit_code with dryRun=true)
   ├─ Validate: All targetStrings found
   ├─ Score confidence: 0.98+ (all exact matches)
   ├─ Syntax check: Parse result is valid TypeScript
   ├─ DRY RUN: Show diffs without modifying
   └─ COMMIT: Write all files atomically

4. VERIFY PHASE
   ├─ Check: Hash matches expected
   ├─ Update: Dependency graph (calls, imports)
   ├─ Rollback: Available via manage_project
   └─ Result: ✅ 12 files modified, 0 failures
```

---

## 🔑 Key Design Decisions

### Why SQLite?
- ✅ Persistent indexing (survives restarts)
- ✅ Graph queries (dependencies)
- ✅ ACID transactions (safety)
- ✅ No external dependencies
- ✅ Crash recovery via WAL

See: [02-core-engine.md - On-Disk Indexing](./02-core-engine.md#1-on-disk-indexing-sqlite)

### Why Tree-sitter?
- ✅ Multi-language support
- ✅ Error-resilient parsing
- ✅ Incremental updates
- ✅ WASM runtime (no native deps)
- ✅ S-expression queries

See: [05-semantic-analysis.md - Why Tree-sitter?](./05-semantic-analysis.md#1-why-tree-sitter)

### Why 6-Level Normalization?
- ✅ Exact match first (safest)
- ✅ Progressive relaxation (exact → structural)
- ✅ Confidence scoring (never silent failure)
- ✅ Handles formatting differences
- ✅ Works across code styles

See: [04-advanced-algorithms.md - 6-Level Normalization](./04-advanced-algorithms.md#3-six-level-normalization-hierarchy)

### Why Transactions?
- ✅ All-or-nothing guarantee (no partial state)
- ✅ Rollback on validation failure
- ✅ Crash recovery via WAL
- ✅ Safe batch operations

See: [06-reliability-engineering.md - ACID Transactions](./06-reliability-engineering.md#1-acid-transactions-explained)

---

## 📈 Performance Profile

### Index Build
| Phase | Time | Notes |
|-------|------|-------|
| Cold start | 45-60s | Parse all files, build graph |
| Incremental | 500-800ms | Update 10 modified files |
| Lazy load | 50-150ms | Single file on first read |

### Query Latencies
| Operation | P50 | P95 |
|-----------|-----|-----|
| Symbol search | 150-300ms | 500-800ms |
| Read code (skeleton) | 100-300ms | 300-800ms |
| Edit code (dryRun) | 100-400ms | 400-1000ms |
| Analyze relationship | 300-800ms | 1-3s |

### Memory Usage
- Symbol cache: 150-200MB
- Trigram index: 50-100MB
- LRU query cache: 20-50MB
- **Total (10K files):** ~400MB

---

## 🛡️ Safety Guarantees

### ACID Transactions
```
Atomicity:   All edits succeed or ALL fail (no partial state)
Consistency: Database remains valid
Isolation:   No concurrent interference
Durability:  Committed changes survive crash
```

### Crash Recovery
- Write-Ahead Logging (WAL) records all operations
- On startup: Find pending transactions, restore originals
- User sees no data corruption

### Error Prevention
- Hash verification (TOCTOU detection)
- Path sandboxing (directory traversal prevention)
- Confidence scoring (never silently apply risky edits)
- Syntax validation (no broken code)

See: [06-reliability-engineering.md](./06-reliability-engineering.md)

---

## 📚 Documentation Map

**Quick navigation:**

| Topic | File | Key Sections |
|-------|------|--------------|
| **Agent Workflows** | [../agent/AGENT_PLAYBOOK.md](../agent/AGENT_PLAYBOOK.md) | 7 patterns, token analysis, error recovery |
| **Tool API** | [../agent/TOOL_REFERENCE.md](../agent/TOOL_REFERENCE.md) | All 10+ tools, parameters, examples |
| **Agent Architecture** | [../agent/ARCHITECTURE.md](../agent/ARCHITECTURE.md) | Pipeline, algorithms, design patterns |
| **Core Engine** | [02-core-engine.md](./02-core-engine.md) | SQLite, indexing, search algorithms |
| **Tools & Workflows** | [03-tools-and-workflows.md](./03-tools-and-workflows.md) | Tool guide, 3 real workflows, integration |
| **Algorithms** | [04-advanced-algorithms.md](./04-advanced-algorithms.md) | BM25F, Trigram, Normalization, Diff |
| **Semantic Analysis** | [05-semantic-analysis.md](./05-semantic-analysis.md) | AST, Skeleton, Call graphs, Dependencies |
| **Reliability** | [06-reliability-engineering.md](./06-reliability-engineering.md) | ACID, Recovery, Safety, Testing |
| **Human Guides** | [../guides/](../guides/) | Getting started, integration, config |

---

## 🚀 Getting Started

### For Humans
1. Read [../guides/getting-started.md](../guides/getting-started.md) - Installation & setup
2. Try examples in [03-tools-and-workflows.md - Real-World Workflows](./03-tools-and-workflows.md#real-world-workflows)
3. Reference [../guides/integration.md](../guides/integration.md) - IDE setup

### For AI Agents
1. Read [../agent/ARCHITECTURE.md](../agent/ARCHITECTURE.md) - Understand the system
2. Study [../agent/AGENT_PLAYBOOK.md](../agent/AGENT_PLAYBOOK.md) - Learn patterns
3. Reference [../agent/TOOL_REFERENCE.md](../agent/TOOL_REFERENCE.md) - API details

### For Developers
1. Understand [02-core-engine.md](./02-core-engine.md) - How indexing works
2. Study [04-advanced-algorithms.md](./04-advanced-algorithms.md) - Core algorithms
3. Review [06-reliability-engineering.md](./06-reliability-engineering.md) - Safety patterns

---

## 🔗 Cross-References

**Architecture foundations:**
- [ADR-001](../ADR-INDEX.md#architecture-foundation) - Smart Context Architecture
- [ADR-022](../ADR-INDEX.md#scalable-memory) - Scalable Memory
- [ADR-023](../ADR-INDEX.md#reliability) - Enhanced Gap Remediation

**Implementation details:**
- See [ADR-INDEX.md](./ADR-INDEX.md) for complete mapping of all 26 ADRs

---

## 📊 Technology Stack

| Layer | Technology | Purpose |
|-------|-----------|---------|
| **Parsing** | Tree-sitter (WASM) | Multi-language AST |
| **Indexing** | SQLite + Better-sqlite3 | Persistent graph database |
| **Ranking** | BM25F | Information retrieval |
| **Search** | Trigram index | Fuzzy matching |
| **Matching** | Levenshtein + Normalization | Fuzzy code replacement |
| **Diff** | Myers + Patience diff | Semantic-aware diffs |
| **Transactions** | WAL mode + Transaction log | ACID guarantees |

---

## ✨ Key Features

| Feature | Benefit | Details |
|---------|---------|---------|
| **Scout → Read → Edit** | Optimized workflow | 3-stage pipeline |
| **Token efficiency** | 95-98% savings | Via skeleton views |
| **Multi-language** | Works everywhere | Tree-sitter support |
| **ACID transactions** | Safe batch edits | All-or-nothing guarantee |
| **Crash recovery** | Data safety | Write-ahead logging |
| **Fuzzy matching** | Flexible editing | 6-level normalization |
| **Confidence scoring** | Reliability guide | 0.0-1.0 per operation |
| **Error recovery** | Helpful hints | Similar symbols, next actions |

---

**Status:** Production-ready ⭐⭐⭐⭐⭐  
**Last updated:** 2025-12-14

For detailed implementation information, see the architecture files referenced above.
