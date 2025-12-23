# Legacy Interface (Opt-in)

Smart Context MCP’s primary agent-facing interface is the **Six Pillars** (`understand`, `change`, `navigate`, `read`, `write`, `manage`) per ADR-033.

This folder documents **legacy/compat tools** that may still exist for backwards compatibility, debugging, or migration. New integrations should **not** depend on them.

## Enabling legacy/compat tools

By default, the MCP server exposes only the Six Pillars.

- Expose legacy tool names (e.g. `search_project`, `read_code`, `edit_code`):
  - `SMART_CONTEXT_EXPOSE_LEGACY_TOOLS=true`
- Auto-map unknown legacy calls into pillars (best-effort):
  - `SMART_CONTEXT_LEGACY_AUTOMAP=true`
- Expose small “compat” tools (file-level utilities):
  - `SMART_CONTEXT_EXPOSE_COMPAT_TOOLS=true`

## Contents

- `LEGACY_TOOL_CATALOG.md` — what the old tools did, and which pillar to use instead.

