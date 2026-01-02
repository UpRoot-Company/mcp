# Prompt Engineering Guide (Five Pillars)

This guide shows how to get high-quality results from Smart Context MCP using the **Five Pillars** (ADR-040). Focus on **“What”** you want; the system chooses **“How”**.

---

## 1) Three rules that cover most cases

### Rule 1: Explore before you go deep
Instead of guessing file paths, ask the system to locate likely targets first.

- `explore({ query: "AuthService" })`
- then `explore({ paths: ["..."], view: "full" })` if needed

### Rule 2: Preview-first, then expand
Start with `explore(view="preview")` or `explore(view="section")`, then expand to full only when needed.

- `explore({ paths: ["src/auth/AuthService.ts"], view: "preview" })`
- `explore({ paths: ["src/auth/AuthService.ts"], view: "full" })`

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
- `explore` → `understand`

### Template B: Rename a symbol safely
Ask:
- “Rename `<old>` to `<new>` across the repo. Keep behavior identical. Update imports/exports and tests if needed. Show a dry-run diff first.”

Expected tool shape:
- `explore` (optional) → `change(dryRun=true)` → apply

### Template C: Fix a bug with minimal blast radius
Ask:
- “Fix `<bug>` in `<file-or-area>`. Keep the change minimal. Show a dry-run plan/diff and list impacted files.”

Tips:
- If you already know likely files, include them as constraints (“Only touch files under `src/auth/`”).

---

## 3) When to use `understand` vs `explore`

- Use `explore` when you need **verbatim code or documents** (preview/section/full).
- Use `understand` when you need **synthesis** (summary, relationships, impact).
- If `understand` feels too shallow, re-run with `include` flags enabled.

---

## 4) Legacy tool names

Some older docs/tools use names like `search_project`, `read_code`, `edit_code`. They are **legacy** and hidden by default.

See:
- `smart-context-mcp/docs/legacy/README.md`
- `smart-context-mcp/docs/legacy/LEGACY_TOOL_CATALOG.md`

