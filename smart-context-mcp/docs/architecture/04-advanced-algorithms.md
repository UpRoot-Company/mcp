# Advanced Algorithms

**Deep technical dive into ranking, indexing, matching, and diffing algorithms.**

---

## 1. BM25F Ranking Algorithm

### Problem Statement

Given a query and 10,000 files, rank them by relevance. We need:
- Speed: <500ms for typical queries
- Relevance: Most useful results first
- Field-awareness: A match in "function name" more important than in "comment"

### Algorithm Overview

BM25F (Best Matching 25 with Fields) extends BM25 to handle multi-field documents.

**Key Insight:** When searching for "authenticate", a file with:
```typescript
export function authenticate() { }  // Field: symbol-definition (10x weight)
```
...ranks higher than:
```typescript
// Helper function to authenticate users  // Field: comment (1.5x weight)
```

### Mathematical Formula

**BM25F Score:**
```
score(q, d) = Σ[i=1 to n] (IDF(q_i) × BM25_i(q_i, d))

where:
  IDF(term) = log((N - df + 0.5) / (df + 0.5))
    N = total documents
    df = documents containing term

  BM25_i(term, doc) = (freq_i × (k1 + 1)) / 
                      (freq_i + k1 × (1 - b + b × (L_i / L_avg)))
    freq_i = term frequency in field i
    L_i = length of field i
    L_avg = average length of field i
    k1, b = tuning parameters (typically k1=1.2, b=0.75)
```

### Field Weights

```
Field Name                Weight    Rationale
──────────────────────────────────────────────
symbolDefinition          10.0      Exact function/class name
exportedMember            3.0       Public API
signature                 2.5       Function parameters
comment                   1.5       Documentation
codeBody                  1.0       Implementation details
```

### Implementation Example

**From src/engine/Search.ts (lines 234-267):**

```typescript
// Pseudo-code of actual implementation
function calculateBM25FScore(query: string, file: FileIndex, fields: FieldWeights): number {
  let score = 0;
  
  // Split query into terms
  const terms = query.toLowerCase().split(/\s+/);
  
  for (const term of terms) {
    // Calculate IDF (inverse document frequency)
    const docFreq = this.getDocumentFrequency(term);
    const idf = Math.log(
      (this.totalDocs - docFreq + 0.5) / 
      (docFreq + 0.5)
    );
    
    // Score each field separately
    for (const [fieldName, weight] of Object.entries(fields)) {
      const fieldContent = file.getField(fieldName);
      const freq = this.getTermFrequency(term, fieldContent);
      
      if (freq > 0) {
        // BM25 formula
        const bm25 = (freq * 2.2) / (freq + 1.2 * (1 - 0.75 + 0.75 * (fieldContent.length / avgFieldLength)));
        score += idf * weight * bm25;
      }
    }
  }
  
  return score;
}
```

### Performance Characteristics

| Metric | Value | Notes |
|--------|-------|-------|
| **Indexing** | O(n × m) | n = files, m = avg file size |
| **Query** | O(terms × df) | df = documents with terms |
| **P50 Latency** | 150-300ms | 10,000 file codebase |
| **P95 Latency** | 500-800ms | Complex queries |
| **Memory** | ~50MB | Vocabulary + IDF table |

### Example Scoring

**Query: "authenticate"**

```
File 1: src/auth.ts
  ├─ symbolDefinition field: "export function authenticate()"
  │  freq=1, idf=5.2, weight=10.0 → contributes 52.0
  ├─ signature field: "authenticate(user: User, password: string)"
  │  freq=1, idf=5.2, weight=2.5 → contributes 13.0
  └─ TOTAL SCORE: 65.0

File 2: src/middleware.ts  
  ├─ comment field: "// authenticate request before processing"
  │  freq=1, idf=5.2, weight=1.5 → contributes 7.8
  └─ TOTAL SCORE: 7.8

RANKING: File 1 (65.0) >> File 2 (7.8)
```

---

## 2. Trigram Indexing

### Problem Statement

User types "authentcate" (typo). Should still find "authenticate". Full-text search won't work.

### Algorithm Overview

Break every word into 3-character substrings (trigrams). Matches are determined by overlap.

### How It Works

**Index Time:**
```
Word: "authenticate"
Trigrams: aut, ute, hen, ent, nti, tic, ica, cat, ate
          (all 3-char sliding windows)

Build index: {
  "aut" → [file1, file3, file5, ...],
  "ute" → [file1, file2, file4, ...],
  "hen" → [file1, file8, ...],
  ...
}
```

**Query Time (looking for "authentcate" with typo):**
```
Query: "authentcate"
Query Trigrams: aut, uth, hen, ent, nti, tic, ica, cat, ate

For each trigram, get file list:
  "aut" → {file1, file3, file5}
  "uth" → {file1, file2, file4}  
  "hen" → {file1, file8}
  ...

Calculate Jaccard similarity:
  Intersection count / Union count
  
File 1 appears in all trigrams → similarity ~90%
→ Include in results despite typo!
```

### Implementation Details

**From src/engine/TrigramIndex.ts (lines 150-200):**

```typescript
class TrigramIndex {
  private trigramMap: Map<string, Set<number>> = new Map();
  
  indexFile(fileId: number, content: string): void {
    // Extract trigrams
    const trigrams = this.extractTrigrams(content);
    
    for (const trigram of trigrams) {
      if (!this.trigramMap.has(trigram)) {
        this.trigramMap.set(trigram, new Set());
      }
      this.trigramMap.get(trigram)!.add(fileId);
    }
  }
  
  search(query: string): number[] {
    const queryTrigrams = this.extractTrigrams(query);
    
    // Get candidate files (intersection)
    let candidates = new Set<number>();
    let isFirst = true;
    
    for (const trigram of queryTrigrams) {
      const files = this.trigramMap.get(trigram) || new Set();
      
      if (isFirst) {
        candidates = new Set(files);
        isFirst = false;
      } else {
        // Intersection: keep only files in both sets
        candidates = new Set([...candidates].filter(f => files.has(f)));
      }
    }
    
    return Array.from(candidates);
  }
  
  private extractTrigrams(text: string): string[] {
    const trigrams: string[] = [];
    const normalized = text.toLowerCase();
    
    for (let i = 0; i < normalized.length - 2; i++) {
      trigrams.push(normalized.substr(i, 3));
    }
    
    return trigrams;
  }
}
```

### Performance Characteristics

| Operation | Time | Space | Notes |
|-----------|------|-------|-------|
| **Index file** | O(n) | O(n) | n = file size |
| **Query** | O(t × c) | - | t = trigrams, c = candidates |
| **P50 latency** | 50-100ms | - | 10K files |
| **Memory** | 50-100MB | - | Scales with vocabulary |

### When to Use Trigram Index

✓ Typo tolerance needed
✓ Fuzzy user input
✓ Content search across files

✗ Not for exact symbol matching (use database index)
✗ Not for structured queries

---

## 3. Six-Level Normalization Hierarchy

### Problem Statement

User wants to replace:
```typescript
const maxLength = 100;
```

But file has (different indentation, line endings):
```
    const maxLength = 100;
```

Should this match? How strict should matching be?

### Levels (Least to Most Permissive)

#### Level 0: EXACT
```
Target:   "const x = 1;"
Content:  "const x = 1;"
Match: ✓ YES (100% identical)
Confidence: 1.0
Risk: None
```

#### Level 1: LINE-ENDINGS
```
Target:   "const x = 1;\n"     (Unix LF)
Content:  "const x = 1;\r\n"   (Windows CRLF)
Match: ✓ YES (normalized)
Confidence: 0.99
Risk: Very low
```

#### Level 2: TRAILING-WHITESPACE
```
Target:   "const x = 1;"
Content:  "const x = 1;    " (trailing spaces)
Match: ✓ YES (trailing ignored)
Confidence: 0.98
Risk: Low
```

#### Level 3: INDENTATION
```
Target:   "  const x = 1;"    (2-space)
Content:  "    const x = 1;"  (4-space)
Match: ✓ YES (leading whitespace ignored)
Confidence: 0.95
Risk: Medium (context might matter)
```

#### Level 4: WHITESPACE
```
Target:   "const x = 1;"
Content:  "const   x   =   1;" (extra spaces)
Match: ✓ YES (all whitespace collapsed)
Confidence: 0.90
Risk: Medium (formatting changes)
```

#### Level 5: STRUCTURAL
```
Target:   "const x = 1;"
Content:  "const x=1;"         (no spaces)
Match: ✓ YES (AST tokens identical)
Confidence: 0.85
Risk: High (must ensure semantically identical)
```

### Implementation

**From src/engine/Editor.ts (lines 234-450):**

```typescript
type NormalizationLevel = 'exact' | 'line-endings' | 'trailing' | 
                         'indentation' | 'whitespace' | 'structural';

class Editor {
  private normalizationLevels: Record<NormalizationLevel, (s: string) => string> = {
    'exact': (s) => s,
    
    'line-endings': (s) => s.replace(/\r\n/g, '\n'),
    
    'trailing': (s) => s
      .split('\n')
      .map(line => line.replace(/\s+$/, ''))
      .join('\n'),
    
    'indentation': (s) => s
      .split('\n')
      .map(line => line.replace(/^\s+/, ''))
      .join('\n'),
    
    'whitespace': (s) => s.replace(/\s+/g, ' ').trim(),
    
    'structural': (s) => this.normalizeStructural(s)
  };
  
  findMatch(content: string, target: string, maxLevel: NormalizationLevel): Match | null {
    const levelOrder: NormalizationLevel[] = 
      ['exact', 'line-endings', 'trailing', 'indentation', 'whitespace', 'structural'];
    
    for (const level of levelOrder) {
      const normalized = this.normalizationLevels[level](target);
      const contentNorm = this.normalizationLevels[level](content);
      
      if (contentNorm.includes(normalized)) {
        return {
          found: true,
          confidence: this.confidenceScore(level),
          level: level
        };
      }
      
      if (level === maxLevel) break;
    }
    
    return null;
  }
  
  private normalizeStructural(s: string): string {
    // Parse to AST, extract tokens, normalize
    const ast = this.parser.parse(s);
    return this.tokensToString(ast.tokens);
  }
  
  private confidenceScore(level: NormalizationLevel): number {
    const scores: Record<NormalizationLevel, number> = {
      'exact': 1.0,
      'line-endings': 0.99,
      'trailing': 0.98,
      'indentation': 0.95,
      'whitespace': 0.90,
      'structural': 0.85
    };
    return scores[level];
  }
}
```

### Decision Flowchart

```
User provides:
  normalization: "trailing"
  targetString: "const x = 1;"

┌──────────────────────────┐
│ Try Level 0: EXACT       │
│ "const x = 1;" === ... ? │─→ NO
└──────────────────────────┘
         ↓
┌──────────────────────────┐
│ Try Level 1: LINE-ENDINGS│─→ NO
└──────────────────────────┘
         ↓
┌──────────────────────────┐
│ Try Level 2: TRAILING    │
│ Match found!             │─→ YES
│ Confidence: 0.98         │
└──────────────────────────┘
         ↓
    STOP (reached requested level)
    Return match with confidence 0.98
```

---

## 4. Levenshtein Distance for Fuzzy Matching

### Problem Statement

Function is named `validateEmail` but user searches for `validat` or `validateEmial` (typo). Should we find it?

### Algorithm

Levenshtein distance = minimum edits (insertions, deletions, substitutions) needed to transform one string to another.

```
validateEmail → validateEmial

1 substitution: (swap i and a)
Distance = 1
Similarity = 1 - (1 / 13) = 92%
Threshold: 85% → MATCH ✓
```

### Implementation

```typescript
function levenshteinDistance(s1: string, s2: string): number {
  const m = s1.length, n = s2.length;
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1));
  
  // Initialize base cases
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  
  // Fill DP table
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (s1[i - 1] === s2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(
          dp[i - 1][j],     // deletion
          dp[i][j - 1],     // insertion
          dp[i - 1][j - 1]  // substitution
        );
      }
    }
  }
  
  return dp[m][n];
}

function similarity(s1: string, s2: string): number {
  const distance = levenshteinDistance(s1, s2);
  const maxLen = Math.max(s1.length, s2.length);
  return 1 - (distance / maxLen);
}
```

### Performance

| Input Size | Time | Notes |
|-----------|------|-------|
| **10 chars** | <1ms | Real-time |
| **100 chars** | 5-10ms | Still acceptable |
| **1000 chars** | 100-200ms | Getting slow |

**Optimization:** Combine with Trigram index first. Only run Levenshtein on trigram-matched candidates (~400 files max).

---

## 5. Patience Diff vs Myers Diff

### Problem Statement

User wants to see the changes they made. How to compute an efficient diff?

### Myers Diff Algorithm

Standard diff. Fast, works well for most cases.

```
Original:
  function foo() {
    return 1;
  }

Modified:
  function foo() {
    return 1 + 1;
  }

Myers Diff Output:
  function foo() {
    - return 1;
    + return 1 + 1;
  }
```

**Complexity:** O(n × m)
**Speed:** Very fast even on large files
**Output:** Line-based diffs

### Patience Diff Algorithm

Improved diff that respects code structure better.

**Insight:** When code blocks move, Patience Diff is better at identifying them.

```
Example: Function moved

MYERS OUTPUT (incorrect):
  - function A() { }
  - function B() { }
  + function B() { }
  + function A() { }

PATIENCE OUTPUT (correct):
  function B() { }
  function A() { }
```

**Complexity:** O(n log n) with good luck, O(n²) worst case
**Speed:** Slower than Myers, but better for refactoring
**Output:** Semantically-aware diffs

### When to Use Which

**Use Myers (default):**
- Simple text edits (rename, update variable)
- Line-by-line changes
- Most regular edits

**Use Patience (semantic mode):**
- Function/method moved
- Large refactoring
- Code reordering
- Testing `edit_code` with `diffMode: "semantic"`

### Implementation Reference

**From src/engine/AstAwareDiff.ts:**
- Myers Diff: src/engine/Diff.ts
- Patience Diff: src/engine/PatienceDiff.ts

---

## Performance Comparison

| Algorithm | Use Case | Speed | Accuracy |
|-----------|----------|-------|----------|
| **BM25F** | Ranking search results | ⚡⚡ Fast | ⭐⭐⭐ Excellent |
| **Trigram** | Pre-filtering for fuzzy | ⚡⚡ Fast | ⭐⭐ Good |
| **Levenshtein** | Exact fuzzy matching | ⚡ Slow | ⭐⭐⭐ Excellent |
| **Normalization** | Fuzzy code matching | ⚡⚡ Fast | ⭐⭐⭐ Excellent |
| **Myers Diff** | Standard diff | ⚡⚡ Fast | ⭐⭐⭐ Good |
| **Patience Diff** | Semantic diff | ⚡ Slower | ⭐⭐⭐⭐ Better |

---

## See Also

- [02-core-engine.md](./02-core-engine.md) - Database and architecture
- [03-tools-and-workflows.md](./03-tools-and-workflows.md) - How to use tools
- [AGENT_PLAYBOOK.md](../agent/AGENT_PLAYBOOK.md) - Workflow patterns
