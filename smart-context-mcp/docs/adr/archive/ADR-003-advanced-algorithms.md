# ADR-003: Advanced Algorithms Implementation

## 1. Context
To elevate `smart-context-mcp` from a simple wrapper to an intelligent context engine, we decided to implement advanced algorithms for search ranking, diff visualization, and fuzzy matching. The user explicitly requested high-performance logic while maintaining portability (avoiding native bindings if possible).

## 2. Decision
We will implement the following algorithms in **Pure TypeScript** to leverage the V8 engine's text optimization and ensure zero-dependency deployment.

## 3. Algorithm Specifications

### 3.1. Myers Difference Algorithm (`src/engine/Diff.ts`)
*   **Purpose:** Generate `git diff`-style visualization (`+/-`) for `dryRun` output in `edit_file`.
*   **Concept:** Finds the Shortest Edit Script (SES) between two sequences.
*   **Implementation:**
    *   Input: `original: string`, `modified: string`
    *   Process:
        1.  Split strings into lines.
        2.  Compute the edit graph (O(ND) time complexity).
        3.  Backtrack to find the optimal path.
    *   Output: Unified diff string.

### 3.2. Okapi BM25 Ranking (`src/engine/Ranking.ts`)
*   **Purpose:** Rank `search_files` results by relevance rather than file order.
*   **Concept:** Probabilistic information retrieval model.
    *   `TF` (Term Frequency): How often the keyword appears in the file.
    *   `IDF` (Inverse Document Frequency): How rare the keyword is across all files.
*   **Implementation:**
    *   Parameters: `k1 = 1.2`, `b = 0.75` (standard tuning).
    *   Process:
        1.  Calculate `avgdl` (average document length) of searched files.
        2.  For each match, compute score:
            `Score = IDF * (TF * (k1 + 1)) / (TF + k1 * (1 - b + b * (docLength / avgdl)))`
        3.  Sort results by score descending.

### 3.3. Enhanced Fuzzy Matching (`src/engine/Search.ts`)
*   **Purpose:** Allow finding targets even with minor typos or whitespace variations.
*   **Decision:** Instead of Bitap (limited by 32-bit integers in JS), we will use **Weighted Levenshtein with Regex**.
*   **Optimization:**
    *   **Phase 1 (Fast):** Normalized whitespace search (Regex `\s+`).
    *   **Phase 2 (Robust):** If Phase 1 fails and `fuzzyMatch` is strict, use a sliding window with Levenshtein distance check (only if `contextLines` is small to avoid performance hit).
    *   *Note:* For MVP, we stick to the **Robust Regex Generator** approach as it's fastest in V8.

## 4. Architecture Update
```
src/engine/
├── Diff.ts       # Myers Algorithm
├── Ranking.ts    # BM25 Logic
├── Search.ts     # Updated with Ranking
└── Editor.ts     # Updated with Diff generation
```

## 5. Implementation Plan
1.  Create `Diff.ts` and implement Myers Algorithm.
2.  Create `Ranking.ts` and implement BM25.
3.  Integrate `Diff` into `Editor.ts` (`dryRun` logic).
4.  Integrate `Ranking` into `Search.ts` (`scout` logic).
5.  Add tests for diff generation and ranking accuracy.
