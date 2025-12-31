# Tool Reference Guide (Six Pillars)

The agent-facing interface is the **Six Pillars** (ADR-033):

- `understand` — synthesize structure/relationships
- `change` — plan/apply safe edits (dry-run first)
- `navigate` — locate symbols/files
- `read` — read content efficiently (skeleton/fragment/full)
- `write` — create/scaffold files
- `manage` — status/undo/redo/reindex/history

Legacy tools (e.g. `search_project`, `read_code`, `edit_code`) are **hidden by default**; see `smart-context-mcp/docs/legacy/README.md`.

---

## Six Pillars (Recommended)

The following reflects the **current inputs** as exposed by `smart-context-mcp/src/index.ts`.

### `understand`

Deep analysis of structure and relationships (opt-in includes).

**Parameters**

| Field | Type | Required | Notes |
|---|---|---:|---|
| `goal` | `string` | ✓ | What you want to understand (symbol/file/free-text). |
| `scope` | `"symbol" \| "file" \| "module" \| "project"` |  | Narrow the search mode. |
| `depth` | `"shallow" \| "standard" \| "deep"` |  | Controls analysis depth. |
| `include.callGraph` | `boolean` |  | Include call graph (default is conservative; enable explicitly). |
| `include.dependencies` | `boolean` |  | Include dependency edges. |
| `include.hotSpots` | `boolean` |  | Include hotspot signals. |
| `include.pageRank` | `boolean` |  | Include architectural importance signals. |

**Usage**

- Start with `understand({ goal })`.
- If you need deeper graphs, re-run with `include: { callGraph: true, dependencies: true, hotSpots: true, pageRank: true }`.

---

### `navigate`

Locate symbols/files with lightweight context.

**Parameters**

| Field | Type | Required | Default |
|---|---|---:|---|
| `target` | `string` | ✓ | — |
| `context` | `"definitions" \| "usages" \| "tests" \| "docs" \| "all"` |  | `"all"` |
| `limit` | `number` |  | `10` |

---

### `read`

Read content with optional profiling/hash.

**Parameters**

| Field | Type | Required | Default |
|---|---|---:|---|
| `target` | `string` | ✓ | — |
| `view` | `"full" \| "skeleton" \| "fragment"` |  | `"skeleton"` |
| `lineRange` | `string \| [number, number]` |  | — |
| `includeProfile` | `boolean` |  | `false` |
| `includeHash` | `boolean` |  | `false` |

---

### `change`

Plan/apply safe edits with impact analysis.

**Parameters**

| Field | Type | Required | Notes |
|---|---|---:|---|
| `intent` | `string` | ✓ | Describe the change in natural language. |
| `target` | `string` |  | Optional hint (file/symbol). |
| `targetFiles` | `string[]` |  | Constrain the blast radius. |
| `edits` | `object[]` |  | Structured edits (advanced). |
| `options.dryRun` | `boolean` |  | Default behavior is dry-run planning. |
| `options.includeImpact` | `boolean` |  | Include impact report when enabled. |
| `options.autoRollback` | `boolean` |  | Reserved (implementation-dependent). |
| `options.batchMode` | `boolean` |  | Reserved (implementation-dependent). |

**Recommended flow**

1) `change({ intent, options: { dryRun: true } })`  
2) Review plan/diff/impact  
3) `change({ intent, options: { dryRun: false } })`

---

### `write`

Create or scaffold files.

**Parameters**

| Field | Type | Required | Notes |
|---|---|---:|---|
| `intent` | `string` | ✓ | What to create. |
| `targetPath` | `string` |  | Where to create it. |
| `template` | `string` |  | Template name/path (if supported). |
| `content` | `string` |  | Explicit content overrides generation. |

---

### `manage`

Project/session state utilities.

**Parameters**

| Field | Type | Required | Notes |
|---|---|---:|---|
| `command` | `"status" \| "undo" \| "redo" \| "reindex" \| "rebuild" \| "history" \| "test"` | ✓ | `rebuild` maps to `reindex`. |
| `scope` | `"file" \| "transaction" \| "project"` |  | Mainly used by `test`. |
| `target` | `string` |  | Mainly used by `test`. |

---

## Quick Tool Selector

```
What do you need?
├─ Find files/symbols?         → navigate
├─ Read content efficiently?    → read
├─ Explain structure/impact?    → understand
├─ Change code safely?          → change
├─ Create/scaffold files?       → write
└─ Undo/redo/reindex/status?    → manage
```

---

## Composition Patterns

### Locate → Read → Understand
- `navigate` to get candidate files/symbols
- `read(view="skeleton")` to confirm structure quickly
- `understand(include=...)` only when you need deeper graphs/synthesis

### Plan → Apply (with constraints)
- `change(options.dryRun=true)` with a clear intent + `targetFiles`
- Review output
- `change(options.dryRun=false)` to apply

### Recover
- If edits go wrong: `manage({ command: "undo" })`
- If results look stale: `manage({ command: "reindex" })`

---

## Legacy / Compat Tools (Migration)

See:
- `smart-context-mcp/docs/legacy/README.md`
- `smart-context-mcp/docs/legacy/LEGACY_TOOL_CATALOG.md`

