# Tool Conflict Resolution (Bash vs Six Pillars)

Use Smart Context MCP when it provides **indexing**, **token efficiency**, or **transaction safety**. Use Bash when you need **shell/Git/build** capabilities.

---

## Quick matrix

| Task | Prefer | Why |
|---|---|---|
| Find symbols/files | `navigate` | ranked results + symbol awareness |
| Read code | `read` | skeleton/fragment views reduce tokens |
| Explain architecture/impact | `understand` | synthesized view + optional graphs |
| Modify code | `change` | dry-run plans + transactional safety |
| Create scaffolding/files | `write` | intent-based creation |
| Undo/redo/reindex | `manage` | stateful operations |
| Git operations | Bash (`git …`) | not an MCP responsibility |
| Build/test | Bash (`npm test`, `pytest`, …) | runs external tooling |
| Directory listing | Bash (`ls`, `find`) | not part of pillars by default |

---

## Practical rules

- If you’re about to `grep -R` for code understanding, prefer `navigate` + `read(skeleton)`.
- If you’re about to `sed -i` code, prefer `change` (plan → review → apply).
- Keep Bash for Git and builds; keep Smart Context for codebase *understanding* and *safe edits*.

---

## Legacy tools

Older integrations may expose tools like `search_project` / `read_code` / `edit_code` / `list_directory`. They are opt-in.

See:
- `smart-context-mcp/docs/legacy/README.md`
- `smart-context-mcp/docs/legacy/LEGACY_TOOL_CATALOG.md`

