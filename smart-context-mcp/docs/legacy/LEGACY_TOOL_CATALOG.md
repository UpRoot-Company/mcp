# Legacy Tool Catalog (Opt-in)

This catalog exists to support **migration** and **compatibility**. The recommended interface is the **Five Pillars**:

- `explore` → find + read (preview/section/full)
- `understand` → synthesize structure/relationships
- `change` → plan/apply safe edits (dry-run first)
- `write` → create/scaffold files
- `manage` → status/undo/redo/reindex/history

Enable legacy tools only when you must:

- `SMART_CONTEXT_EXPOSE_LEGACY_TOOLS=true`
- `SMART_CONTEXT_LEGACY_AUTOMAP=true` (optional)

## Quick mapping

| Legacy tool | Prefer now | Notes |
|---|---|---|
| `search_project` | `explore` | Use `explore({ query })` for discovery. |
| `read_code` | `explore` | Use `explore({ paths, view })`. |
| `read_fragment` | `explore` | Use `explore({ paths, view: "section" })`. |
| `edit_code` | `change` | Use `change(options.dryRun=true)` then apply. |
| `analyze_relationship` | `understand` / `change` | Ask `understand` for deps/calls; `change` includes impact when enabled. |
| `get_batch_guidance` | `change` | Prefer `change` dry-run plan across files. |
| `manage_project` | `manage` | `rebuild` maps to `reindex` in current implementation. |
| `list_directory` | Bash `ls` / `find` | Not part of pillars; keep as legacy if exposed. |
| `read_file` / `write_file` / `analyze_file` | `explore` / `write` / `understand` | These are “compat tools” (separate flag). |

## Minimal per-tool notes

### `search_project`
- **Use for:** raw multi-modal searching (symbols/files/content)
- **Prefer now:** `explore({ query })`

### `read_code` / `read_fragment`
- **Use for:** raw file reads (skeleton/fragment/full)
- **Prefer now:** `explore({ paths: [file], view })`

### `edit_code`
- **Use for:** structured string/patch edits with transaction safety
- **Prefer now:** `change({ intent, targetFiles, options: { dryRun: true } })`

### `analyze_relationship`
- **Use for:** explicit impact/dependency/call graph requests
- **Prefer now:** `understand({ goal, include: { dependencies: true, callGraph: true } })`

### `manage_project`
- **Use for:** index/history utilities
- **Prefer now:** `manage({ command })`

