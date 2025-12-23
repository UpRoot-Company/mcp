# Prompt Engineering Guide (Six Pillars)

This guide shows how to get high-quality results from Smart Context MCP using the **Six Pillars** (ADR-033). Focus on **“What”** you want; the system chooses **“How”**.

---

## 1) Three rules that cover most cases

### Rule 1: Navigate before you read
Instead of guessing file paths, ask the system to locate likely targets first.

- `navigate({ target: "AuthService", context: "definitions" })`
- then `read({ target: "...", view: "skeleton" })`

### Rule 2: Skeleton-first, then narrow
Start with `read(view="skeleton")`, then use `fragment` for the exact section you care about.

- `read({ target: "src/auth/AuthService.ts", view: "skeleton" })`
- `read({ target: "src/auth/AuthService.ts", view: "fragment", lineRange: "80-140" })`

### Rule 3: Make edits as intent + constraints
Prefer describing the change, plus constraints/acceptance criteria, over low-level string replacement.

Good `change` intent includes:
- What to change
- Where (optional): file hints or `targetFiles`
- Safety/behavior constraints: “don’t change public API”, “update tests”, “keep backward compatibility”

Always plan first:
- `change({ intent: "...", options: { dryRun: true } })`
- review
- `change({ intent: "...", options: { dryRun: false } })`

---

## 2) Prompt templates

### Template A: Understand a subsystem
Ask:
- “Find the entry points for `<subsystem>` and explain the flow end-to-end.”

Expected tool shape:
- `navigate` → `read(skeleton)` → `understand`

### Template B: Rename a symbol safely
Ask:
- “Rename `<old>` to `<new>` across the repo. Keep behavior identical. Update imports/exports and tests if needed. Show a dry-run diff first.”

Expected tool shape:
- `navigate` (optional) → `change(dryRun=true)` → apply

### Template C: Fix a bug with minimal blast radius
Ask:
- “Fix `<bug>` in `<file-or-area>`. Keep the change minimal. Show a dry-run plan/diff and list impacted files.”

Tips:
- If you already know likely files, include them as constraints (“Only touch files under `src/auth/`”).

---

## 3) When to use `understand` vs `read`

- Use `read` when you need **verbatim code** (or a skeleton/fragment).
- Use `understand` when you need **synthesis** (summary, relationships, impact).
- If `understand` feels too shallow, re-run with `include` flags enabled.

---

## 4) Legacy tool names

Some older docs/tools use names like `search_project`, `read_code`, `edit_code`. They are **legacy** and hidden by default.

See:
- `smart-context-mcp/docs/legacy/README.md`
- `smart-context-mcp/docs/legacy/LEGACY_TOOL_CATALOG.md`

