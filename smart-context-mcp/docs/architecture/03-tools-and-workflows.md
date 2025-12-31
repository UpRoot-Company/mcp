# Six Pillars API & Workflows

This document describes the **agent-facing API** after ADR-033: the **Six Pillars**.

If you’re looking for parameter-level details, use:
- `smart-context-mcp/docs/agent/TOOL_REFERENCE.md`
- `smart-context-mcp/docs/adr/ADR-033-Six-Pillars-Architecture.md`

---

## The Six Pillars (What, not How)

| Pillar | Intent | Typical outputs |
|---|---|---|
| `navigate` | “Find it” | candidate files/symbols/locations |
| `read` | “Show it” | skeleton/fragment/full content (+ profile/hash) |
| `understand` | “Explain it” | synthesized summary + (optional) graphs/signals |
| `change` | “Modify it safely” | dry-run plan/diff → apply + impact report |
| `write` | “Create it” | created/scaffolded files + transaction metadata |
| `manage` | “Control state” | status/history/undo/redo/reindex |

---

## Recommended Workflows

### 1) Explore unfamiliar code
1. `navigate({ target: "AuthService", context: "definitions" })`
2. `read({ target: "src/auth/AuthService.ts", view: "skeleton" })`
3. `understand({ goal: "Explain the auth flow in AuthService" })`

### 2) Fix a bug (tight scope)
1. `navigate({ target: "Invalid token", context: "all" })`
2. `read({ target: "src/auth/validate.ts", view: "fragment", lineRange: "40-120" })`
3. `change({ intent: "Improve the Invalid token error message with actionable hints", options: { dryRun: true } })`
4. Review → `change({ intent: "...", options: { dryRun: false } })`

### 3) Refactor safely (multi-file)
1. `navigate({ target: "validateUser", context: "definitions" })`
2. `navigate({ target: "validateUser(", context: "usages" })`
3. `change({ intent: "Rename validateUser to authenticateUser and update all call sites", options: { dryRun: true } })`
4. Review impact/diff → apply with `dryRun: false`
5. If needed: `manage({ command: "undo" })`

---

## Practical Guidelines

- Prefer **constraints** over verbosity: use `targetFiles` in `change` when you already know the blast radius.
- Prefer **skeleton-first** reads: `read(view="skeleton")` then narrow with `fragment`.
- Treat `understand(include=...)` as an **opt-in cost**: enable graphs/signals only when you need them.
- Always plan before apply: default to `change(...dryRun=true)` and only apply after reviewing.

---

## Legacy Tools (Migration)

Legacy tools are hidden by default. If you maintain an integration that still calls tools like `search_project` / `read_code` / `edit_code`, see:
- `smart-context-mcp/docs/legacy/README.md`
- `smart-context-mcp/docs/legacy/LEGACY_TOOL_CATALOG.md`

