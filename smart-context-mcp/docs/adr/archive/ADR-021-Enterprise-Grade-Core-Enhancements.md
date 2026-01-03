# ADR 021: Enterprise-Grade Core Enhancements (Architecture & Algorithms)

*   **Status**: Proposed
*   **Date**: 2025-12-11
*   **Author**: Gemini CLI Agent & Claude 4.5 Opus (Co-authored)
*   **Impacts**: `src/engine/*`, `src/ast/*`, `src/platform/*`
*   **Version**: 2.0 (Refined with detailed implementation specs)

---

## 1. Context & Problem Statement

As `smart-context-mcp` evolves into an enterprise-grade tool (v3.0+), the current "MVP-style" implementation faces three critical bottlenecks that hinder scalability, testability, and AI-agent UX.

1.  **Tight Coupling with Node.js FS**:
    *   **Problem**: Core engines (`Editor`, `Context`, `History`) import `node:fs` directly.
    *   **Impact**: Unit tests are slow and flaky (disk I/O dependent). Porting to non-Node environments (e.g., browser-based editors, cloud workers) is impossible.
    *   **Goal**: Zero direct `fs` imports in domain logic.

2.  **Naive Search & Ranking**:
    *   **Problem**: Simple Regex tokenization fails on `CamelCase` identifiers (e.g., searching "User" misses "UpdateUser"). BM25 treats code as flat text, ignoring structure.
    *   **Impact**: Agents struggle to find relevant code without exact keywords.
    *   **Goal**: Google-style code search (Trigram indexing + Structure-aware ranking).

3.  **Semantic-Poor Diffing**:
    *   **Problem**: Myers Diff (standard `diff`) minimizes edit distance but destroys code structure (e.g., moving a function looks like chaos).
    *   **Impact**: Agents cannot verify if a "Move Method" refactoring was successful.
    *   **Goal**: Patience Diff or AST-aware diffing to preserve semantic blocks.

---

## 2. Technical Decisions

We will implement three foundational pillars to address these issues.

### Pillar 1: FileSystem Abstraction (The "IFileSystem" Interface)

We will introduce a strict abstraction layer for all file I/O.

#### 2.1. Interface Design
```typescript
export interface IFileSystem {
    // Basic I/O
    readFile(path: string): Promise<string>;
    writeFile(path: string, content: string): Promise<void>;
    deleteFile(path: string): Promise<void>;
    exists(path: string): Promise<boolean>;
    
    // Directory Operations
    readDir(path: string): Promise<string[]>;
    createDir(path: string): Promise<void>;
    
    // Metadata
    stat(path: string): Promise<FileStats>;
    
    // Advanced (Optional but recommended for performance)
    watch?(path: string, onChange: (event: FileChangeEvent) => void): () => void;
}

export interface FileStats {
    size: number;
    mtime: number;
    isDirectory(): boolean;
}
```

#### 2.2. Implementations
1.  **`NodeFileSystem`**: Thin wrapper around `node:fs/promises`. Used in Production.
2.  **`MemoryFileSystem`**: `Map<string, string>` based implementation. Used in **Unit Tests** (enabling sub-millisecond tests).
3.  **`CachedFileSystem`** (Decorator): Wraps another FS with LRU caching for `readFile` operations. Used in heavy analysis tasks.

#### 2.3. Dependency Injection
The `SmartContextServer` constructor will act as the Composition Root.
```typescript
constructor(rootPath: string, fs?: IFileSystem) {
    this.fs = fs || new NodeFileSystem(rootPath); // Default to Node for backward compat
    this.editor = new EditorEngine(this.fs);
    // ...
}
```

---

### Pillar 2: Google-Style Advanced Search (Zoekt-inspired)

We will replace the regex-based search with a Trigram index and a Field-Weighted ranking system.

#### 2.4. Trigram Indexing
Instead of splitting by words, we split code into 3-character sliding windows (trigrams).
*   **Input**: `EditCoordinator`
*   **Trigrams**: `Edi`, `dit`, `itC`, `tCo`, `Coo`, ...
*   **Query**: `Coord` -> `Coo`, `oor`, `ord`
*   **Benefit**: Matches `CamelCase`, `snake_case`, and substrings in **O(1)** time complexity.

#### 2.5. BM25F (Structure-Aware Ranking)
We will define "fields" within a source file and assign weights based on semantic importance.

| Field Type | Source | Weight | Rationale |
|:--- |:--- |:--- |:--- |
| **Symbol Definition** | `class X`, `function Y` | **10.0** | Matches here are usually what the user wants. |
| **Signature/Interface** | Params, Return Types | **6.0** | High relevance for usage lookups. |
| **Exported Member** | `export const Z` | **3.0** | Public API surface. |
| **Comments/DocString** | `/** ... */` | **0.5** | Good for context, but lower priority than code. |
| **Code Body** | Implementation details | **1.0** | Baseline relevance. |

**Implementation Strategy:**
*   `AstManager` extracts these ranges during parsing.
*   `RankingEngine` calculates scores per field and sums them: $\sum (score_f \times weight_f)$.

---

### Pillar 3: Semantic Diffing (Patience Diff)

We will adopt the **Patience Diff** algorithm to generate human-readable patches.

#### 2.6. Algorithm Logic
1.  **Scan**: Identify lines that are **unique** in both file A and file B (Anchors).
2.  **Match**: Find the Longest Common Subsequence (LCS) of these anchors.
3.  **Recurse**: Apply the logic recursively to the gaps between matched anchors.
4.  **Fallback**: Use Myers Diff only for small gaps where no unique lines exist.

#### 2.7. Expected Outcome
*   **Before (Myers)**:
    ```diff
    - function old() {
    -   doSomething();
    + function new() {
    +   doSomething();
      }
    ```
*   **After (Patience)**:
    ```diff
    function old() -> function new() {
      doSomething();
    }
    ```
    *(Detects the block identity despite the name change)*

---

## 3. Migration Roadmap (6 Weeks)

### Week 1-2: Foundation (FS Abstraction)
*   [ ] Define `IFileSystem` in `src/platform`.
*   [ ] Implement `NodeFileSystem` and `MemoryFileSystem`.
*   [ ] Refactor `EditorEngine` to accept `IFileSystem`.
*   [ ] **Milestone**: Run existing `EditorEngine` tests using `MemoryFileSystem` (Target: 10x speedup).

### Week 3-4: Search Intelligence
*   [ ] Implement `TrigramIndex` class.
*   [ ] Upgrade `Ranking.ts` to `BM25FRanking`.
*   [ ] Integrate `AstManager` metadata into ranking weights.
*   [ ] **Milestone**: Pass "Needle in a Haystack" search benchmark (finding 1 symbol in 10k files).

### Week 5: Semantic Diffing
*   [x] Implement `PatienceDiff` engine (see `src/engine/PatienceDiff.ts`) and wire it into `EditorEngine` dry-run previews. *(Completed 2025-12-11)*
*   [x] Add `diffMode: 'semantic'` option to `edit_code` so CLI agents can request the Patience diff preview. *(Completed 2025-12-11)*

### Week 6: Polish & Release
*   [ ] Performance tuning (LRU Caching for Trigrams).
*   [ ] Documentation update.
*   [ ] Release v3.1.0.

---

## 4. Consequences

### Positive
*   **Testability**: Can simulate disk full, permission denied, and race conditions easily via `MemoryFileSystem`.
*   **User Trust**: Agents will trust the tool more because search results are relevant and diffs are readable.
*   **Scalability**: Trigram index scales well to ~100MB codebases in memory.

### Negative
*   **Memory Overhead**: Trigram index is roughly 3-4x the size of the source text. We may need an "On-Disk Index" (SQLite/LevelDB) for very large repos later.
*   **Complexity**: Debugging ranking issues in BM25F is harder than simple text match.

---

## 5. References
*   [Zoekt (Google Code Search)](https://github.com/google/zoekt)
*   [Patience Diff Algorithm](https://bramcohen.livejournal.com/73.html)

#### 2.8. Implementation Notes (2025-12-11)
*   Introduced `src/engine/PatienceDiff.ts` with LIS-based anchors, semantic grouping for adjacent delete/insert pairs, and unified diff/summary helpers.
*   `EditorEngine.applyEdits` now accepts `diffMode` (default `myers`); dry-run previews switch to Patience Diff when `diffMode: 'semantic'`.
*   `edit_code` exposes a `diffMode` argument so agents can opt-in to semantic previews without affecting non-dry-run behavior.
*   `AstAwareDiff` leverages `SkeletonGenerator` metadata to emit semantic change summaries (add/remove/rename/move/modify) whenever `diffMode: 'semantic'` is used, and `EditResult.diffModeUsed` makes the chosen mode observable to agents (even after real edits).
*   [The Art of Testing: Test Doubles](https://martinfowler.com/bliki/TestDouble.html)
