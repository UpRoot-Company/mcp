# ADR Index: Architecture Decision Records

This document maps all 26 Architecture Decision Records (ADRs) to relevant sections in the documentation.

**Use this index to:**
- Find the ADR that documents a specific feature or decision
- Understand the reasoning behind design choices
- Track design evolution over time

---

## Quick Navigation

### By Topic

- [System Architecture](#system-architecture-foundation)
- [Search & Indexing](#search--indexing)
- [Code Editing & Transactions](#code-editing--transactions)
- [Analysis & Graph Algorithms](#analysis--graph-algorithms)
- [Parsing & Semantic Analysis](#parsing--semantic-analysis)
- [Performance & Reliability](#performance--reliability)
- [Agent Experience & Safety](#agent-experience--safety)

---

## System Architecture Foundation

### Core Architecture (ADR-001)

**Document:** [ADR-001: Smart Context Architecture](../../docs/adr/ADR-001-smart-context-architecture.md)

**Maps to:**
- [01-system-overview.md](./01-system-overview.md#system-philosophy-precision-over-volume)
- [ARCHITECTURE.md (agent)](../agent/ARCHITECTURE.md#core-principles)

**Key Concepts:**
- Scout → Read → Edit pipeline
- Token efficiency strategy
- Layered architecture pattern

**Decisions:**
- Use intent-based tool handlers instead of low-level operations
- Implement on-disk indexing to solve OOM issues
- Enforce high-efficiency pipeline over chatty interactions

---

### Enterprise-Grade Core Enhancements (ADR-021)

**Document:** [ADR-021: Enterprise-Grade Core Enhancements](../../docs/adr/ADR-021-Enterprise-Grade-Core-Enhancements.md)

**Maps to:**
- [01-system-overview.md](./01-system-overview.md#high-level-architecture-layered-pattern)
- [Architecture Deep Dive](../agent/ARCHITECTURE.md#layer-2-engine-modules-srceingine)

**Key Concepts:**
- IFileSystem interface abstraction
- Incremental file tracking
- Memory-bounded AST manager
- Batch edit guidance

**Decisions:**
- Swap file system implementations (production, test, CI)
- Track modified files without full rebuilds
- Generate batch edit opportunities across files

---

### Scalable Architecture (ADR-022)

**Document:** [ADR-022: Scalable Architecture](../../docs/adr/ADR-022-scalable-architecture.md)

**Maps to:**
- [02-core-engine.md](./02-core-engine.md#on-disk-indexing-with-sqlite)
- [ARCHITECTURE.md (agent)](../agent/ARCHITECTURE.md#core-principles-on-disk-indexing)

**Key Concepts:**
- SQLite Write-Ahead Logging (WAL) mode
- Constant memory usage regardless of project size
- Lazy index loading

**Decisions:**
- Replace in-memory graph with SQLite persistence
- Enable WAL mode for concurrent access
- Stream indexing instead of blocking startup

---

### Pragmatic Reliability Enhancements (ADR-008)

**Document:** [ADR-008: Pragmatic Reliability Enhancements](../../docs/adr/ADR-008-Pragmatic-Reliability-Enhancements.md)

**Maps to:**
- [06-reliability-engineering.md](./06-reliability-engineering.md#crash-recovery-mechanism)

**Key Concepts:**
- Transactional consistency
- Graceful degradation
- Recovery procedures

**Decisions:**
- Focus on recovery over prevention
- Implement WAL-based crash recovery
- Provide manual recovery procedures

---

## Search & Indexing

### Context-Aware Clustered Search (ADR-017)

**Document:** [ADR-017: Context-Aware Clustered Search](../../docs/adr/ADR-017-context-aware-clustered-search.md)

**Maps to:**
- [04-advanced-algorithms.md](./04-advanced-algorithms.md#cluster-based-search-ranking)

**Key Concepts:**
- Semantic grouping of symbols
- Seed finding and cluster expansion
- Relevance ranking

**Decisions:**
- Return clusters instead of flat result lists
- Include callers/callees in cluster context
- Pre-compute hot spots for faster results

---

### Consolidated Cluster Search (ADR-018)

**Document:** [ADR-018: Consolidated Cluster Search](../../docs/adr/ADR-018-consolidated-cluster-search.md)

**Maps to:**
- [04-advanced-algorithms.md](./04-advanced-algorithms.md#cluster-based-search)
- [ARCHITECTURE.md (agent)](../agent/ARCHITECTURE.md#clustersearchengine-srcentgineclustersearcindex)

**Key Concepts:**
- 9-component ClusterSearch subsystem
- Query parsing and intent extraction
- Preview generation for context

**Decisions:**
- Decompose cluster search into specialized components
- Pre-compute clusters for common queries
- Generate code previews for each cluster result

---

### Enhanced Architectural Gap Remediation (ADR-023)

**Document:** [ADR-023: Enhanced Architectural Gap Remediation](../../docs/adr/ADR-023-Enhanced-Architectural-Gap-Remediation.md)

**Maps to:**
- [04-advanced-algorithms.md](./04-advanced-algorithms.md#trigram-indexing-for-fast-search)
- [06-reliability-engineering.md](./06-reliability-engineering.md#safety-mechanisms)

**Key Concepts:**
- Trigram indexing for fast file filtering
- Hash verification (xxHash64) for edit safety
- Symbol cache invalidation tracking

**Decisions:**
- Pre-filter candidates with trigrams before full search
- Use xxHash64 for fast content verification
- Track file modifications for cache invalidation

---

### Toolset Consolidation Strategy (ADR-019)

**Document:** [ADR-019: Toolset Consolidation Strategy](../../docs/adr/ADR-019-toolset-consolidation-strategy.md)

**Maps to:**
- [03-tools-and-workflows.md](./03-tools-and-workflows.md)

**Key Concepts:**
- Intent-based tool abstraction
- Scout, Read, Edit as primary intents
- Tool surface consolidation

**Decisions:**
- Expose 5 high-level intent tools instead of 20+ low-level operations
- Design tools for common agent workflows
- Reduce tool parameter explosion

---

### Final Toolset Consolidation (ADR-020)

**Document:** [ADR-020: Final Toolset Consolidation](../../docs/adr/ADR-020-final-toolset-consolidation.md)

**Maps to:**
- [03-tools-and-workflows.md](./03-tools-and-workflows.md#tool-catalog)

**Key Concepts:**
- Stabilized 5-tool interface
- Tool parameter finalization
- Error message standardization

**Decisions:**
- Finalize `read_code`, `search_project`, `edit_code`, `analyze_relationship`, `manage_project`
- Standardize parameter names and types
- Define error codes and recovery paths

---

## Code Editing & Transactions

### Reliability and Transactions (ADR-005)

**Document:** [ADR-005: Reliability and Transactions](../../docs/adr/ADR-005-Reliability-and-Transactions.md)

**Maps to:**
- [06-reliability-engineering.md](./06-reliability-engineering.md#acid-transactions-explained)
- [AGENT_PLAYBOOK.md](../agent/AGENT_PLAYBOOK.md#batch-editing)

**Key Concepts:**
- ACID transaction model
- Batch edit atomicity
- Automatic rollback

**Decisions:**
- All edits in one call must succeed or fail together
- Implement snapshot-based rollback
- Provide transaction log for crash recovery

---

### Editor Engine Improvements (ADR-009)

**Document:** [ADR-009: Editor Engine Improvements](../../docs/adr/ADR-009-editor-engine-improvements.md)

**Maps to:**
- [04-advanced-algorithms.md](./04-advanced-algorithms.md#6-level-normalization-hierarchy)
- [06-reliability-engineering.md](./06-reliability-engineering.md)

**Key Concepts:**
- Levenshtein distance for fuzzy matching
- Confidence-based matching levels
- Memory-bounded AST caching

**Decisions:**
- Use Levenshtein distance instead of regex matching
- Implement 6-level normalization hierarchy
- Add confidence scoring for match quality

---

### Enhanced Edit Flexibility and Safety (ADR-024)

**Document:** [ADR-024: Enhanced Edit Flexibility and Safety](../../docs/adr/ADR-024-enhanced-edit-flexibility-and-safety.md)

**Maps to:**
- [04-advanced-algorithms.md](./04-advanced-algorithms.md#6-level-normalization-hierarchy)
- [AGENT_PLAYBOOK.md](../agent/AGENT_PLAYBOOK.md#situation-71-no_match-error)

**Key Concepts:**
- Progressive normalization strategy
- Context-based disambiguation
- Confidence scoring

**Decisions:**
- Allow agents to control normalization level
- Add `beforeContext` and `afterContext` parameters
- Auto-select best match when confidence sufficient

---

### User Experience Enhancements (ADR-025)

**Document:** [ADR-025: User Experience Enhancements](../../docs/adr/ADR-025-User-Experience-Enhancements.md)

**Maps to:**
- [06-reliability-engineering.md](./06-reliability-engineering.md#error-enhancement-system)
- [AGENT_PLAYBOOK.md](../agent/AGENT_PLAYBOOK.md#error-recovery)

**Key Concepts:**
- Enhanced error messages with hints
- Tool suggestions in error context
- Similar symbol discovery

**Decisions:**
- Include `nextActionHint` in error responses
- Suggest next tools to try
- Find similar symbols when exact match fails

---

## Analysis & Graph Algorithms

### Project Intelligence (ADR-012)

**Document:** [ADR-012: Project Intelligence](../../docs/adr/ADR-012-project-intelligence.md)

**Maps to:**
- [05-semantic-analysis.md](./05-semantic-analysis.md#dependency-graph)
- [ARCHITECTURE.md (agent)](../agent/ARCHITECTURE.md#dependencygraph-srcasidependencygraphts)

**Key Concepts:**
- File-level dependency tracking
- Circular dependency detection
- Import resolution

**Decisions:**
- Build dependency graph for entire project
- Detect circular dependencies
- Track both internal and external imports

---

### Impact/Flow Analysis (ADR-016)

**Document:** [ADR-016: Impact/Flow Analysis](../../docs/adr/ADR-016-impact-flow-analysis.md)

**Maps to:**
- [05-semantic-analysis.md](./05-semantic-analysis.md#call-graph-construction)

**Key Concepts:**
- Call graph construction
- Data flow tracing
- Impact analysis for changes

**Decisions:**
- Build call graphs with configurable depth
- Trace variable data flow
- Compute impact radius for code changes

---

## Parsing & Semantic Analysis

### Smart Semantic Analysis (ADR-010)

**Document:** [ADR-010: Smart Semantic Analysis](../../docs/adr/ADR-010-smart-semantic-analysis.md)

**Maps to:**
- [05-semantic-analysis.md](./05-semantic-analysis.md#why-tree-sitter)

**Key Concepts:**
- Tree-sitter for robust AST parsing
- Language-specific query languages
- Error recovery during parsing

**Decisions:**
- Adopt Tree-sitter for AST analysis
- Use S-expression queries for symbol extraction
- Support error recovery on broken code

---

### Robustness and Advanced Analysis (ADR-011)

**Document:** [ADR-011: Robustness and Advanced Analysis](../../docs/adr/ADR-011-robustness-and-advanced-analysis.md)

**Maps to:**
- [05-semantic-analysis.md](./05-semantic-analysis.md#symbol-extraction-deep-dive)

**Key Concepts:**
- Universal parser for TypeScript/JavaScript
- Hybrid language support
- Graceful fallback strategies

**Decisions:**
- Use tree-sitter-typescript as universal parser for JS/TS/TSX
- Support Python and JSON via dedicated grammars
- Fall back to JavaScript parser if WASM unavailable

---

### Smart File Profile (ADR-014)

**Document:** [ADR-014: Smart File Profile](../../docs/adr/ADR-014-smart-file-profile.md)

**Maps to:**
- [04-advanced-algorithms.md](./04-advanced-algorithms.md#skeleton-generation-algorithm)
- [ARCHITECTURE.md (agent)](../agent/ARCHITECTURE.md#skeleton-generation-deep-dive)

**Key Concepts:**
- Skeleton view generation
- File metadata profiling
- Token usage optimization

**Decisions:**
- Return structured file profile instead of raw content
- Include skeleton for structure-only reads
- Provide metadata (imports, exports, complexity)

---

## Performance & Reliability

### Agent Experience and Resilience (ADR-015)

**Document:** [ADR-015: Agent Experience and Resilience](../../docs/adr/ADR-015-agent-experience-and-resilience.md)

**Maps to:**
- [06-reliability-engineering.md](./06-reliability-engineering.md#testing-strategy)
- [Configuration Guide](../guides/configuration.md#environment-variables)

**Key Concepts:**
- Engine profiles for different environments
- Resilience through fallbacks
- Test determinism

**Decisions:**
- Provide `production`, `ci`, `test` engine profiles
- Implement 3-tier fallback chain for symbol resolution
- Use snapshot backend for deterministic testing

---

## Agent Guidance & Assistance

### Symbol Resolution and Workflow Guidance (ADR-026)

**Document:** [ADR-026: Symbol Resolution and Workflow Guidance](../../docs/adr/ADR-026-Symbol-Resolution-And-Workflow-Guidance.md)

**Maps to:**
- [AGENT_PLAYBOOK.md](../agent/AGENT_PLAYBOOK.md)
- [06-reliability-engineering.md](./06-reliability-engineering.md#error-enhancement-system)

**Key Concepts:**
- 3-tier symbol resolution fallback
- Workflow guidance for agents
- Error recovery suggestions

**Decisions:**
- Implement Symbol Index → AST Parsing → Regex fallback
- Provide best-practice workflows in guided mode
- Embed recovery suggestions in error messages

---

---

## Reference by Release

### Version 1.0.0 Features

ADRs implemented in the current release:

- ✅ [ADR-001](#core-architecture-adr-001) - Smart Context Architecture
- ✅ [ADR-005](#reliability-and-transactions-adr-005) - Reliability and Transactions
- ✅ [ADR-008](#pragmatic-reliability-enhancements-adr-008) - Pragmatic Reliability
- ✅ [ADR-009](#editor-engine-improvements-adr-009) - Editor Engine Improvements
- ✅ [ADR-010](#smart-semantic-analysis-adr-010) - Smart Semantic Analysis
- ✅ [ADR-011](#robustness-and-advanced-analysis-adr-011) - Robustness & Analysis
- ✅ [ADR-012](#project-intelligence-adr-012) - Project Intelligence
- ✅ [ADR-014](#smart-file-profile-adr-014) - Smart File Profile
- ✅ [ADR-015](#agent-experience-and-resilience-adr-015) - Agent Experience & Resilience
- ✅ [ADR-016](#impactflow-analysis-adr-016) - Impact/Flow Analysis
- ✅ [ADR-017](#context-aware-clustered-search-adr-017) - Clustered Search
- ✅ [ADR-018](#consolidated-cluster-search-adr-018) - Consolidated Cluster Search
- ✅ [ADR-019](#toolset-consolidation-strategy-adr-019) - Toolset Consolidation
- ✅ [ADR-020](#final-toolset-consolidation-adr-020) - Final Toolset
- ✅ [ADR-021](#enterprise-grade-core-enhancements-adr-021) - Enterprise Enhancements
- ✅ [ADR-022](#scalable-architecture-adr-022) - Scalable Architecture
- ✅ [ADR-023](#enhanced-architectural-gap-remediation-adr-023) - Gap Remediation
- ✅ [ADR-024](#enhanced-edit-flexibility-and-safety-adr-024) - Edit Flexibility & Safety
- ✅ [ADR-025](#user-experience-enhancements-adr-025) - User Experience
- ✅ [ADR-026](#symbol-resolution-and-workflow-guidance-adr-026) - Symbol Resolution & Guidance

**Additional ADRs (from earlier versions, still referenced):**
- [ADR-002](../../docs/adr/ADR-002-smart-engine-refactoring.md) - Smart Engine Refactoring
- [ADR-003](../../docs/adr/ADR-003-advanced-algorithms.md) - Advanced Algorithms
- [ADR-004](../../docs/adr/ADR-004-agent-driven-refactoring.md) - Agent-Driven Refactoring
- [ADR-013](../../docs/adr/ADR-013-serena-feature-analysis.md) - Serena Feature Analysis

---

## How to Use This Index

### I want to understand...

**...why we use SQLite instead of in-memory storage**
→ See [ADR-022](#scalable-architecture-adr-022)

**...how symbol search works**
→ See [ADR-017](#context-aware-clustered-search-adr-017) and [ADR-026](#symbol-resolution-and-workflow-guidance-adr-026)

**...how edits are safe from failures**
→ See [ADR-005](#reliability-and-transactions-adr-005) and [ADR-023](#enhanced-architectural-gap-remediation-adr-023)

**...how skeleton view saves tokens**
→ See [ADR-014](#smart-file-profile-adr-014)

**...why normalization is important**
→ See [ADR-024](#enhanced-edit-flexibility-and-safety-adr-024)

**...how to troubleshoot errors**
→ See [ADR-025](#user-experience-enhancements-adr-025) and [ADR-026](#symbol-resolution-and-workflow-guidance-adr-026)

---

## Complete ADR List

All 26 ADRs are located in `docs/adr/`:

1. ADR-001 - Smart Context Architecture
2. ADR-002 - Smart Engine Refactoring
3. ADR-003 - Advanced Algorithms
4. ADR-004 - Agent-Driven Refactoring
5. ADR-005 - Reliability and Transactions
6. ADR-008 - Pragmatic Reliability Enhancements
7. ADR-009 - Editor Engine Improvements
8. ADR-009 - Editor Engine Matching Improvements
9. ADR-009 - Memory-Bounded Architecture
10. ADR-009 - Persistent Index Layer
11. ADR-010 - Smart Semantic Analysis
12. ADR-011 - Robustness and Advanced Analysis
13. ADR-012 - Project Intelligence
14. ADR-013 - Serena Feature Analysis
15. ADR-014 - Smart File Profile
16. ADR-015 - Agent Experience and Resilience
17. ADR-016 - Impact/Flow Analysis
18. ADR-017 - Context-Aware Clustered Search (+ Addendum)
19. ADR-018 - Consolidated Cluster Search
20. ADR-019 - Toolset Consolidation (Strategy & Final)
21. ADR-020 - Final Toolset Consolidation
22. ADR-021 - Enterprise-Grade Core Enhancements (+ Variant)
23. ADR-022 - Scalable Architecture
24. ADR-023 - Enhanced Architectural Gap Remediation
25. ADR-024 - Enhanced Edit Flexibility and Safety
26. ADR-025 - User Experience Enhancements
27. ADR-026 - Symbol Resolution and Workflow Guidance

---

## Version History

| Version | ADRs Added | Key Focus |
|---------|-----------|-----------|
| 1.0.0 | All 26 | Symbol resolution, workflow guidance, enhanced errors |
| 1.0.0 | ADR-001 to ADR-025 | Core architecture, atoms, clustering |
| 1.0.0 | Initial | Basic MCP server |

---

## Contributing

When making significant architectural changes:

1. Create or update relevant ADR
2. Update this index to reflect the change
3. Link ADR from affected documentation files
4. Reference ADR in commit messages

---

**Version:** 1.0.0  
**Last Updated:** 2025-12-14  
**Maintained by:** Smart Context MCP Team
