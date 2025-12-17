# ADR-005: Reliability and Transactional Editing

## 1. Context
This document outlines the design for the next phase of `smart-context-mcp` development, based on the insights gathered from `IMPROVEMENT-NOTES-smart-context-mcp.md`, a supplementary analysis by Codex, and a cross-validation review by Claude. The consensus is that while the core engine for single-file editing is robust, the top priorities are enhancing user safety (especially in non-Git environments) and enabling reliable multi-file refactoring. This ADR details the architecture for automatic backups, an undo/redo mechanism, and transactional batch edits.

## 2. Decision
We will implement a three-phase roadmap focusing on reliability, transactional consistency, and enhanced agent intelligence. Each phase will be accompanied by a rigorous testing strategy to ensure correctness and prevent regressions.

- **Phase 1: Immediate Safety Net:** Implement features to prevent irreversible mistakes (auto-backup, undo, Levenshtein).
- **Phase 2: Complex Refactoring Foundation:** Introduce a transactional system for atomic multi-file edits.
- **Phase 3: Agent Intelligence Amplification:** Design tools for structural code understanding and high-level workflows.

## 3. Phase 1: Immediate Safety Net - Design & Testing

### 3.1. Auto-Backup Mechanism
- **Design:**
  - In `EditorEngine.applyEdits`, before `writeFileAsync` is called (and only if `dryRun` is `false`), the original file content will be written to a backup file.
  - The backup file will be named with a `.bak` suffix (e.g., `my_file.ts.bak`) and placed in the same directory.
  - To prevent clutter, only one generation of `.bak` file will be kept. If a `.bak` file already exists, it will be overwritten.
- **Testing Strategy:**
  - **Unit Test:** In `replace_in_file.test.ts`, add a test case that calls `edit_file` and asserts that a `.bak` file with the original content is created.
  - **Unit Test:** Add a test case to ensure `dryRun: true` does *not* create a `.bak` file.

### 3.2. Undo/Redo Tooling
- **Design:**
  - A new `HistoryEngine.ts` will be created to manage edit history.
  - It will store a log of edit operations in a JSON file at `.mcp/history.json`. Each entry will contain a timestamp, the original `filePath`, and a **structured change record** (e.g., a set of inverse patches containing the original content and range) rather than just the human-readable string diff. This ensures that the undo operation is robust and does not rely on parsing brittle string diffs.
  - **New Tool `undo_last_edit`**: Reads the latest entry from `history.json`, applies the stored inverse patches to the target file.
  - **New Tool `redo_last_edit`**: Re-applies the forward patches of a previously undone edit.
- **Testing Strategy:**
  - **Unit Test (`HistoryEngine.test.ts`):** A new test file to verify history log creation, reading, and management.
  - **Integration Test:** In `replace_in_file.test.ts`, add a test that performs an `edit_file`, then calls `undo_last_edit`, and asserts the file content is reverted to its original state.

### 3.3. Levenshtein Fuzzy Matching Implementation
- **Design:**
  - In `EditorEngine.findMatch`, the `if (edit.fuzzyMode === 'levenshtein')` block will be fully implemented.
  - It will iterate through all `validMatches` (matches found via exact regex).
  - For each match, it will calculate the Levenshtein distance between `edit.targetString` and the matched text using the `fast-levenshtein` library.
  - It will select the match with the lowest distance, provided the distance is below a certain threshold (e.g., `distance <= edit.targetString.length * 0.3`).
  - If no match is within the threshold, or if multiple matches have the same lowest distance, it will throw an `Ambiguous match` error.
- **Testing Strategy:**
  - **Unit Test:** In `replace_in_file.test.ts`, add a new test file with slightly incorrect `targetString`s (e.g., typos) and `fuzzyMode: 'levenshtein'`. Assert that the correct location is still found and edited.
  - **Unit Test:** Add a test case where the typo is too significant (exceeds the threshold) and assert that the edit fails with an appropriate error.

## 4. Phase 2: Complex Refactoring Foundation - Design & Testing

### 4.1. `edit_files_batch` Tool and `EditTransaction` Class
- **Design:**
  - **New Tool `edit_files_batch`**: Accepts an array of `{ filePath: string, edits: EditOperation[] }`.
  - **New `EditTransaction.ts` Class**:
    - `constructor(rootPath: string)`
    - `stage(filePath: string, edits: EditOperation[])`: Reads the file, calculates the new content in memory using `EditorEngine`, and stores it in a private `stagedFiles` map (`Map<string, { originalContent: string, newContent: string }>`). All `findMatch` and conflict detection logic is run here. If any edit fails, the entire transaction is aborted.
    - `commit(dryRun: boolean)`: If `dryRun` is true, calculates diffs for all staged files and returns them. If `dryRun` is false, it writes all `newContent` from `stagedFiles` to the actual files.
    - `rollback()`: Clears the `stagedFiles` map.
  - The `handleCallTool` in `index.ts` will instantiate `EditTransaction`, loop through the batch to `stage` each edit, and then call `commit`. A `try...catch` block will wrap the process to call `rollback` on failure.
- **Testing Strategy:**
  - **Integration Test (`batch_edit.test.ts`):** A new test file dedicated to `edit_files_batch`.
    - **Success Case:** Test a batch edit across 2-3 files and assert that all files are modified correctly.
    - **Failure Case (Rollback):** Test a batch where one file edit is designed to fail (e.g., ambiguous match). Assert that *none* of the files in the batch are modified.
    - **Dry Run Case:** Test a `dryRun` batch edit and assert that the correct diffs are returned without any files being modified.

### 4.2. Structured Diff Response
- **Design:**
  - The `EditResult` type in `types.ts` will be updated to include an optional `structuredDiff: { filePath: string, diff: string, added: number, removed: number }[]`.
  - The `dryRun` response from `edit_file` and `edit_files_batch` will populate this new field. The `diff` property will remain for backward compatibility and human-readable output.
- **Testing Strategy:**
  - **Unit Test:** Update `replace_in_file.test.ts` and `batch_edit.test.ts` dry run tests to assert the presence and correctness of the `structuredDiff` field.

## 5. Phase 3: Agent Intelligence Amplification - Design & Testing

### 5.1. AST-Based Contextual Tools
- **Design (Conceptual):**
  - Introduce `tree-sitter` as a new dependency.
  - **New Tool `get_symbol_definition`**: Accepts `{ filePath: string, symbolName: string }`. It will parse the file into an AST and traverse it to find the definition of the specified symbol (function, class, variable), returning its content and line range.
- **Testing Strategy:**
  - **Unit Test (`ast_tools.test.ts`):** A new test file with sample code files (e.g., TypeScript, Python). Test that `get_symbol_definition` can correctly locate and extract various code constructs.

### 5.2. High-Level Workflow Tool (`smart_search_and_edit`)
- **Design (Conceptual):**
  - **New Tool `smart_search_and_edit`**: Accepts a high-level request like `{ query: string, change: string, fileGlobs?: string[] }`.
  - **Internal Workflow:**
    1.  Call `search_files` with the `query`.
    2.  Analyze search results to identify the most relevant file and location.
    3.  Call `read_fragment` to get context around the location.
    4.  (Potentially interact with the LLM again to confirm the edit plan).
    5.  Construct and execute an `edit_file` call.
  - This tool will be highly experimental and will encapsulate complex agent logic.
- **Testing Strategy:**
  - **E2E Test:** A new end-to-end test that simulates an agent trying to perform a simple refactoring task (e.g., "In all `.ts` files, rename the function `oldName` to `newName`"). Assert that the high-level tool successfully completes the task.

## 6. Next Steps
1.  Implement **Phase 1** features and their corresponding tests.
2.  After Phase 1 is stable, proceed with **Phase 2**.
3.  **Phase 3** will be treated as a separate, future epic requiring its own dedicated ADR. This document serves as the initial conceptual design.