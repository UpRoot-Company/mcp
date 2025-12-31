# Smart Context MCP

Smart Context MCP is a Model Context Protocol (MCP) server for AI-assisted code understanding and safe code changes.

## Six Pillars (agent-facing API)

Per `smart-context-mcp/docs/adr/ADR-033-Six-Pillars-Architecture.md`, the primary interface is:

- `navigate` — locate symbols/files
- `read` — read content efficiently (skeleton/fragment/full)
- `understand` — synthesize structure/relationships
- `change` — plan/apply safe edits (dry-run first)
- `write` — create/scaffold files
- `manage` — status/undo/redo/reindex/history

Legacy tool names (e.g. `search_project`, `read_code`, `edit_code`) are opt-in; see `smart-context-mcp/docs/legacy/README.md`.

## Docs

- `smart-context-mcp/docs/README.md` — entry point
- `smart-context-mcp/docs/agent/AGENT_PLAYBOOK.md` — usage patterns
- `smart-context-mcp/docs/agent/TOOL_REFERENCE.md` — pillar reference
- `smart-context-mcp/docs/guides/getting-started.md` — setup + first flows

**Last Updated:** 2025-12-23

