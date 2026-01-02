# Architecture Notes (for agent/integration authors)

This doc is intentionally short. Treat these as pointers for “how it works” when debugging an integration.

## Tool surface

- Tool schemas: `smart-context-mcp/docs/agent/TOOL_REFERENCE.md`
- Canonical surface spec: `smart-context-mcp/docs/adr/ADR-040-five-pillars-explore-consolidation.md`
- Integrity modes: `smart-context-mcp/docs/adr/ADR-041-integrity-audit-modes.md`

## Mental model (Five Pillars)

- `explore`: search + read with progressive disclosure (preview → section → full) and evidence-pack reuse
- `understand`: synthesis over code + docs (optionally runs integrity audit)
- `change`: dry-run plan → apply with transactional safety (optionally blocks apply on integrity conflicts)
- `write`: create/scaffold files (same safety rails as change)
- `manage`: status/history/undo/redo/reindex

Legacy tool names can be enabled, but should not be used by new integrations: `smart-context-mcp/docs/compat/README.md`.

## Key internal modules (where to look)

- Tool registration + schemas: `smart-context-mcp/src/index.ts`
- Orchestration engine (intent routing + pillar dispatch): `smart-context-mcp/src/orchestration/`
- Index + standalone storage: `smart-context-mcp/src/indexing/`
- Document ingestion/search: `smart-context-mcp/src/documents/`
- Evidence packs: `smart-context-mcp/src/evidence/`
- Integrity audit engine: `smart-context-mcp/src/integrity/`
