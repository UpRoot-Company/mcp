# ADR 027: Fix Indexing Synchronization Issues

## 1. Context

Currently, the `smart-context-mcp` experiences synchronization issues where internal indices and cached information do not reflect the latest state of the file system, especially after modifications to `.gitignore` or configuration files like `tsconfig.json`. This leads to inaccurate results from tools such as `search_project`, `analyze_relationship`, and `list_directory`.

**Root Causes Identified:**
*   **Intended Processing Delay (Batching Delay):** `IncrementalIndexer` batches file system changes, introducing a delay (50ms - 500ms) for performance, which means immediate tool queries might reflect an older state.
*   **`.gitignore` Changes Not Fully Applied:** When `.gitignore` is modified, `IncrementalIndexer` detects the change in the `.gitignore` file itself but lacks the logic to trigger a full re-evaluation and purge/re-index of files based on the *new* ignore rules from the `IndexDatabase`. Files that should be ignored may still appear, and newly un-ignored files might not be indexed promptly.
*   **Configuration File Changes Not Handled:** Changes to crucial configuration files like `tsconfig.json` (for path aliases, module resolution) are not actively monitored or used to trigger a reload of relevant caches (e.g., `ModuleResolver`). This results in persistent incorrect behavior until the server is restarted.
*   **File Deletion/Rename/Symbol Change Lag:** While `IncrementalIndexer` handles these events, the propagation of these changes (e.g., updating dependencies in other files) is subject to batching delays, leading to temporary inconsistencies in relationship graphs.

## 2. Decision

Implement a multi-stage patch plan to address indexing synchronization issues, focusing on immediate fixes for critical configuration files and laying the groundwork for future architectural improvements.

## 3. Proposed Plan

### **Stage 1: Immediate Critical File Change Detection & Response (Short-Term)**

Focus on resolving immediate issues with `.gitignore` and `tsconfig.json`.

**3.1. `.gitignore` Change Detection and Index Cleanup**

*   **(수정) `IncrementalIndexer.ts`**:
    *   Explicitly add `.gitignore` to `chokidar`'s watch list.
    *   On `.gitignore` change, trigger a new `handleIgnoreChange()` function:
        1.  Reload `.gitignore` rules.
        2.  Query `IndexDatabase` for all indexed files.
        3.  Compare with new rules: **delete (purge)** files from `IndexDatabase` that are now ignored.
        4.  Rapidly scan the file system to **add (re-index)** files that are no longer ignored into the indexing queue.

**3.2. `tsconfig.json` / `jsconfig.json` Change Detection and Module Resolver Reset**

*   **(수정) `IncrementalIndexer.ts`**:
    *   Add `tsconfig.json` and `jsconfig.json` to `chokidar`'s watch list.
    *   On change, call a new `handleModuleConfigChange()` function.
*   **(수정) `ModuleResolver.ts`**:
    *   Add a public method (e.g., `reloadConfig()`) to clear internal caches and re-read `tsconfig.json` to apply new path aliases.
*   **(수정) `DependencyGraph.ts`**:
    *   After `ModuleResolver` reload, trigger a re-analysis for previously "unresolved" dependencies in `DependencyGraph`.

**3.3. Add Manual Synchronization Command**

*   **(수정) `index.ts` (SmartContextServer)**:
    *   Add new `manage_project reindex` command to `executeManageProject()`
    *   Clear the `IndexDatabase` and force `IncrementalIndexer` to perform a full project re-scan
    *   See ADR-027-Implementation-Details.md for complete specifications

### **Stage 2: Architectural Enhancements and UX Improvement (Mid-to-Long-Term)**

After Stage 1, implement further improvements for robustness and user experience.

**3.4. Introduce Configuration Manager**

*   Design a `ConfigurationManager` class to centralize reading, watching, and notifying modules about changes in all key configuration files (`.gitignore`, `tsconfig.json`, `package.json` etc.). This will be an event-driven system.

**3.5. Implement Priority-Based Indexing Queue**

*   Upgrade `IncrementalIndexer`'s queue from FIFO to a priority queue:
    *   **High Priority:** User's active file, configuration file changes.
    *   **Medium Priority:** Files directly dependent on currently open files.
    *   **Low Priority:** General background indexing.

**3.6. Visualize Indexing Status**

*   Enhance `manage_project`'s `status` command to expose ongoing indexing activities (e.g., "re-indexing based on .gitignore change...", "TS Server reloading...").

## 4. Related Documentation

**Detailed Implementation Guide:** See [ADR-027-Implementation-Details.md](./ADR-027-Implementation-Details.md)

This supplementary document provides:
- Exact code changes needed for each component
- Method signatures and implementations
- Integration points and dependency chains
- Testing strategy and success criteria
- Complete integration checklist

## 5. Consequences

*   **Positive:**
    *   Significantly improved accuracy of `search_project`, `analyze_relationship`, `list_directory`, and other tools after configuration changes.
    *   Reduced user confusion due to stale information.
    *   Increased reliability for refactoring and code understanding features.
    *   Provides a manual escape hatch for unforeseen synchronization issues.
*   **Negative:**
    *   Initial implementation effort for Stage 1.
    *   Stage 2 requires more significant architectural refactoring.
    *   Potential for temporary performance overhead during forced re-indexing, especially on very large projects (mitigated by batching and incremental updates).
