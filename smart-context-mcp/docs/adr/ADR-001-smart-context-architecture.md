# ADR-001: Smart Context MCP Server Architecture

**Status:** Proposed  
**Date:** 2025-12-06  
**Author:** Software Architecture Team

---

## Context

LLMs working with large codebases face two critical challenges:

1. **Context Token Waste**: Loading entire files consumes valuable context window tokens, even when only small regions are relevant.
2. **Unsafe Replacements**: Ambiguous string replacements can corrupt files when patterns appear multiple times or have subtle whitespace differences.

We need an MCP server that enables efficient, surgical codebase operations while maintaining file integrity.

---

## Decision

Build a **Smart Context MCP Server** with a 2-stage retrieval architecture and safe replacement guarantees.

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                     Smart Context MCP Server                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────┐  │
│  │   SCOUT      │───▶│    READ      │───▶│    REPLACE       │  │
│  │   Stage      │    │    Stage     │    │    Stage         │  │
│  └──────────────┘    └──────────────┘    └──────────────────┘  │
│         │                   │                     │             │
│         ▼                   ▼                     ▼             │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────────┐  │
│  │ File Scanner │    │  Interval    │    │  Safety Engine   │  │
│  │ + Keyword    │    │  Merger      │    │  - Uniqueness    │  │
│  │   Indexer    │    │              │    │  - Fuzzy Match   │  │
│  │              │    │              │    │  - Anchoring     │  │
│  └──────────────┘    └──────────────┘    └──────────────────┘  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Stage 1: Scout

**Purpose:** Identify files and regions containing keywords without loading full content.

### MCP Tool Definition

```typescript
interface ScoutParams {
  keywords: string[];           // Search terms
  rootPath: string;             // Base directory
  filePatterns?: string[];      // Glob patterns (default: ["**/*"])
  excludePatterns?: string[];   // Exclusions (default: node_modules, .git, etc.)
  caseSensitive?: boolean;      // Default: false
  maxResults?: number;          // Limit results (default: 100)
}

interface ScoutResult {
  files: FileMatch[];
  totalMatches: number;
  truncated: boolean;
}

interface FileMatch {
  path: string;                 // Relative path from rootPath
  matches: RegionMatch[];       // Matching regions
  fileSize: number;             // For context budgeting
}

interface RegionMatch {
  keyword: string;              // Which keyword matched
  line: number;                 // 1-indexed line number
  column: number;               // 1-indexed column
  preview: string;              // ~80 char preview (trimmed)
}
```

### Implementation Strategy

```typescript
// Pseudo-implementation
async function scout(params: ScoutParams): Promise<ScoutResult> {
  const files = await glob(params.filePatterns, {
    cwd: params.rootPath,
    ignore: params.excludePatterns
  });
  
  const results: FileMatch[] = [];
  
  for (const file of files) {
    // Stream file line-by-line to avoid memory issues
    const matches = await scanFileForKeywords(file, params.keywords, {
      caseSensitive: params.caseSensitive
    });
    
    if (matches.length > 0) {
      results.push({
        path: file,
        matches,
        fileSize: await getFileSize(file)
      });
    }
  }
  
  return {
    files: results.slice(0, params.maxResults),
    totalMatches: results.reduce((sum, f) => sum + f.matches.length, 0),
    truncated: results.length > params.maxResults
  };
}
```

### Performance Considerations

- **Streaming**: Read files line-by-line using `readline` or `createReadStream`
- **Early termination**: Stop scanning file after `maxMatchesPerFile` hits
- **Binary detection**: Skip binary files using magic bytes check
- **Parallel processing**: Use worker threads for large directories

---

## Stage 2: Read with Interval Merging

**Purpose:** Extract specific line ranges with intelligent merging to minimize redundant content.

### MCP Tool Definition

```typescript
interface ReadRegionsParams {
  filePath: string;
  regions: LineRange[];         // Requested regions
  contextLines?: number;        // Lines before/after (default: 3)
  maxTotalLines?: number;       // Budget limit (default: 500)
}

interface LineRange {
  start: number;                // 1-indexed, inclusive
  end: number;                  // 1-indexed, inclusive
}

interface ReadRegionsResult {
  filePath: string;
  totalLines: number;           // File's total line count
  regions: ExtractedRegion[];
  merged: boolean;              // Were any regions merged?
}

interface ExtractedRegion {
  start: number;
  end: number;
  content: string;
  originalRanges: LineRange[];  // Which requested ranges produced this
}
```

### Interval Merging Algorithm

```typescript
function mergeIntervals(
  ranges: LineRange[], 
  contextLines: number
): LineRange[] {
  if (ranges.length === 0) return [];
  
  // Expand each range by context
  const expanded = ranges.map(r => ({
    start: Math.max(1, r.start - contextLines),
    end: r.end + contextLines
  }));
  
  // Sort by start position
  expanded.sort((a, b) => a.start - b.start);
  
  // Merge overlapping/adjacent intervals
  const merged: LineRange[] = [expanded[0]];
  
  for (let i = 1; i < expanded.length; i++) {
    const current = expanded[i];
    const last = merged[merged.length - 1];
    
    // Merge if overlapping or adjacent (within 1 line)
    if (current.start <= last.end + 1) {
      last.end = Math.max(last.end, current.end);
    } else {
      merged.push(current);
    }
  }
  
  return merged;
}
```

### Example

```
Input regions: [10-15], [12-18], [50-55], [52-60]
Context lines: 3

Step 1 - Expand:
  [7-18], [9-21], [47-58], [49-63]

Step 2 - Sort & Merge:
  [7-21], [47-63]

Result: 2 merged regions instead of 4 separate reads
```

---

## Stage 3: Safe Replace

**Purpose:** Perform surgical text replacements with multiple safety guarantees.

### MCP Tool Definition

```typescript
interface SafeReplaceParams {
  filePath: string;
  oldContent: string;           // Content to find
  newContent: string;           // Replacement content
  anchor?: AnchorConfig;        // Optional anchoring
  fuzzyMatch?: FuzzyConfig;     // Whitespace tolerance
  dryRun?: boolean;             // Preview only (default: false)
}

interface AnchorConfig {
  beforeContext?: string;       // Required content before match
  afterContext?: string;        // Required content after match
  lineRange?: LineRange;        // Restrict to line range
}

interface FuzzyConfig {
  enabled: boolean;             // Default: true
  maxDistance: number;          // Levenshtein distance (default: 5)
  whitespaceOnly: boolean;      // Only tolerate whitespace diff (default: true)
}

interface SafeReplaceResult {
  success: boolean;
  error?: SafetyError;
  matchInfo?: MatchInfo;
  preview?: DiffPreview;        // If dryRun or for confirmation
}

interface SafetyError {
  code: 'NO_MATCH' | 'MULTIPLE_MATCHES' | 'ANCHOR_FAILED' | 'FUZZY_UNSAFE';
  message: string;
  details?: any;
}

interface MatchInfo {
  line: number;
  column: number;
  matchType: 'exact' | 'fuzzy';
  distance?: number;            // If fuzzy
}

interface DiffPreview {
  before: string;               // Context + old content
  after: string;                // Context + new content
  lineRange: LineRange;
}
```

### Safety Pipeline

```
┌────────────────────────────────────────────────────────────────┐
│                    Safe Replace Pipeline                        │
├────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Input: oldContent, newContent, options                         │
│                           │                                     │
│                           ▼                                     │
│            ┌──────────────────────────┐                        │
│            │  1. EXACT MATCH CHECK    │                        │
│            │     Count occurrences    │                        │
│            └──────────────────────────┘                        │
│                      │                                          │
│         ┌────────────┼────────────┐                            │
│         ▼            ▼            ▼                            │
│     0 matches   1 match      >1 matches                        │
│         │            │            │                            │
│         ▼            │            ▼                            │
│  ┌─────────────┐     │     ┌─────────────┐                     │
│  │ 2. FUZZY    │     │     │ 3. ANCHOR   │                     │
│  │ MATCHING    │     │     │ RESOLUTION  │                     │
│  └─────────────┘     │     └─────────────┘                     │
│         │            │            │                            │
│         ▼            ▼            ▼                            │
│     ┌────────────────────────────────┐                         │
│     │      4. APPLY REPLACEMENT      │                         │
│     │         (if unique)            │                         │
│     └────────────────────────────────┘                         │
│                                                                 │
└────────────────────────────────────────────────────────────────┘
```

### Uniqueness Check Algorithm

```typescript
function checkUniqueness(
  fileContent: string, 
  searchContent: string,
  anchor?: AnchorConfig
): UniqueCheckResult {
  const matches = findAllMatches(fileContent, searchContent);
  
  if (matches.length === 0) {
    return { unique: false, reason: 'NO_MATCH', count: 0 };
  }
  
  if (matches.length === 1) {
    return { unique: true, match: matches[0], count: 1 };
  }
  
  // Multiple matches - try anchoring
  if (anchor) {
    const anchoredMatches = matches.filter(m => 
      matchesAnchor(fileContent, m, anchor)
    );
    
    if (anchoredMatches.length === 1) {
      return { unique: true, match: anchoredMatches[0], count: 1 };
    }
  }
  
  return { 
    unique: false, 
    reason: 'MULTIPLE_MATCHES', 
    count: matches.length,
    matches 
  };
}
```

### Fuzzy Matching with Levenshtein

```typescript
function fuzzyMatch(
  fileContent: string,
  searchContent: string,
  config: FuzzyConfig
): FuzzyMatchResult | null {
  // Normalize for comparison
  const normalizedSearch = normalizeWhitespace(searchContent);
  
  // Sliding window approach for efficiency
  const searchLines = searchContent.split('\n').length;
  const fileLines = fileContent.split('\n');
  
  let bestMatch: FuzzyMatchResult | null = null;
  let bestDistance = Infinity;
  
  for (let i = 0; i <= fileLines.length - searchLines; i++) {
    const candidate = fileLines.slice(i, i + searchLines).join('\n');
    const normalizedCandidate = normalizeWhitespace(candidate);
    
    // Quick rejection: length difference too large
    if (Math.abs(normalizedCandidate.length - normalizedSearch.length) > config.maxDistance) {
      continue;
    }
    
    const distance = levenshteinDistance(normalizedSearch, normalizedCandidate);
    
    if (distance <= config.maxDistance && distance < bestDistance) {
      // Verify whitespace-only difference if required
      if (config.whitespaceOnly && !isWhitespaceOnlyDiff(searchContent, candidate)) {
        continue;
      }
      
      bestDistance = distance;
      bestMatch = {
        startLine: i + 1,
        endLine: i + searchLines,
        content: candidate,
        distance
      };
    }
  }
  
  return bestMatch;
}

function normalizeWhitespace(str: string): string {
  return str
    .replace(/[ \t]+/g, ' ')      // Collapse horizontal whitespace
    .replace(/\r\n/g, '\n')        // Normalize line endings
    .trim();
}

function isWhitespaceOnlyDiff(a: string, b: string): boolean {
  return normalizeWhitespace(a) === normalizeWhitespace(b);
}
```

### Anchoring Implementation

```typescript
function matchesAnchor(
  fileContent: string,
  matchPosition: MatchPosition,
  anchor: AnchorConfig
): boolean {
  const { start, end } = matchPosition;
  
  // Line range constraint
  if (anchor.lineRange) {
    if (start < anchor.lineRange.start || end > anchor.lineRange.end) {
      return false;
    }
  }
  
  // Before context constraint
  if (anchor.beforeContext) {
    const beforeContent = fileContent.substring(
      Math.max(0, matchPosition.charStart - anchor.beforeContext.length - 100),
      matchPosition.charStart
    );
    if (!beforeContent.includes(anchor.beforeContext)) {
      return false;
    }
  }
  
  // After context constraint
  if (anchor.afterContext) {
    const afterContent = fileContent.substring(
      matchPosition.charEnd,
      matchPosition.charEnd + anchor.afterContext.length + 100
    );
    if (!afterContent.includes(anchor.afterContext)) {
      return false;
    }
  }
  
  return true;
}
```

---

## Project Structure

```
smart-context-mcp/
├── src/
│   ├── index.ts                 # MCP server entry point
│   ├── server.ts                # Server configuration
│   ├── tools/
│   │   ├── scout.ts             # Stage 1: Scout tool
│   │   ├── read-regions.ts      # Stage 2: Read with merging
│   │   └── safe-replace.ts      # Stage 3: Safe replace
│   ├── core/
│   │   ├── file-scanner.ts      # File traversal & streaming
│   │   ├── interval-merger.ts   # Interval merging algorithm
│   │   ├── fuzzy-matcher.ts     # Levenshtein implementation
│   │   └── anchor-resolver.ts   # Anchor matching logic
│   ├── utils/
│   │   ├── binary-detector.ts   # Skip binary files
│   │   ├── line-reader.ts       # Streaming line reader
│   │   └── diff-generator.ts    # Preview diff generation
│   └── types/
│       └── index.ts             # Shared type definitions
├── tests/
│   ├── scout.test.ts
│   ├── interval-merger.test.ts
│   ├── fuzzy-matcher.test.ts
│   └── safe-replace.test.ts
├── docs/
│   └── ADR-001-smart-context-architecture.md
├── package.json
├── tsconfig.json
└── README.md
```

---

## MCP Server Registration

```typescript
// src/index.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { scout } from "./tools/scout.js";
import { readRegions } from "./tools/read-regions.js";
import { safeReplace } from "./tools/safe-replace.js";

const server = new McpServer({
  name: "smart-context",
  version: "1.0.0"
});

// Tool: scout
server.tool(
  "scout",
  "Find files and regions containing keywords without loading full content",
  {
    keywords: z.array(z.string()).describe("Search terms to find"),
    rootPath: z.string().describe("Base directory to search"),
    filePatterns: z.array(z.string()).optional().default(["**/*"]),
    excludePatterns: z.array(z.string()).optional(),
    caseSensitive: z.boolean().optional().default(false),
    maxResults: z.number().optional().default(100)
  },
  scout
);

// Tool: read_regions
server.tool(
  "read_regions", 
  "Extract specific line ranges with interval merging",
  {
    filePath: z.string().describe("Path to file"),
    regions: z.array(z.object({
      start: z.number().describe("Start line (1-indexed)"),
      end: z.number().describe("End line (1-indexed)")
    })),
    contextLines: z.number().optional().default(3),
    maxTotalLines: z.number().optional().default(500)
  },
  readRegions
);

// Tool: safe_replace
server.tool(
  "safe_replace",
  "Safely replace content with uniqueness and fuzzy matching",
  {
    filePath: z.string().describe("Path to file"),
    oldContent: z.string().describe("Content to find"),
    newContent: z.string().describe("Replacement content"),
    anchor: z.object({
      beforeContext: z.string().optional(),
      afterContext: z.string().optional(),
      lineRange: z.object({
        start: z.number(),
        end: z.number()
      }).optional()
    }).optional(),
    fuzzyMatch: z.object({
      enabled: z.boolean().default(true),
      maxDistance: z.number().default(5),
      whitespaceOnly: z.boolean().default(true)
    }).optional(),
    dryRun: z.boolean().optional().default(false)
  },
  safeReplace
);

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
```

---

## Error Handling Strategy

```typescript
enum ErrorCode {
  // Scout errors
  INVALID_PATH = 'INVALID_PATH',
  ACCESS_DENIED = 'ACCESS_DENIED',
  
  // Read errors
  FILE_NOT_FOUND = 'FILE_NOT_FOUND',
  INVALID_LINE_RANGE = 'INVALID_LINE_RANGE',
  
  // Replace errors
  NO_MATCH = 'NO_MATCH',
  MULTIPLE_MATCHES = 'MULTIPLE_MATCHES',
  ANCHOR_FAILED = 'ANCHOR_FAILED',
  FUZZY_UNSAFE = 'FUZZY_UNSAFE',
  WRITE_FAILED = 'WRITE_FAILED'
}

interface SmartContextError {
  code: ErrorCode;
  message: string;
  suggestion?: string;    // Help LLM recover
  details?: unknown;
}

// Example error with suggestion
{
  code: 'MULTIPLE_MATCHES',
  message: 'Found 3 occurrences of the search content',
  suggestion: 'Use anchor.beforeContext or anchor.lineRange to disambiguate',
  details: {
    matches: [
      { line: 45, preview: '...' },
      { line: 128, preview: '...' },
      { line: 256, preview: '...' }
    ]
  }
}
```

---

## Typical LLM Workflow

```
1. LLM calls scout({ keywords: ["handleSubmit", "FormData"], rootPath: "./src" })
   → Returns: 3 files with line numbers

2. LLM calls read_regions({ 
     filePath: "./src/components/Form.tsx",
     regions: [{ start: 45, end: 60 }, { start: 120, end: 135 }]
   })
   → Returns: Merged content with context

3. LLM analyzes code, decides on change

4. LLM calls safe_replace({
     filePath: "./src/components/Form.tsx",
     oldContent: "const [data, setData] = useState(null);",
     newContent: "const [data, setData] = useState<FormData | null>(null);",
     anchor: { lineRange: { start: 45, end: 50 } },
     dryRun: true
   })
   → Returns: Preview of change

5. LLM confirms, calls safe_replace with dryRun: false
   → Returns: Success + updated line info
```

---

## Consequences

### Positive

- **Token Efficiency**: Scout returns lightweight metadata; Read extracts only relevant lines
- **Safety Guarantees**: Multiple checks prevent accidental file corruption
- **Fuzzy Tolerance**: Handles common whitespace/formatting differences
- **Universal Compatibility**: Works with any text file, not just code

### Negative

- **Two-Stage Overhead**: Requires multiple tool calls vs. single file read
- **Complexity**: Anchor and fuzzy matching add implementation complexity
- **False Negatives**: Overly strict uniqueness checks may reject valid replacements

### Mitigations

- Provide clear error messages with actionable suggestions
- Allow LLM to adjust fuzzy matching thresholds
- Support `dryRun` mode for safe experimentation

---

## Future Considerations

1. **Caching Layer**: Cache scout results for repeated queries
2. **Semantic Search**: Integrate embeddings for concept-based search
3. **Batch Operations**: Support multiple replacements in single call
4. **Undo/Redo**: Track changes for rollback capability
5. **Language-Aware Mode**: AST-based search for specific languages

---

## References

- [Model Context Protocol SDK](https://github.com/modelcontextprotocol/sdk)
- [Levenshtein Distance Algorithm](https://en.wikipedia.org/wiki/Levenshtein_distance)
- [Interval Merging (LeetCode 56)](https://leetcode.com/problems/merge-intervals/)
