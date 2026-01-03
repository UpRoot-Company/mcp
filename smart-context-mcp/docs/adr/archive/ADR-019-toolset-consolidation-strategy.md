# ADR 019: Toolset Consolidation Strategy

## Status
Accepted

## Context
The current Smart Context MCP server exposes a large number of granular tools (over 15). While these tools provide precise control, they introduce several significant issues for LLM agents consuming the API:

1.  **Token Waste:** The JSON schemas for 15+ tools consume a substantial portion of the system prompt context window, reducing the space available for reasoning and code context.
2.  **Cognitive Load & Choice Paralysis:** Agents often struggle to distinguish between similar tools (e.g., `read_file` vs. `read_fragment`, or `analyze_impact` vs. `get_file_dependencies`). This leads to "hallucinations" regarding tool usage or inefficient trial-and-error loops.
3.  **Workflow Complexity:** Orchestrating complex tasks requires the agent to string together many small tool calls, increasing the risk of failure at each step.

## Decision
We will consolidate the existing granular tools into 5 core "Intent-Based" tools. This strategy shifts the complexity from the *interface* (which tool to pick) to the *arguments* (what mode to use), which LLMs handle more robustly.

The new core toolset will be:

### 1. `read_code` (Unified Reading)
*   **Replaces:** `read_file`, `read_file_skeleton`, `read_fragment`.
*   **Description:** Reads content or structure of files.
*   **Key Parameters:**
    *   `filePath`: string
    *   `view`: enum (`"full"`, `"skeleton"`, `"fragment"`)
    *   `lineRange`: string (optional, for fragment mode)

### 2. `search_project` (Unified Search)
*   **Replaces:** `search_files`, `list_directory`, `search_symbol_definitions`, `search_with_context`.
*   **Description:** Omni-search for files, symbols, and directories.
*   **Implementation Note:** This will heavily leverage the ClusterSearch engine defined in ADR-018 to provide context-aware results.

### 3. `analyze_relationship` (Unified Analysis)
*   **Replaces:** `get_file_dependencies`, `analyze_impact`, `analyze_symbol_impact`, `analyze_type_dependencies`, `trace_data_flow`, `find_referencing_symbols`.
*   **Description:** Analyzes code relationships, dependencies, and data flow.
*   **Key Parameters:**
    *   `target`: string (file path or symbol)
    *   `mode`: enum (`"impact"`, `"dependencies"`, `"calls"`, `"data_flow"`)
    *   `direction`: enum (`"upstream"`, `"downstream"`, `"both"`)

### 4. `edit_code` (Unified Modification)
*   **Replaces:** `edit_file`, `batch_edit`, `write_file`.
*   **Description:** Performs atomic edits on one or more files.
*   **Structure:** Inputs will be standardized to an array of edit operations, effectively making "batch" the default mode.
*   **Note:** `write_file` (full overwrite) will be handled as a specific case within this tool or deprecated in favor of robust editing.

### 5. `manage_project` (Management & History)
*   **Replaces:** `undo_last_edit`, `redo_last_edit`, `get_workflow_guidance`, `get_index_status`.
*   **Description:** Manages project state, history, and provides agent guidance.

## Consequences

### Positive
*   **Reduced Token Usage:** Significantly smaller system prompt footprint.
*   **Improved Agent Performance:** clearer choices reduce tool selection errors.
*   **Simplified Interface:** Easier for new agent implementations to integrate.

### Negative
*   **Internal Complexity:** The implementation of these facade tools will need to route requests to the appropriate internal logic (the existing granular implementations).
*   **Migration Effort:** Existing clients/agents using the granular tools will need to update to the new schema. (Granular tools may be kept as deprecated for a transition period).

## Implementation Plan
1.  Implement `search_project` leveraging the ADR-018 ClusterSearch backend.
2.  Implement `read_code` wrapper.
3.  Implement `analyze_relationship` wrapper.
4.  Implement `edit_code` wrapper.
5.  Implement `manage_project`.
6.  Update `index.ts` to export the new tools.
