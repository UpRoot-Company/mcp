# Tool Reference Guide

Six Pillars are the primary interface. Legacy tools are still documented for compatibility, but are opt-in and should be avoided for new flows.

**Table of Contents:**
- [Six Pillars (Recommended)](#six-pillars-recommended)
- [Quick Tool Selector](#quick-tool-selector)
- [Legacy Tool Catalog (Opt-in)](#legacy-tool-catalog-opt-in)
  - [search_project](#search_project)
  - [read_code](#read_code)
  - [edit_code](#edit_code)
  - [analyze_relationship](#analyze_relationship)
  - [manage_project](#manage_project)
  - [get_batch_guidance](#get_batch_guidance)
  - [read_file](#read_file)
  - [write_file](#write_file)
  - [analyze_file](#analyze_file)
  - [list_directory](#list_directory)
  - [read_fragment](#read_fragment)

---

## Six Pillars (Recommended)

The Six Pillars are the primary interface. Legacy tools are hidden by default and can be exposed with:

- `SMART_CONTEXT_EXPOSE_LEGACY_TOOLS=true`
- `SMART_CONTEXT_LEGACY_AUTOMAP=true` (auto-map unknown legacy calls)

| Pillar | Intent | Example |
|---|---|---|
| `understand` | Understand code structure/logic | `understand({ goal: "Auth flow in UserService" })` |
| `change` | Modify code safely | `change({ intent: "Add domain whitelist", options: { dryRun: true } })` |
| `navigate` | Find symbols/files | `navigate({ target: "PaymentProcessor" })` |
| `read` | Read file contents | `read({ target: "src/auth.ts", view: "fragment" })` |
| `write` | Create files | `write({ intent: "Add test file", targetPath: "tests/auth.test.ts" })` |
| `manage` | Manage state | `manage({ command: "undo" })` |

Below are the **current inputs and behaviors** as implemented in `smart-context-mcp/src/index.ts` and the pillar handlers.

### understand

Deep analysis of structure and relationships.

**Parameters**

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| goal | string | ✓ | — | Analysis target (symbol, file path, or free text) |
| depth | "shallow" \| "standard" \| "deep" | ✗ | "standard" | Controls call graph depth (deep = maxDepth 3) |
| scope | "symbol" \| "file" \| "module" \| "project" | ✗ | "symbol" | Affects search mode for initial lookup |
| include.callGraph | boolean | ✗ | false | Only runs if a symbol match is found |
| include.dependencies | boolean | ✗ | false | Enable to include dependency edges |
| include.pageRank | boolean | ✗ | false | When true, pageRankScores and impactRadius are computed |
| include.hotSpots | boolean | ✗ | false | When true, hotSpots is included |

**Behavior**

- If `goal` looks like a path, it is used directly. Otherwise it searches via `search_project`.
- Reads skeleton via `read_code`.
- Call graph uses `analyze_relationship` (mode: `calls`) **only when a symbol match is found**.
- Dependencies use `analyze_relationship` (mode: `dependencies`).
- Hotspots from `hotspot_detector`, metadata from `file_profiler`.

**Output (key fields)**

- `success`, `status`, `summary`, `primaryFile`, `structure`/`skeleton`, `symbols`
- `callGraph`, `dependencies`, `relationships: { calls, dependencies }`
- `hotSpots`, `report` (summary + complexity + architecturalRole)
- `pageRankScores` (Map serialized in JSON), `impactRadius`
- `insights`, `visualization`, `guidance`, `internalToolsUsed`

---

### navigate

Find symbols/files with context-aware filtering.

**Parameters**

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| target | string | ✓ | — | Query string |
| context | "definitions" \| "usages" \| "tests" \| "docs" \| "all" | ✗ | "all" | Applies filters and fallbacks |
| limit | number | ✗ | 10 | Max results |

**Behavior**

- Uses `search_project` (symbol search when `context=definitions`).
- For `context=usages`, attempts symbol resolution and returns reference locations.
- For `tests`/`docs`, filters by path or falls back to glob search.
- Enriches results with hotspots and simple PageRank (when single result).
- If exactly one result, attaches `smartProfile` and skeleton preview.

**Output (key fields)**

- `locations[]`: `{ filePath, line, snippet, relevance, type, pageRank, isHotSpot }`
- `relatedSymbols[]`, `codePreview`, `smartProfile` (single-result only)
- `insights`, `visualization`, `guidance`, `internalToolsUsed`

---

### read

Read content with optional profile/hash and symbol-to-file resolution.

**Parameters**

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| target | string | ✓ | — | File path or symbol |
| view | "full" \| "skeleton" \| "fragment" | ✗ | "skeleton" | If `depth=deep`, defaults to `full` |
| lineRange | string \| [number, number] | ✗ | — | "10-20" or `[10, 20]` |
| includeProfile | boolean | ✗ | false | Attaches `profile` |
| includeHash | boolean | ✗ | false | Computes `metadata.hash` |

**Behavior**

- If `target` looks like a symbol, it resolves via `search_project`.
- If `target` is a filename only (e.g. "App.ts"), it resolves via `search_project` (type: filename).
- Reads via `read_code` (view + lineRange), plus `file_profiler`.

**Output (key fields)**

- `content`, `metadata` (filePath, hash, lineCount, language)
- `profile` (optional), `skeleton` (if view is skeleton)
- `guidance`, `insights`, `visualization`, `internalToolsUsed`

---

### change

Safe edits with impact analysis and auto-correction.

**Parameters**

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| intent | string | ✓ | — | Natural-language change description |
| target | string | ✗ | — | Optional file hint |
| targetFiles | string[] | ✗ | — | Optional file list |
| edits | array | ✗ | — | Structured edits (passed to edit_coordinator) |
| options.dryRun | boolean | ✗ | true | When true, returns a plan |
| options.includeImpact | boolean | ✗ | true | Runs impact/deps/hotspots |
| options.autoRollback | boolean | ✗ | — | Reserved (no-op) |
| options.batchMode | boolean | ✗ | — | Reserved (no-op) |

**Behavior**

- If no target is provided, it tries to find one via `search_project`.
- Runs `impact_analyzer`, `analyze_relationship`, `hotspot_detector`.
- Executes `edit_coordinator` (dry-run by default), with auto-correction attempts.

**Output (key fields)**

- `success`, `operation` ("plan" or "apply"), `targetFile`, `diff`, `plan`
- `impactReport` (preview, hotSpots, pageRankDelta, suggestedTests, testPriority)
- `editResult` (only when applied), `transactionId`, `rollbackAvailable`, `autoCorrected`
- `guidance`, `insights`, `visualization`, `internalToolsUsed`

---

### write

Create or overwrite files from intent/template.

**Parameters**

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| intent | string | ✓ | — | Description of what to create |
| targetPath | string | ✗ | — | File path to create/write |
| template | string | ✗ | — | Template name or file path |
| content | string | ✗ | "" | Explicit content takes precedence |

**Behavior**

- If `targetPath` is a filename only, it tries to resolve an existing file via `search_project` (type: filename).
- Creates the file if missing (via `write_file` or `edit_code`).
- If `content` is empty and `template` is provided, generates content.
- Writes via `edit_coordinator`.

**Output (key fields)**

- `success`, `createdFiles[]`, `transactionId`
- `guidance`, `insights`, `visualization`, `internalToolsUsed`

---

### manage

Manage index and edit history.

**Parameters**

| Field | Type | Required | Default | Notes |
|---|---|---|---|---|
| command | "status" \| "undo" \| "redo" \| "reindex" \| "rebuild" \| "history" \| "test" | ✓ | — | `rebuild` maps to `reindex` |
| scope | "file" \| "transaction" \| "project" | ✗ | — | Used mainly by `test` |
| target | string | ✗ | — | Used mainly by `test` |

**Behavior**

- `status` builds dependency graph and returns index status.
- `history` returns undo/redo plus pending transactions.
- `test` suggests tests (project scope returns empty list).

**Output (key fields)**

- `success`, `result`, `projectState` (indexStatus + pendingTransactions)
- `guidance`, `insights`, `visualization`, `internalToolsUsed`

## Quick Tool Selector

Use this decision tree to choose the **Six Pillars** first:

```
What do you need to do?
├─ Understand structure/architecture?  → understand
├─ Modify code safely?                 → change
├─ Find symbols/files?                 → navigate
├─ Read file content?                  → read
├─ Create a file?                      → write
└─ Manage project state?               → manage
```

If you must use legacy tools, enable them via:

- `SMART_CONTEXT_EXPOSE_LEGACY_TOOLS=true`
- `SMART_CONTEXT_LEGACY_AUTOMAP=true`

**Token Cost Comparison (estimated for typical 10K file project):**

| Tool | Min Tokens | Avg Tokens | Max Tokens | Best For |
|------|-----------|-----------|-----------|----------|
| search_project | 500 | 2,000 | 8,000 | Quick exploration |
| read_code (skeleton) | 200 | 800 | 3,000 | Fast understanding |
| read_code (full) | 1,000 | 5,000 | 50,000 | Complete context |
| read_fragment | 100 | 400 | 2,000 | Specific sections |
| analyze_relationship | 1,000 | 4,000 | 15,000 | Impact analysis |
| edit_code | 500 | 2,000 | 10,000 | Making changes |
| analyze_file | 300 | 1,200 | 5,000 | Profile analysis |
| get_batch_guidance | 400 | 1,500 | 6,000 | Planning edits |

---

## Legacy Tool Catalog (Opt-in)

### search_project

**Purpose:** Fast, multi-modal search for files, symbols, and directory structures with BM25F ranking and fuzzy matching.

**When to Use:**
- Locating specific functions, classes, or types
- Finding files by name or content patterns
- Exploring a codebase you're unfamiliar with
- Searching for imports or exports
- Finding test files or configuration

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| query | string | ✓ | — | Search term (e.g., "handleAuth", "config.ts", "middleware") |
| type | string | ✗ | "auto" | Search mode: "auto", "file", "symbol", "directory", "filename" |
| maxResults | number | ✗ | 20 | Maximum results to return (1-100) |
| fileTypes | string[] | ✗ | [] | Filter by extensions (e.g., ["ts", "tsx"]) |
| snippetLength | number | ✗ | 240 | Preview text length in characters (0-1000) |
| matchesPerFile | number | ✗ | 3 | Max matches to show per file |
| groupByFile | boolean | ✗ | false | Combine multiple matches from same file |
| deduplicateByContent | boolean | ✗ | false | Remove duplicate results with identical content |

**Return Format:**

```typescript
interface SearchProjectResult {
  results: Array<{
    type: "file" | "symbol" | "directory" | "filename";
    path: string;
    score: number;                    // 0.0-1.0 confidence
    context?: string;                 // Preview snippet
    line?: number;                    // Line number if applicable
    groupedMatches?: Array<{
      lineNumber: number;
      preview: string;
      score?: number;
    }>;
    matchCount?: number;
  }>;
  inferredType?: string;              // Auto-detected search type
  message?: string;                   // Status/warning message
  suggestions?: ToolSuggestion[];     // Next step recommendations
  nextActionHint?: string;            // Contextual guidance
}
```

**JSON Example (Beginner):**

```json
{
  "query": "auth",
  "type": "auto",
  "maxResults": 5
}
```

Response:
```json
{
  "results": [
    {
      "type": "symbol",
      "path": "src/middleware/auth.ts",
      "score": 0.95,
      "context": "export function authenticate(req: Request): boolean { ... }",
      "line": 12
    },
    {
      "type": "file",
      "path": "src/config/auth.config.ts",
      "score": 0.87
    }
  ],
  "inferredType": "symbol"
}
```

**Usage Patterns:**

**🟢 Beginner: Basic file/symbol search**
```
Goal: Find all authentication-related files
Query: { query: "auth", maxResults: 10 }
Time: ~200ms | Tokens: 800-1200
Next: Use read_code to examine results
```

**🟡 Intermediate: Filtered search with previews**
```
Goal: Find TypeScript middleware functions
Query: {
  query: "middleware",
  type: "symbol",
  fileTypes: ["ts", "tsx"],
  snippetLength: 400,
  maxResults: 15
}
Time: ~300ms | Tokens: 1500-2500
Strategy: Group results, look for patterns in previews
```

**🔴 Advanced: Complex multi-stage search**
```
Goal: Find all implementations of an interface pattern
Stage 1: { query: "implements ErrorHandler", type: "symbol" }
Stage 2: { query: "ErrorHandler.ts", type: "file" }
Stage 3: { query: "error", fileTypes: ["ts"], groupByFile: true }
Time: ~800ms | Tokens: 4000-8000
Strategy: Cross-reference results, build mental map of dependencies
```

**Error Scenarios:**

| Error | Cause | Recovery |
|-------|-------|----------|
| NO_MATCHES | Query too specific or uses wrong syntax | Use simpler terms, try wildcards |
| QUERY_TOO_BROAD | Query returns >1000 results | Add file type filter, refine query |
| INVALID_TYPE | type parameter not recognized | Check: "auto", "file", "symbol", "directory", "filename" |
| TIMEOUT | Complex query on large project | Reduce maxResults, try symbol search instead |

**Performance Characteristics:**

- **Startup:** 50-100ms index warmup
- **P50 Latency:** 150-300ms (simple), 400-800ms (complex)
- **P95 Latency:** 500ms-1.5s
- **P99 Latency:** 1-3s on projects >100K files
- **Memory:** 5-15MB per 10K files indexed

**Related Tools:**
- `read_code` → Examine search results
- `analyze_relationship` → Find callers/dependencies
- `edit_code` → Make changes to found code

---

### read_code

**Purpose:** Retrieve file content in three view modes: full file, token-efficient skeleton, or line ranges.

**When to Use:**
- Understanding a module's structure and interfaces
- Reading a complete file for context
- Getting a "folded" view of functions (skeleton mode)
- Extracting specific line ranges
- Preparing for editing (dry-run reading)

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| filePath | string | ✓ | — | Relative or absolute file path |
| view | string | ✗ | "full" | "full", "skeleton", or "fragment" |
| lineRange | string | ✗ | — | Range spec: "10-20" or "5-" (from line 5) |
| skeletonOptions | object | ✗ | {} | Configure skeleton output |
| skeletonOptions.detailLevel | string | ✗ | "standard" | "minimal", "standard", "detailed" |
| skeletonOptions.includeMemberVars | boolean | ✗ | true | Show class/interface members |
| skeletonOptions.includeComments | boolean | ✗ | false | Include JSDoc/comments in skeleton |
| skeletonOptions.maxMemberPreview | number | ✗ | 3 | Max array/object entries to preview |

**Return Format:**

```typescript
interface ReadCodeResult {
  content: string;           // File content or skeleton
  metadata: {
    lines: number;           // Total line count
    language: string | null; // "typescript", "python", etc.
    path: string;            // Normalized file path
  };
  truncated: boolean;        // True if content exceeded limits
}
```

**Usage Patterns:**

**🟢 Beginner: Quick structure preview**
```
Goal: See function signatures in a file
read_code({ filePath: "src/auth.ts", view: "skeleton" })
Expected: ~400 tokens, class/function names visible
Next step: read_fragment to examine specific functions
```

**🟡 Intermediate: Examination + fragment extraction**
```
Goal: Understand error handling strategy, then read specific handler
Step 1: read_code({ filePath: "src/error/handler.ts", view: "skeleton" })
Step 2: search_project({ query: "catchError", type: "symbol" })
Step 3: read_code({ filePath: "src/error/handler.ts", lineRange: "45-80" })
Token cost: 800 (skeleton) + 1200 (search) + 200 (fragment) = 2200
```

**🔴 Advanced: Multi-view fusion for refactoring**
```
Goal: Refactor callback pattern to async/await in large file
Step 1: Skeleton view to identify all callbacks
Step 2: Search for callback definitions
Step 3: Multiple fragments to examine each callback
Step 4: analyze_relationship to find callers
Step 5: edit_code with dry-run for impact preview
Token cost: 400 + 1500 + (3×300) + 2000 + 2000 = 6500 (with planning)
```

**Error Scenarios:**

| Error | Cause | Recovery |
|-------|-------|----------|
| FILE_NOT_FOUND | File path incorrect or doesn't exist | Use search_project to locate file |
| INVALID_VIEW | view not "full", "skeleton", or "fragment" | Check parameter spelling |
| BAD_LINE_RANGE | Line range outside file bounds | Verify line count in metadata |
| TRUNCATED | File >1MB or >10K lines | Use read_fragment instead |

**Performance Characteristics:**

| View | P50 | P95 | Token Saving |
|------|-----|-----|---------------|
| full | 50-200ms | 200-500ms | 0% (baseline) |
| skeleton | 100-300ms | 300-800ms | 95-98% |
| fragment (100 lines) | 20-50ms | 50-150ms | 85-92% |

**Related Tools:**
- `search_project` → Find files to read
- `read_fragment` → Efficient line-range reading
- `edit_code` → Make changes after reading
- `analyze_relationship` → Understand context

---

### edit_code

**Purpose:** Atomic code modifications (replace, create, delete) with transactional safety, fuzzy matching, and impact preview.

**When to Use:**
- Modifying specific code sections
- Creating new files
- Deleting obsolete code
- Batch refactoring across files
- Testing changes (dry-run mode)
- Recovering from failed edits (undo)

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| edits | array | ✓ | — | Array of edit operations |
| edits[].filePath | string | ✓ | — | Target file path |
| edits[].operation | string | ✓ | — | "replace", "create", or "delete" |
| edits[].targetString | string | ✗ | — | Text to find (for replace) |
| edits[].replacementString | string | ✗ | — | Replacement text (for replace/create) |
| edits[].lineRange | object | ✗ | — | Line bounds: {start: 10, end: 20} |
| edits[].beforeContext | string | ✗ | — | Context before target (for ambiguity) |
| edits[].afterContext | string | ✗ | — | Context after target (for ambiguity) |
| edits[].normalization | string | ✗ | "exact" | Matching strictness: exact→whitespace→structural |
| edits[].fuzzyMode | string | ✗ | — | "whitespace" or "levenshtein" for fuzzy |
| edits[].anchorSearchRange | object | ✗ | {lines:5,chars:100} | Search constraint size |
| edits[].expectedHash | object | ✗ | — | Hash validation {algorithm, value} |
| dryRun | boolean | ✗ | false | Preview changes without applying |
| createMissingDirectories | boolean | ✗ | false | Auto-create directories for new files |
| ignoreMistakes | boolean | ✗ | false | Skip non-critical match failures |
| diffMode | string | ✗ | "myers" | "myers" (line) or "semantic" (AST-aware) |
| refactoringContext | object | ✗ | — | Pattern hint: rename-symbol, move-function, etc. |

**Return Format:**

```typescript
interface EditCodeResult {
  success: boolean;
  results: Array<{
    filePath: string;
    applied: boolean;
    error?: string;
    diff?: string;                  // Unified diff format
    requiresConfirmation?: boolean;
    contentPreview?: string;
    nextActionHint?: {
      suggestReRead: boolean;
      modifiedContent?: string;
      affectedLineRange?: { start: number; end: number };
    };
  }>;
  transactionId?: string;           // For undo/redo
  warnings?: string[];
  message?: string;
}
```

**Normalization Levels** (least to most aggressive):
1. **exact** - Perfect string match only
2. **line-endings** - Normalize \r\n ↔ \n
3. **trailing** - Ignore trailing whitespace
4. **indentation** - Ignore leading whitespace
5. **whitespace** - Collapse all whitespace
6. **structural** - AST-aware matching (code structure, not formatting)

**Usage Patterns:**

**🟢 Beginner: Single file, simple replacement**
```
Goal: Fix typo in variable name
edit_code({
  edits: [{
    filePath: "src/utils.ts",
    operation: "replace",
    targetString: "const maxLenght = 100;",
    replacementString: "const maxLength = 100;"
  }],
  dryRun: true
})
Expected tokens: 400-600
Safety: High (dryRun enabled)
Next: Inspect diff, then run without dryRun
```

**🟡 Intermediate: Batch editing with validation**
```
Goal: Update error handling across 3 files
Step 1: search_project({ query: "catch (e)" }) → find targets
Step 2: read_code for each file (skeleton view)
Step 3: edit_code with beforeContext/afterContext for safety
Step 4: inspect diffs before committing
Safety: Very high (context-based matching)
Token cost: 1500 + 1200 + 2000 = 4700
```

**🔴 Advanced: Large-scale refactoring**
```
Goal: Convert callback pattern to async/await (50+ functions)
Phase 1: Analyze with analyze_relationship
Phase 2: Create edit plan (5-10 edits per iteration)
Phase 3: edit_code with semantic diffing
Phase 4: Use manage_project undo if needed
Phase 5: Use analyze_relationship to verify correctness
Safety strategy: Small batches, dryRun first, incremental validation
Token budget: 15,000-25,000 per phase
```

**Error Scenarios:**

| Error | Cause | Recovery |
|-------|-------|----------|
| NO_MATCH | targetString not found | Add context, relax normalization, check formatting |
| AMBIGUOUS_MATCH | Multiple identical strings | Add beforeContext/afterContext |
| HASH_MISMATCH | File changed between read/edit | Re-read file and retry |
| PATH_OUTSIDE_ROOT | Security violation | Check file path, use relative paths |
| SYNTAX_ERROR | Replacement has syntax issues | Validate with read_code after edit |

**Performance Characteristics:**

- **P50:** 100-500ms (1-10 edits)
- **P95:** 500-1500ms (10-50 edits)
- **Max transaction:** 1000 edits (sharded into batches)
- **Rollback time:** O(n) where n = batch size

**Related Tools:**
- `read_code` → Examine before editing
- `search_project` → Find targets
- `manage_project undo` → Revert changes
- `get_batch_guidance` → Plan multi-file edits
- `analyze_relationship` → Verify impact

---

### analyze_relationship

**Purpose:** Explore code relationships (dependencies, callers, type hierarchy, data flow) with configurable depth and direction.

**When to Use:**
- Understanding what calls a function
- Finding all files that import a module
- Tracing where a variable is used
- Planning safe refactoring (impact analysis)
- Understanding inheritance hierarchies
- Debugging data flow issues
- Estimating change scope before refactoring

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| target | string | ✓ | — | Symbol name, file path, or variable |
| targetType | string | ✗ | "auto" | "auto", "file", or "symbol" |
| mode | string | ✓ | — | "impact", "dependencies", "calls", "data_flow", "types" |
| direction | string | ✗ | "both" | "upstream", "downstream", or "both" |
| maxDepth | number | ✗ | 5 | Graph traversal limit (1-20) |
| contextPath | string | ✗ | — | File context for symbol resolution |
| fromLine | number | ✗ | — | Line number for data_flow mode |

**Modes Explained:**

| Mode | Direction | Shows | Use Case |
|------|-----------|-------|----------|
| impact | downstream | Who depends on this | Before refactoring |
| dependencies | upstream | What this depends on | Understanding context |
| calls | both | Call graph | Function behavior |
| data_flow | both | Variable tracking | Debugging logic |
| types | both | Type relationships | Type system audit |

**Usage Patterns:**

**🟢 Beginner: Find function callers**
```
Goal: See who calls a utility function
analyze_relationship({
  target: "parseJSON",
  mode: "calls",
  direction: "upstream",
  maxDepth: 1
})
Expected: 20-30 results, ~1200 tokens
Use: Quick safety check before modifying
```

**🟡 Intermediate: Pre-refactoring impact analysis**
```
Goal: Understand scope before renaming a module
Step 1: analyze_relationship({ target: "src/auth.ts", mode: "impact" })
Step 2: analyze_relationship({ target: "authenticate", mode: "calls" })
Step 3: Review results to scope refactoring
Expected: 40-60 nodes, 2-4 levels deep, ~3000 tokens
Decision point: Is impact acceptable? Go/no-go
```

**🔴 Advanced: Cross-file dependency verification**
```
Goal: Verify safe extraction of middleware module
Step 1: Analyze all imports of middleware
Step 2: Check for circular dependencies
Step 3: Trace types used by dependents
Step 4: Verify no private/internal symbol leaks
Expected: Deep graph (5-8 levels), 100+ nodes, ~8000 tokens
Output: Can this be extracted safely? Dependencies to move?
```

**Error Scenarios:**

| Error | Cause | Recovery |
|-------|-------|----------|
| SYMBOL_NOT_FOUND | Symbol doesn't exist or is private | Use search_project to verify |
| AMBIGUOUS_TARGET | Multiple symbols match name | Provide contextPath for clarity |
| CIRCULAR_DEPS | Circular dependency detected | Not an error—shows circular structure |
| MAX_DEPTH_EXCEEDED | Graph larger than maxDepth | Increase maxDepth or reduce scope |

**Performance Characteristics:**

- **Startup:** 100-200ms index load
- **P50:** 300-800ms (maxDepth 3)
- **P95:** 1-3s (maxDepth 5)
- **P99:** 3-8s (maxDepth 10)
- **Graph size:** 20-200 nodes typical, 500+ for large projects

**Related Tools:**
- `search_project` → Find target
- `read_code` → Examine relationships
- `edit_code` → Make changes based on analysis
- `get_batch_guidance` → Plan multi-file changes

---

### manage_project

**Purpose:** Undo/redo changes, query project status, and get agent workflow guidance.

**When to Use:**
- Reverting failed edits (undo)
- Redoing after undo
- Checking project indexing status
- Verifying transaction history
- Rebuilding index artifacts
- Suggesting tests for a target

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| command | string | ✓ | — | "undo", "redo", "status", "reindex", "history", "test" |
| detail | string | ✗ | "summary" | "summary" or "full" (status only) |
| includePerFile | boolean | ✗ | false | Include per-file status (status only) |
| limit | number | ✗ | 20 | Max unresolved sample entries (status only) |
| suppressLogs | boolean | ✗ | false | Suppress dependency graph logs (status/reindex) |
| quiet | boolean | ✗ | false | Alias of suppressLogs |

**Command Reference:**

**undo** - Revert last transaction
```json
{ "command": "undo" }
```

**redo** - Restore last undone transaction
```json
{ "command": "redo" }
```

**status** - Project indexing status
```json
{ "command": "status" }
```
Response shows: summary by default. Use `detail: "full"` or `includePerFile: true` for per-file details.

**reindex** - Rebuild search/skeleton/index artifacts
```json
{ "command": "reindex" }
```

**history** - Transaction history
```json
{ "command": "history" }
```
Response shows: undo/redo stacks and pending transactions

**test** - Suggest tests for a target file
```json
{ "command": "test", "target": "src/example.ts" }
```
Response shows: suggested tests (relative paths)

**Usage Patterns:**

**🟢 Beginner: Simple undo on mistake**
```
// Oops, that edit didn't work right
manage_project({ command: "undo" })
// Then try again with different parameters
```

**🟡 Intermediate: Checking status before major refactoring**
```
// Plan major changes
manage_project({ command: "status" })
// If unresolvedImports > threshold, investigate first
manage_project({ command: "reindex" })
```

**🔴 Advanced: Complex workflow with checkpoints**
```
// Checkpoint 1: Status check
manage_project({ command: "status" })
// Series of edits (with dryRun: true first)
edit_code({ edits: [...], dryRun: true })
// Checkpoint 2: If something looks wrong
manage_project({ command: "undo" })
// Adjust strategy, try again
edit_code({ edits: [...], dryRun: false })
```

**Performance Characteristics:**

- **undo:** 50-200ms
- **redo:** 50-200ms
- **status:** 100-500ms (may scan dependencies if not built)
- **reindex:** 0.5-5s (project size dependent)
- **history:** 20-100ms
- **test:** 50-300ms

**Related Tools:**
- `edit_code` → Make changes
- `analyze_relationship` → Verify impact before edits

---

### get_batch_guidance

**Purpose:** Get recommendations for editing multiple related files together, including clustering and companion suggestions.

**When to Use:**
- Planning multi-file refactoring
- Understanding which files should be edited together
- Finding companion files (shared imports, traits, etc.)
- Assessing cross-file impact before changes
- Organizing large batch edits into safe sub-batches

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| filePaths | string[] | ✓ | — | Files to analyze for batch editing |
| pattern | string | ✗ | — | Optional pattern hint (e.g., "add_import", "add_trait") |

**Usage Patterns:**

**🟢 Beginner: Validating file selection**
```
// Before batch editing 5 files:
get_batch_guidance({ filePaths: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts"] })
// Review: Are these naturally grouped? Any missing files?
// Adjust selection if needed
```

**🟡 Intermediate: Smart batching**
```
// Have 20 files to edit, don't want to do all at once
get_batch_guidance({ filePaths: [...20 files...] })
// Receive clusters: Group 1 (5 files), Group 2 (7 files), Group 3 (8 files)
// Execute: edit_code(Group 1), test, edit_code(Group 2), test, etc.
```

**🔴 Advanced: Complex refactoring planning**
```
// Planning: Convert 100+ functions from callbacks to async
Step 1: search_project({ query: "callback" })
Step 2: get_batch_guidance({ filePaths: [...50...], pattern: "callback-to-async" })
Step 3: Execute clusters incrementally
```

**Performance Characteristics:**

- **P50:** 200-600ms
- **P95:** 800-1500ms
- **Max files:** 1000 recommended

**Related Tools:**
- `search_project` → Find files for batch editing
- `read_code` → Understand files before editing
- `edit_code` → Execute batch edits
- `analyze_relationship` → Understand dependencies

---

### read_file

**Purpose:** Low-level file reading with optional metadata, for general-purpose file access.

**When to Use:**
- Reading non-code files (JSON, YAML, config)
- Accessing text files outside main project
- Getting raw file content

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| path | string | ✓ | File path (relative or absolute) |
| view | string | ✗ | "full" or "profile" (metadata only) |

**Related Tools:**
- `read_code` → For code files (preferred)
- `read_fragment` → For line-range reading

---

### write_file

**Purpose:** Write or overwrite file contents.

**When to Use:**
- Creating new non-code files
- Writing generated content
- Creating configuration files

**Note:** Use `edit_code` with operation: "create" for code files (provides safety features).

---

### analyze_file

**Purpose:** Generate comprehensive file analysis including metadata, structure, symbols, and relationships.

**When to Use:**
- Understanding a new file's purpose and structure
- Getting complexity metrics
- Planning extraction/refactoring
- Understanding file dependencies
- Pre-reading analysis

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| filePath | string | ✓ | File to analyze |

**Returns:** File profile with metadata, symbols, complexity, incoming/outgoing dependencies, and reading guidance.

**Usage Patterns:**

**🟢 Beginner: Quick file assessment**
```
analyze_file({ filePath: "src/utils.ts" })
// See: size, complexity, incoming/outgoing connections
```

**🟡 Intermediate: Pre-refactoring analysis**
```
analyze_file({ filePath: "src/services/api.ts" })
// Review: incomingFiles (who imports this?)
// Review: complexity (is it extractable?)
```

**Related Tools:**
- `read_code` → Examine the actual code
- `analyze_relationship` → Understand dependencies in detail

---

### list_directory

**Purpose:** List directory contents with optional recursion.

**When to Use:**
- Exploring project structure
- Finding similar files (e.g., all .test.ts files)
- Understanding directory organization

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| path | string | ✓ | Directory path |
| depth | number | ✗ | Recursion depth (1 = direct children only) |

**Related Tools:**
- `search_project` → Find specific files (preferred)
- `read_code` → Examine files found

---

### read_fragment

**Purpose:** Read specific line ranges from a file efficiently.

**When to Use:**
- Examining specific functions or sections
- Getting line-range context for edits
- Reading large files efficiently
- Avoiding unnecessary token usage

**Parameters:**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| filePath | string | ✓ | File to read from |
| lineRanges | object[] | ✓ | Ranges: [{start: 10, end: 20}, ...] |
| contextLines | number | ✗ | Extra lines before/after each range |
| keywords | string[] | ✗ | Search by keyword (auto line detection) |
| patterns | string[] | ✗ | Regex patterns (auto line detection) |

**Token Savings:**

- Single 100-line fragment: 85-92% savings vs full file
- Multiple ranges: 70-85% savings
- Keyword-based: Varies by match frequency

**Related Tools:**
- `read_code` → For full file reading
- `analyze_file` → Get line numbers first

---

## Tool Composition Patterns

**Pattern 1: Discovery → Examination → Modification**
```
1. search_project (find what to modify)
2. read_code or analyze_file (understand context)
3. read_fragment (inspect specifics)
4. edit_code with dryRun (validate)
5. edit_code final (apply)
6. manage_project undo (if needed)
```

**Pattern 2: Impact Analysis Before Refactoring**
```
1. analyze_relationship (what depends on this?)
2. get_batch_guidance (how to batch edits safely?)
3. edit_code (grouped by batch clusters)
4. analyze_relationship (verify post-edit state)
```

**Pattern 3: Large Refactoring Workflow**
```
1. search_project (find all targets)
2. analyze_file for each (understand scope)
3. get_batch_guidance (cluster by dependency)
4. For each cluster:
   a. read_code (review)
   b. edit_code dryRun (preview)
   c. edit_code final (apply)
   d. manage_project (checkpoint)
5. analyze_relationship (verify all changes)
```

---

## Performance Tuning Tips

**Optimize for speed:**
- Use `read_code` with `skeleton` view (95%+ token savings)
- Use `read_fragment` for large files (85-92% token savings)
- Use `search_project` before reading (avoid blind reads)
- Set `maxResults` to actual needs (not maximum)
- Use `fileTypes` filter to narrow scope

**Optimize for comprehension:**
- Start with `analyze_file` (comprehensive profile)
- Use `skeleton` view for structure
- Use `read_fragment` for specific functions
- Use `read_code` (full) only when necessary
- Use `analyze_relationship` to understand impact

**Optimize for safety:**
- Always use `dryRun: true` first with `edit_code`
- Use `beforeContext` and `afterContext` for fuzzy matches
- Start with `maxDepth: 2` for `analyze_relationship`
- Review diffs carefully before final edits
- Use `manage_project` to undo mistakes

---

## Glossary

**BM25F:** Ranking algorithm that weights matches in different fields (symbol definition, exports, code body, comments)

**Skeleton:** Token-efficient view showing function/class signatures without implementations (95-98% token savings)

**Normalization:** Fuzzy matching strategy from exact → whitespace → structural

**Transactional:** Edit operation that either succeeds completely or fails completely (no partial changes)

**FuzzyMode:** Levenshtein distance matching for typo tolerance

**Data Flow:** Tracking how variables, parameters, and return values move through code

**Dependency Graph:** Network of which files/symbols depend on which others

**Impact Analysis:** Assessing scope of changes before refactoring

---

## See Also

- [AGENT_PLAYBOOK.md](./AGENT_PLAYBOOK.md) - Workflow patterns using these tools
- [../guides/getting-started.md](../guides/getting-started.md) - Quick start
- [../architecture/ADR-INDEX.md](../architecture/ADR-INDEX.md) - Design decisions
