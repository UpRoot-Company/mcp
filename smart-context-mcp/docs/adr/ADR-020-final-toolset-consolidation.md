# ADR 020: Toolset Consolidation Strategy

## Status
Accepted

## Context
The current Smart Context MCP server exposes over 15 granular tools. While precise, this granularity causes:
1.  **Token Waste:** Excessive JSON schema overhead in system prompts.
2.  **Cognitive Load:** Choice paralysis for agents (e.g., `read_file` vs `read_fragment`).
3.  **Brittle Workflows:** High risk of failure in multi-step chains.

## Decision
We will consolidate the toolset into 5 core "Intent-Based" tools with robust, unified interfaces. This shifts complexity from *tool selection* to *parameterization*.

### 1. `read_code`
**Consolidates:** `read_file`, `read_file_skeleton`, `read_fragment`.

*   **Interface:**
    ```typescript
    interface ReadCodeArgs {
      filePath: string;
      view: "full" | "skeleton" | "fragment";
      lineRange?: string; // e.g. "10-20", required if view="fragment"
    }
    
    interface ReadCodeResult {
      content: string; // The code content or JSON string of structure
      metadata: {
        lines: number;
        language: string;
        path: string;
      };
      truncated: boolean; // True if content exceeded token limits
    }
    ```
*   **Logic:**
    *   `full`: Reads file via `fs`. Returns full text.
    *   `skeleton`: Uses `SkeletonGenerator` to return definitions/signatures.
    *   `fragment`: Reads specific lines. Throws error if `lineRange` is invalid.
    *   **Limits:** Max file size 1MB (configurable). Truncates with warning if exceeded.

### 2. `search_project`
**Consolidates:** `search_files`, `list_directory`, `search_symbol_definitions`, `search_with_context`.

*   **Interface:**
    ```typescript
    interface SearchProjectArgs {
      query: string; // Search term, glob pattern, or natural language question
      type?: "auto" | "file" | "symbol" | "directory"; // Default: "auto"
      maxResults?: number; // Default: 20
    }

    interface SearchProjectResult {
      results: Array<{
        type: "file" | "symbol" | "directory";
        path: string;
        score: number; // Relevance 0-1
        context?: string; // Snippet or summary
        line?: number;
      }>;
      inferredType?: string; // What 'auto' resolved to
    }
    ```
*   **Logic:**
    *   Backed by `ClusterSearchEngine`.
    *   If `type="auto"`, `QueryParser` infers intent. If inference is low confidence, performs a broad search.

### 3. `analyze_relationship`
**Consolidates:** `get_file_dependencies`, `analyze_impact`, `analyze_symbol_impact`, `analyze_type_dependencies`, `trace_data_flow`.

*   **Interface:**
    ```typescript
    interface AnalyzeRelationshipArgs {
      target: string; // File path or Symbol name
      targetType?: "auto" | "file" | "symbol"; // Default: "auto"
      mode: "impact" | "dependencies" | "calls" | "data_flow" | "types";
      direction?: "upstream" | "downstream" | "both"; // Default: "both"
      maxDepth?: number; // Default: 3 (calls), 1 (deps), 20 (impact)
    }

    interface AnalyzeRelationshipResult {
      nodes: Array<{ id: string; type: string; path?: string }>;
      edges: Array<{ source: string; target: string; relation: string }>;
      resolvedTarget: { type: string; path: string }; // What 'auto' resolved to
    }
    ```
*   **Logic:**
    *   **Resolution:** If `targetType="auto"`, checks filesystem first. If file exists, treat as file. Else, treat as symbol.
    *   **Modes:**
        *   `dependencies`: File-level imports/exports (`DependencyGraph`).
        *   `impact`: Transitive file impact (`DependencyGraph`).
        *   `calls`: Function call graph (`CallGraphBuilder`).
        *   `types`: Type hierarchy (`TypeDependencyTracker`).
        *   `data_flow`: Variable tracing (`DataFlowTracer`).

### 4. `edit_code`
**Consolidates:** `edit_file`, `batch_edit`, `write_file`.

*   **Interface:**
    ```typescript
    interface EditCodeArgs {
      edits: Array<{
        filePath: string;
        operation: "replace" | "create" | "delete";
        targetString?: string;      // Required for 'replace'
        replacementString?: string; // Required for 'replace' and 'create'
      }>;
      dryRun?: boolean; // Default: false
      createMissingDirectories?: boolean; // Default: false
      ignoreMistakes?: boolean; // Default: false (if true, attempts fuzzy match recovery)
    }

    interface EditCodeResult {
      success: boolean;
      results: Array<{
        filePath: string;
        applied: boolean;
        error?: string;
        diff?: string;
      }>;
      transactionId?: string; // For undo
    }
    ```
*   **Logic:**
    *   **Atomicity:** All-or-Nothing. If one edit fails (and `ignoreMistakes` is false), the entire transaction rolls back using `EditCoordinator`.
    *   **Create:** explicitly handles file creation. Fails if file exists unless `operation="replace"` (full content replace) is implied, but here `create` implies new file.
    *   **Validation:** Checks `targetString` uniqueness before applying.

### 5. `manage_project`
**Consolidates:** `undo`, `redo`, `get_workflow_guidance`, `index_status`.

*   **Interface:**
    ```typescript
    interface ManageProjectArgs {
      command: "undo" | "redo" | "guidance" | "status";
    }

    interface ManageProjectResult {
      output: string; // Human readable result
      data?: any; // Structured data (e.g. status metrics)
    }
    ```

## Error Handling & Safety
1.  **Standardized Errors:** All tools return standardized error codes (e.g., `FILE_NOT_FOUND`, `AMBIGUOUS_MATCH`, `TOKEN_LIMIT_EXCEEDED`).
2.  **Path Traversal:** All paths are normalized and verified to be within the project root.
3.  **Atomicity:** `edit_code` guarantees state consistency.

## Migration Strategy
1.  **Phase 1 (Deprecation):** Mark old tools as deprecated. Log warnings on usage.
2.  **Phase 2 (Facade):** Implement new tools as wrappers. Test coverage must reach parity.
3.  **Phase 3 (Removal):** Remove old tools.

### Legacy Tool Removal Plan (2025)
To avoid breaking existing MCP clients, we will execute the following concrete steps after v2.2.0:

1. **Telemetry + Warning Window (Now → 2026-01-15)**
  - Emit a structured warning (code: `LEGACY_TOOL_DEPRECATED`) whenever `read_file`, `search_files`, etc. are invoked.
  - Count per-tool usage via `SMART_CONTEXT_LEGACY_TOOL_METRICS` log events so we can publish adoption stats.
  - Document the warning in README / release notes so agents understand how to migrate.

2. **Soft Disable in CI (2026-01-16 → 2026-02-15)**
  - Add an env flag `SMART_CONTEXT_DISABLE_LEGACY=true` to fail CI if legacy tools are still referenced in smoke tests.
  - Update internal agents/bots to run with the flag enabled so regressions surface before GA removal.

3. **Hard Removal (2026-02-28)**
  - Delete the legacy handlers from `src/index.ts` and strip the compatibility note from the README.
  - Remove associated unit tests/benchmarks (`read_file.test.ts`, `search_files.test.ts`, etc.).
  - Publish a migration notice in the changelog, pointing to the five intent tools as the only supported surface.

4. **Post-Removal Cleanup (March 2026)**
  - Drop backup copies of legacy docs in `.mcp/backups/`.
  - Collapse telemetry dashboards to the new intents only.
  - Verify no downstream repos import the removed tool names (search in `UpRoot-*` GitHub org).

## Consequences
*   **Pros:** ~60% token reduction. Robust interfaces. Atomic editing.
*   **Cons:** Higher initial complexity in the facade layer. Requires agents to adapt to new "intent" based parameterization.
