# ADR Index (Curated)

All ADRs live in `smart-context-mcp/docs/adr/`. This index is intentionally **curated** to reduce duplication and doc drift.

## Most important (read these first)

- **ADR-033 — Six Pillars Architecture**: `../adr/ADR-033-Six-Pillars-Architecture.md`  
  Maps to: `01-system-overview.md`, `03-tools-and-workflows.md`, `../agent/TOOL_REFERENCE.md`
- **ADR-022 — Scalable Architecture (SQLite / WAL)**: `../adr/ADR-022-scalable-architecture.md`  
  Maps to: `02-core-engine.md`, `06-reliability-engineering.md`
- **ADR-014 — Smart File Profile (Skeleton-first)**: `../adr/ADR-014-smart-file-profile.md`  
  Maps to: `05-semantic-analysis.md`
- **ADR-005 — Reliability & Transactions**: `../adr/ADR-005-Reliability-and-Transactions.md`  
  Maps to: `06-reliability-engineering.md`

## Search / indexing / ranking

- ADR-017 / ADR-018 — clustered search: `../adr/ADR-017-context-aware-clustered-search.md`, `../adr/ADR-018-consolidated-cluster-search.md`
- ADR-023 — gap remediation (trigram/hash): `../adr/ADR-023-Enhanced-Architectural-Gap-Remediation.md`
- ADR-036 — universal document support (markdown/mdx-first): `../adr/ADR-036-universal-document-support.md`
- ADR-037 — docs v2 (plain text + code comments + retrieval quality + embedding ops + scalable storage): `../adr/ADR-037-universal-text-retrieval-ops.md`
- ADR-038 — token-efficient evidence packs & progressive disclosure: `../adr/ADR-038-token-efficient-evidence-packs.md`

## Editing safety

- ADR-024 — edit flexibility & safety: `../adr/ADR-024-enhanced-edit-flexibility-and-safety.md`
- ADR-032 — edit reliability & state sync: `../adr/ADR-032-edit-code-reliability-and-state-synchronization.md`

## Agent experience

- ADR-026 — symbol resolution & workflow guidance: `../adr/ADR-026-Symbol-Resolution-And-Workflow-Guidance.md`
- ADR-030 — agent-centric intelligence & resilience: `../adr/ADR-030-Agent-Centric-Intelligence-And-Resilience.md`

## Notes

- Some older ADRs reference legacy tool names (`search_project`, `read_code`, `edit_code`). The recommended interface is the Six Pillars (ADR-033).
