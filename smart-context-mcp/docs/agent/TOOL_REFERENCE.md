# Tool Reference Guide (Five Pillars)

The agent-facing interface is the **Five Pillars** (ADR-040):

- `explore` — unified discovery (search + preview/section + optional full reads)
- `understand` — synthesize structure/relationships
- `change` — plan/apply safe edits (dry-run first)
- `write` — create/scaffold files
- `manage` — status/undo/redo/reindex/history

Legacy tools (e.g. `search_project`, `read_code`, `edit_code`) are **hidden by default**; see `smart-context-mcp/docs/compat/README.md`.

---

## Five Pillars (Recommended)

The following reflects the **current inputs** as exposed by `smart-context-mcp/src/index.ts`.

### `explore`

Unified search + read interface for docs and code.

**Parameters**

| Field | Type | Required | Notes |
|---|---|---:|---|
| `query` | `string` |  | Search query for docs/code. |
| `paths` | `string[]` |  | Explicit files/dirs to read. |
| `view` | `"auto" \| "preview" \| "section" \| "full"` |  | Defaults to token-safe previews. |
| `section.sectionId` | `string` |  | Use when targeting a specific doc section. |
| `section.headingPath` | `string[]` |  | Alternative to sectionId. |
| `include.docs` | `boolean` |  | Include document results. |
| `include.code` | `boolean` |  | Include code results. |
| `include.comments` | `boolean` |  | Include code-comment corpus (doc search). |
| `include.logs` | `boolean` |  | Include `.log` documents. |
| `packId` | `string` |  | Evidence pack reuse. |
| `cursor.items` | `string` |  | Page through results (items). |
| `cursor.content` | `string` |  | Expand content from a pack without re-search. |
| `limits.maxResults` | `number` |  | Per-group result cap. |
| `limits.maxChars` | `number` |  | Total content budget. |
| `limits.maxItemChars` | `number` |  | Per-item cap. |
| `limits.maxBytes` | `number` |  | Hard cap for full reads. |
| `fullPaths` | `string[]` |  | When view=full, only these get full content. |
| `allowSensitive` | `boolean` |  | Opt-in for sensitive files. |
| `allowBinary` | `boolean` |  | Opt-in for binary files. |
| `allowGlobs` | `boolean` |  | Opt-in for glob paths. |

**Usage**

- `explore({ query: "AuthService" })`
- `explore({ paths: ["src/auth/AuthService.ts"], view: "full" })`
- `explore({ query: "refund", packId, cursor: { items } })`

---

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
├─ Find or read content?   → explore
├─ Explain structure?      → understand
├─ Change code safely?     → change
├─ Create files?           → write
└─ Undo/redo/reindex?      → manage
```

---

## Composition Patterns

### Explore → Understand
- `explore({ query: "payments" })`
- `understand({ goal: "Explain the main payment flow" })`

### Plan → Apply (with constraints)
- `change(options.dryRun=true)` with a clear intent + `targetFiles`
- Review output
- `change(options.dryRun=false)` to apply

### Recover
- If edits go wrong: `manage({ command: "undo" })`
- If results look stale: `manage({ command: "reindex" })`

---

## Legacy / Compat Tools (Migration)

Legacy names are hidden by default. If enabled, use `explore` instead of `navigate/read`:

- `search_project` → `explore({ query })`
- `read_code` / `read_fragment` / `read_file` → `explore({ paths, view })`
