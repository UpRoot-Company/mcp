# ADR-001: EditorEngine String Matching Improvements

**Status:** Proposed  
**Date:** 2024-12-06  
**Author:** Architecture Team

## Context

The `EditorEngine` class in `smart-context-mcp` is responsible for applying text edits to files using various matching strategies. Three critical flaws have been identified:

### Problem 1: Word Boundary Regex Failures
The current implementation enforces `\b` word boundaries in both `createExactRegex()` and `createFuzzyRegex()`:

```typescript
// Line 91-94
private createExactRegex(target: string): RegExp {
    const escaped = this.escapeRegExp(target);
    return new RegExp(`\\b${escaped}\\b`, "g");
}
```

**Issue:** `\b` matches transitions between word (`\w`) and non-word characters. Code snippets frequently start/end with symbols like `{`, `(`, `@`, `#`, `.`, etc. These are non-word characters, so `\b` fails to match.

**Example failures:**
- `targetString: "{ foo: bar }"` — `\b` before `{` fails
- `targetString: "@decorator"` — `\b` before `@` fails  
- `targetString: "getValue()"` — `\b` after `)` fails

### Problem 2: Levenshtein Mode Paradox
The `levenshtein` fuzzy mode still requires an exact regex match first (line 116-117):

```typescript
} else if (edit.fuzzyMode === "levenshtein") {
    regex = new RegExp(this.escapeRegExp(edit.targetString), "g");
}
```

**Issue:** If the regex doesn't find an exact match, `candidateMatches` is empty and Levenshtein scoring never runs. This defeats the purpose of fuzzy matching—LLMs often produce slightly incorrect strings (typos, whitespace variations, minor syntax differences).

### Problem 3: Inefficient Line Number Calculation
Line numbers are computed by re-splitting the entire content prefix for every match:

```typescript
// Line 124
const linesBefore = content.substring(0, startIndex).split("\n").length;
```

**Issue:** For a file with N lines and M matches, this is O(N × M) in the worst case. Large files with many matches become slow.

## Decision

We propose a multi-phase solution that maintains full backward compatibility with the `Edit` interface.

### Solution 1: Replace Word Boundaries with Positional Assertions

**Replace `\b` with context-aware boundary detection:**

```typescript
private createBoundaryPattern(escaped: string): string {
    // Use negative lookbehind/lookahead for alphanumeric boundaries only
    // This allows symbols at boundaries while still preventing partial word matches
    const start = escaped.match(/^\\?[a-zA-Z0-9_]/) ? '(?<![a-zA-Z0-9_])' : '';
    const end = escaped.match(/[a-zA-Z0-9_]\\?$/) ? '(?![a-zA-Z0-9_])' : '';
    return `${start}${escaped}${end}`;
}

private createExactRegex(target: string): RegExp {
    const escaped = this.escapeRegExp(target);
    const pattern = this.createBoundaryPattern(escaped);
    return new RegExp(pattern, "g");
}
```

**Rationale:** 
- Lookbehind `(?<![a-zA-Z0-9_])` prevents matching inside identifiers
- Allows `{ foo }` to match when preceded/followed by any character
- Node.js 10+ supports lookbehind assertions

### Solution 2: Sliding Window Levenshtein Matching

**Implement true fuzzy search when exact match fails:**

```typescript
private findLevenshteinCandidates(
    content: string, 
    target: string, 
    lineRange?: LineRange
): { text: string; start: number; end: number; lineNumber: number }[] {
    const targetLen = target.length;
    const tolerance = Math.floor(targetLen * 0.3); // 30% threshold
    const windowSize = targetLen + tolerance;
    const candidates: { text: string; start: number; end: number; distance: number; lineNumber: number }[] = [];
    
    // Pre-compute line boundaries for O(1) lookup
    const lineStarts = this.buildLineIndex(content);
    
    // Optionally restrict search range
    let searchStart = 0;
    let searchEnd = content.length;
    if (lineRange) {
        searchStart = lineStarts[lineRange.start - 1] ?? 0;
        searchEnd = lineStarts[lineRange.end] ?? content.length;
    }
    
    // Slide window, checking at line boundaries and significant positions
    for (let i = searchStart; i <= searchEnd - targetLen; i++) {
        // Optimize: only check at word/line boundaries to reduce iterations
        if (i > searchStart && !this.isBoundaryPosition(content, i)) continue;
        
        const window = content.substring(i, Math.min(i + windowSize, searchEnd));
        
        // Check multiple substring lengths around target length
        for (let len = targetLen - tolerance; len <= targetLen + tolerance; len++) {
            if (len <= 0 || len > window.length) continue;
            const candidate = window.substring(0, len);
            const distance = levenshtein.get(target, candidate);
            
            if (distance <= tolerance) {
                candidates.push({
                    text: candidate,
                    start: i,
                    end: i + len,
                    distance,
                    lineNumber: this.getLineNumber(lineStarts, i)
                });
                break; // Found a match at this position, move to next
            }
        }
    }
    
    // Deduplicate overlapping candidates, keeping best distance
    return this.deduplicateCandidates(candidates);
}
```

**Rationale:**
- Falls back to sliding window when regex finds no matches
- `lineRange` constraint reduces search space
- Boundary-position optimization avoids checking every character

### Solution 3: Pre-computed Line Index

**Build line index once, reuse for all matches:**

```typescript
private buildLineIndex(content: string): number[] {
    const lineStarts: number[] = [0];
    for (let i = 0; i < content.length; i++) {
        if (content[i] === '\n') {
            lineStarts.push(i + 1);
        }
    }
    return lineStarts;
}

private getLineNumber(lineStarts: number[], position: number): number {
    // Binary search for O(log N) lookup
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (lineStarts[mid] <= position) {
            low = mid;
        } else {
            high = mid - 1;
        }
    }
    return low + 1; // 1-indexed
}
```

**Complexity improvement:** O(N) to build index once, then O(log N) per lookup instead of O(N) per lookup.

## Implementation Plan

### Phase 1: Line Index Optimization (Low Risk)
1. Add `buildLineIndex()` and `getLineNumber()` methods
2. Refactor `findMatch()` to build index once and pass to all lookups
3. Update `applyEditsInternal()` similarly

### Phase 2: Boundary Pattern Fix (Medium Risk)
1. Add `createBoundaryPattern()` helper
2. Update `createExactRegex()` and `createFuzzyRegex()`
3. Add unit tests for symbol-boundary cases

### Phase 3: Levenshtein Sliding Window (Higher Risk)
1. Add `findLevenshteinCandidates()` as fallback
2. Modify `findMatch()` to use sliding window when regex returns empty
3. Add `isBoundaryPosition()` optimization
4. Add extensive unit tests for fuzzy matching edge cases

## Alternatives Considered

### Alternative A: Remove All Boundary Matching
**Rejected:** Would cause false positives matching substrings inside identifiers (e.g., `foo` matching inside `foobar`).

### Alternative B: Full AST-Based Matching
**Rejected:** Over-engineered for text-based edits. Would require language-specific parsers and break generality.

### Alternative C: External Fuzzy Search Library (fuse.js, etc.)
**Rejected:** Adds dependency, may not integrate well with index ranges and context anchors.

## Consequences

### Positive
- Code snippets with symbols now match correctly
- True fuzzy matching finds near-matches even with typos
- Large file performance improves from O(N×M) to O(N + M×log N)

### Negative
- Lookbehind assertions require Node.js 10+ (already satisfied)
- Sliding window adds complexity; must be carefully bounded
- Slightly more memory for line index (acceptable for modern systems)

### Neutral
- `Edit` interface unchanged—full backward compatibility
- Existing tests should pass; new tests required for edge cases

## Appendix: Updated findMatch Pseudocode

```typescript
private findMatch(content: string, edit: Edit): Match {
    const lineStarts = this.buildLineIndex(content);
    let candidates: MatchCandidate[];
    
    if (edit.fuzzyMode === 'levenshtein') {
        // Try exact first (fast path)
        const exactRegex = new RegExp(this.escapeRegExp(edit.targetString), 'g');
        candidates = this.regexToCandidates(content, exactRegex, lineStarts);
        
        // Fallback to sliding window if no exact matches
        if (candidates.length === 0) {
            candidates = this.findLevenshteinCandidates(content, edit.targetString, edit.lineRange);
        }
    } else if (edit.fuzzyMode === 'whitespace') {
        candidates = this.regexToCandidates(content, this.createFuzzyRegex(edit.targetString), lineStarts);
    } else {
        candidates = this.regexToCandidates(content, this.createExactRegex(edit.targetString), lineStarts);
    }
    
    // Apply context filters (beforeContext, afterContext, lineRange)
    candidates = this.filterByContext(content, candidates, edit);
    
    // Score and select best match (Levenshtein scoring if applicable)
    return this.selectBestMatch(candidates, edit);
}
```

## References

- [ECMAScript Lookbehind Assertions](https://github.com/tc39/proposal-regexp-lookbehind)
- [fast-levenshtein npm](https://www.npmjs.com/package/fast-levenshtein)
- Current implementation: `src/engine/Editor.ts`
