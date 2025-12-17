# ADR 019: Toolset Consolidation Strategy

## Status
Accepted

## Context
The current Smart Context MCP server exposes over 15 granular tools. While powerful, this granularity introduces significant friction for LLM agents:

1.  **Token Waste:** Tool definitions consume a large context window.
2.  **Cognitive Load:** Agents struggle to select between overlapping tools (e.g., `read_file` vs `read_fragment`).
3.  **Complexity:** Multi-step workflows are brittle.

## Decision
We will consolidate the toolset into 5 core "Intent-Based" tools. This shifts complexity from *tool selection* to *parameterization*.

### 1. `read_code`
**Consolidates:** `read_file`, `read_file_skeleton`, `read_fragment`.

*   **Interface:**
    ```typescript
    read_code({
      filePath: string,
      view: "full" | "skeleton" | "fragment",
      lineRange?: string // e.g. "10-20", used only for 'fragment'
    })
    ```
*   **Logic:**
    *   `full` -> calls `fs.readFile` (wraps existing `read_file`).
    *   `skeleton` -> calls `SkeletonGenerator` (wraps `read_file_skeleton`).
    *   `fragment` -> calls internal fragment reader (wraps `read_fragment`).

### 2. `search_project`
**Consolidates:** `search_files`, `list_directory`, `search_symbol_definitions`, `search_with_context`.

*   **Interface:**
    ```typescript
    search_project({
      query: string, // Natural language or exact match
      type?: "file" | "symbol" | "directory" // Optional hint
    })
    ```
*   **Logic:**
    *   Backed by `ClusterSearchEngine` (ADR-017).
    *   `QueryParser` determines intent if `type` is omitted.

### 3. `analyze_relationship`
**Consolidates:** `get_file_dependencies`, `analyze_impact`, `analyze_symbol_impact`, `analyze_type_dependencies`, `trace_data_flow`.

*   **Interface:**
    ```typescript
    analyze_relationship({
      target: string, // File path OR Symbol name
      mode: "impact" | "dependencies" | "calls" | "data_flow" | "types",
      direction?: "upstream" | "downstream" | "both", // Default: "both"
      maxDepth?: number // Default: varies by mode
    })
    ```
*   **Logic:**
    *   **Target Resolution:** If `target` matches a file path, analyze file. If it matches a symbol, analyze symbol. (Agent should prefer providing `filePath` if known, or `search_project` first).
    *   `dependencies` -> `DependencyGraph.getDependencies`
    *   `impact` -> `DependencyGraph.analyzeImpact`
    *   `calls` -> `CallGraphBuilder.analyzeSymbol`
    *   `types` -> `TypeDependencyTracker.analyzeType`
    *   `data_flow` -> `DataFlowTracer.trace`

### 4. `edit_code`
**Consolidates:** `edit_file`, `batch_edit`, `write_file`.

*   **Interface:**
    ```typescript
    edit_code({
      edits: Array<{
        filePath: string,
        operation: "replace" | "create" | "delete",
        targetString?: string,
        replacementString?: string
      }>,
      dryRun?: boolean
    })
    ```
*   **Logic:**
    *   Always treated as a batch operation via `EditCoordinator.applyBatchEdits`.
    *   Single file edits are just a batch of 1.
    *   `create` operation replaces `write_file`.

### 5. `manage_project`
**Consolidates:** `undo`, `redo`, `get_workflow_guidance`, `index_status`.

*   **Interface:**
    ```typescript
    manage_project({
      command: "undo" | "redo" | "guidance" | "status"
    })
    ```

## Migration Strategy
1.  **Phase 1 (Deprecation):** Mark old tools as deprecated but keep them functional.
2.  **Phase 2 (Facade):** Implement new tools as wrappers around existing engines.
3.  **Phase 3 (Removal):** Remove old tool definitions from `index.ts`.

## Consequences
*   **Pros:** ~60% reduction in system prompt tokens. Higher agent success rate.
*   **Cons:** Loss of some granular control (e.g., specific fuzzy match settings in `edit_file` might be hidden behind defaults, though can be exposed if needed).
