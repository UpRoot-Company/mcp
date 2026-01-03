# ADR-031: Unified Runtime and Testing Data Structure

**Status:** Proposed
**Date:** 2025-12-18
**Author:** devkwan & Gemini Orchestrator
**Related:** ADR-028 (Persistent Index), ADR-030 (Intelligence & Resilience)

---

## 1. Context

Currently, `smart-context-mcp` generates data in various locations:
- `.mcp/smart-context/` for some indices.
- `.smart-context/` for language configurations.
- System temporary directory (`os.tmpdir()`) for tests and benchmarks.
- Scattered backup directories for file edits.

This fragmentation makes it difficult for users to manage workspace cleanliness and for agents to reliably locate metadata.

## 2. Decision

We will consolidate all runtime, configuration, and testing data into a single root directory named **`.smart-context/`** at the project root.

### Folder Structure
```text
.smart-context/
├── data/                # Persistent runtime data
│   ├── index/           # ProjectIndex, SQLite DB, TrigramIndex
│   ├── cache/           # Generated skeletons, AST snapshots
│   └── history/         # Transaction logs, File backups
├── config/              # Local project-specific settings
└── temp/                # Ephemeral data (Auto-cleanup target)
    ├── tests/           # Isolated test run environments
    └── benchmarks/      # Performance measurement artifacts
```

### Path Management Policy
1. **Centralization**: All modules MUST resolve paths through a central `PathManager` utility.
2. **Environment Awareness**: The root directory (`.smart-context`) can be overridden via `SMART_CONTEXT_DIR` environment variable.
   - Legacy `.mcp/` paths are treated as deprecated and ignored unless `SMART_CONTEXT_ALLOW_LEGACY_MCP_DIR=true` is set.
3. **Test Isolation**: Tests must use subdirectories within `.smart-context/temp/tests/` instead of the system temp folder to prevent polluting the host OS.

## 3. Technical Implementation

### PathManager Utility
A new `PathManager` class will be implemented in `src/utils/PathManager.ts` to provide standardized path resolution.

### Migration Plan
1. Refactor `IncrementalIndexer` and `IndexDatabase` to use `data/index/`.
2. Refactor `SkeletonCache` to use `data/cache/`.
3. Refactor `EditorEngine` and `HistoryEngine` to use `data/history/`.
4. Update `jest.setup.ts` or test helpers to redirect all temporary file creation to `temp/tests/`.

## 4. Consequences

### Positive Impacts ✅
- **Clean Workspace**: Users only need to ignore or delete one folder to reset the tool.
- **Portability**: Operating data is neatly packed for potential sync or backup.
- **Debugging**: Test failures leave traces in a predictable `temp/tests` location instead of random system temp paths.

### Negative Impacts ⚠️
- **Migration Overhead**: Existing users will need a one-time re-indexing as old `.mcp/` paths are abandoned.
- **Gitignore Requirements**: Users must ensure `.smart-context/data/` and `.smart-context/temp/` are in `.gitignore`.
