# Smart Context MCP Docs

Smart Context MCP exposes a small, intent-based tool surface (**Five Pillars**, ADR-040) and hides most implementation detail behind orchestration.

## Start here

### For agents / integrations
- `smart-context-mcp/docs/agent/TOOL_REFERENCE.md` — current tool schemas (what you can call)
- `smart-context-mcp/docs/agent/AGENT_PLAYBOOK.md` — recommended usage flows
- `smart-context-mcp/docs/compat/README.md` — legacy/compat tool names (opt-in)

### For running locally
- `smart-context-mcp/docs/guides/getting-started.md` — run the server + connect it to an MCP host
- `smart-context-mcp/docs/guides/configuration.md` — common env knobs (minimal + accurate)
- `smart-context-mcp/docs/guides/troubleshooting.md` — common “it doesn’t work” fixes

## Recent updates

- **ADR-042 Series Completion** (2026-01-03): `adr/ADR-042-COMPLETION-SUMMARY.md`
  - P0-P2 performance & scalability ✅
  - Layer 3 AI-enhanced features ✅
  - Production-ready (90%)

## Directory map

- `agent/` — agent-facing docs (pillars + patterns)
- `guides/` — setup/config/troubleshooting
- `ADR-INDEX.md` — curated ADR pointers (no duplication)
- `adr/` — decision records (source of truth for architecture evolution)
- `compat/` — opt-in legacy/compat interface docs
