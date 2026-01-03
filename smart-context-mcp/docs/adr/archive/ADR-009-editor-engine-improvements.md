# ADR-009: EditorEngine String Matching & Performance Improvements (Revised)

**Status:** Proposed  
**Date:** 2024-12-07  
**Author:** Architecture Team  
**Reviewer:** Senior Engineer (Feedback Incorporated)

## Context

The `EditorEngine` in `smart-context-mcp` is critical for applying edits. Current analysis reveals three major flaws:

1.  **Regex Boundary Failures**: `\b` fails on symbols (e.g., `{`, `@`, `.`).
2.  **Broken Fuzzy Logic**: Levenshtein mode requires an exact regex match first.
3.  **Inefficient Line Counting**: O(N×M) complexity for line number lookups.

## Decision

We will refactor `EditorEngine` with a phased approach, prioritizing correctness and safety.

### 1. Robust Line Indexing (Phase 1)

We will implement a `LineCounter` class to handle O(1) line lookups via pre-computed indices.

```typescript
export class LineCounter {
    private lineStarts: number[];

    constructor(content: string) {
        this.lineStarts = [0];
        for (let i = 0; i < content.length; i++) {
            if (content[i] === '\n') {
                this.lineStarts.push(i + 1);
            }
        }
    }

    // Fixed Binary Search (floor logic)
    public getLineNumber(position: number): number {
        let low = 0;
        let high = this.lineStarts.length - 1;
        
        while (low <= high) {
            const mid = Math.floor((low + high) / 2);
            const start = this.lineStarts[mid];
            
            if (start === position) return mid + 1;
            
            if (start < position) {
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }
        return high + 1; // 1-based line number
    }
}
```

### 2. Context-Aware Boundary Matching (Phase 2)

We will replace `\b` with dynamic lookahead/lookbehind assertions, strictly checking the **original unescaped string** to determine if boundaries are needed.

```typescript
private createBoundaryPattern(target: string): string {
    // Check ORIGINAL string for alphanumeric boundaries
    const needsStartBoundary = /^[a-zA-Z0-9_]/.test(target);
    const needsEndBoundary = /[a-zA-Z0-9_]$/.test(target);
    
    const escaped = this.escapeRegExp(target);
    
    // Safety check for environment support (Node 10+)
    const supportsLookbehind = (() => { try { new RegExp('(?<=a)'); return true; } catch { return false; } })();

    let pattern = escaped;
    if (needsStartBoundary) {
        pattern = supportsLookbehind ? `(?<![a-zA-Z0-9_])${pattern}` : `\\b${pattern}`;
    }
    if (needsEndBoundary) {
        pattern = `${pattern}(?![a-zA-Z0-9_])`;
    }
    
    return pattern;
}
```

### 3. Safe Sliding Window Fuzzy Search (Phase 3)

We will implement a true fuzzy search fallback with strict performance guards.

**Constants:**
- `MAX_FUZZY_TARGET_LEN`: 256
- `MAX_FUZZY_SCAN_OPS`: 1,000,000 (Operation budget to prevent freeze)
- `FUZZY_THRESHOLD_RATIO`: 0.3

**Algorithm:**
1.  **Fast Path**: Try exact regex first.
2.  **Fallback**: If exact fails, start sliding window search.
3.  **Optimization**: Only check "promising" positions (start of words or lines) if file is large.
4.  **Termination**: Throw error if operation budget exceeded.

```typescript
// Helper: Check if position is a valid word/symbol boundary start
private isBoundaryPosition(content: string, index: number): boolean {
    if (index === 0) return true;
    const prev = content[index - 1];
    const curr = content[index];
    // True if transitioning from whitespace to non-whitespace, or symbol boundaries
    return /\s/.test(prev) && !/\s/.test(curr); 
}

// Helper: Select best non-overlapping candidates
private deduplicateCandidates(candidates: MatchCandidate[]): MatchCandidate[] {
    // Sort by score (asc) then position (asc)
    candidates.sort((a, b) => a.distance - b.distance || a.start - b.start);
    
    const accepted: MatchCandidate[] = [];
    for (const cand of candidates) {
        // Simple overlap check
        const isOverlapping = accepted.some(a => 
            (cand.start >= a.start && cand.start < a.end) || 
            (cand.end > a.start && cand.end <= a.end)
        );
        if (!isOverlapping) accepted.push(cand);
    }
    return accepted;
}
```

## Verification Plan

We will add specific tests for the identified edge cases:

1.  **LineCounter**:
    - Empty file
    - Single line file
    - File ending with/without newline
    - Position exactly at `\n`

2.  **Boundary Logic**:
    - Target: `{ code }` (Should match)
    - Target: `import` (Should NOT match `importUtils`)
    - Target: `func` (Should match `func()`)

3.  **Fuzzy Search**:
    - Target: `function test()` vs Content: `function  test ()` (Whitespace mode)
    - Target: `const val = 1` vs Content: `const val=1` (Levenshtein)
    - Performance: 100KB file timeout check

## Consequences

- **Performance**: Line lookups become negligible (O(log N)).
- **Safety**: Fuzzy search will no longer hang the CPU; it will fail fast if complex.
- **Reliability**: Symbol-heavy code edits will succeed significantly more often.
