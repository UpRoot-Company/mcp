# ADR-002: Smart Engine Refactoring & Tool Separation

## 1. Context
The initial implementation of `smart-context-mcp` successfully proved the concept of local file operations without external AI SDKs. However, to distinguish this tool from simple shell wrappers and provide true "smart" context management for LLMs, we need to restructure the codebase. The user specifically requested distinct tools for distinct purposes (`read_file`, `write_file`, `edit_file`, etc.) backed by sophisticated algorithms, rather than a monolithic "do-it-all" tool.

## 2. Goals
1.  **Tool Separation:** Provide clear, purpose-built endpoints for LLMs (`read_file`, `read_fragment`, `write_file`, `edit_file`, `search_files`, `list_directory`).
2.  **Smart Logic:** Implement non-trivial algorithms for context optimization, safety, and token efficiency.
3.  **Engine Architecture:** Separate core logic (`src/engine/`) from the MCP server interface (`src/index.ts`).

## 3. Architecture

```
smart-context-mcp/
├── src/
│   ├── index.ts            # MCP Server entry point (Controller)
│   ├── types.ts            # Shared interfaces
│   └── engine/             # Core Logic Modules
│       ├── FileSystem.ts   # Safe fs wrappers, .gitignore parsing
│       ├── Search.ts       # Grep execution, ranking, deduplication
│       ├── Context.ts      # Interval merging, tree visualization
│       └── Editor.ts       # Batch apply, conflict detection, anchoring
```

## 4. Smart Features Detail

### 4.1. `list_directory` (Engine: `Context.ts` + `FileSystem.ts`)
*   **Algorithm:** **Token-Optimized Tree Generation**
*   **Logic:**
    1.  Parse `.gitignore` to automatically exclude irrelevant files (node_modules, dist, etc.).
    2.  Traverse directory structure.
    3.  Generate a visual tree string (e.g., `├── src/`) instead of a flat list to save tokens and convey structure.
    4.  Implement `depth` limit and `max_items` to prevent token overflow.

### 4.2. `read_fragment` (Engine: `Context.ts`)
*   **Algorithm:** **Interval Merging** (Already implemented, to be moved)
*   **Logic:**
    1.  Locate relevant line numbers via `Search` engine.
    2.  Expand ranges by `context_lines`.
    3.  Merge overlapping/adjacent intervals `[1,5] + [4,8] -> [1,8]`.
    4.  (Future) Token budgeting: Drop lowest priority chunks if limit exceeded.

### 4.3. `edit_file` (Engine: `Editor.ts`)
*   **Algorithm:** **Batch Conflict Detection & Atomic Assembly**
*   **Logic:**
    1.  **Scan:** Find all exact positions of `targetString`s.
    2.  **Verify:** Check uniqueness constraints and anchors (`before`/`after`).
    3.  **Conflict Check:** Sort edits by start index. Check if `Edit[i].start < Edit[i-1].end`. If yes -> **Throw Error** (Prevent broken code).
    4.  **Assemble:** Construct the new file content string in memory (String Builder pattern) rather than multiple file writes.
    5.  **Dry Run:** Return diff preview without writing.

### 4.4. `search_files` (Engine: `Search.ts`)
*   **Algorithm:** **Deduplication & Ranking**
*   **Logic:**
    1.  Execute optimized `grep` (or `ripgrep` if available).
    2.  Group matches by file.
    3.  (Future) Rank by match count or relevance.

## 5. Interface Definition (Proposed Tools)

| Tool Name | Parameters | Description |
| :--- | :--- | :--- |
| `read_file` | `path` | Read entire file content. |
| `read_fragment` | `path`, `keywords`, `lines`, `context` | Read specific parts of a file (smart extract). |
| `write_file` | `path`, `content` | Create new file or overwrite entire content. |
| `edit_file` | `path`, `edits: [{target, replace, ...}]`, `dryRun` | Apply multiple smart edits to a file. |
| `search_files` | `path`, `query`, `includes`, `excludes` | Search for string/regex across files. |
| `list_directory` | `path` | Get directory structure (tree view). |

## 6. Migration Plan
1.  Create `src/engine` directory.
2.  Refactor `scout` logic to `Search.ts`.
3.  Refactor `read` logic to `Context.ts`.
4.  Implement `Editor.ts` with new Batch logic.
5.  Update `index.ts` to register the 6 new tools and delegate to engines.
