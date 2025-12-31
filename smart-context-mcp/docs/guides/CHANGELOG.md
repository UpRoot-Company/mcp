# Changelog

All notable changes to Smart Context MCP are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/), and this project adheres to [Semantic Versioning](https://semver.org/).

---

## [1.0.0] - 2025-12-15

### Overview

Smart Context MCP v1.0.0 is the first stable release of the Model Context Protocol (MCP) server for AI-assisted code analysis and intelligent file manipulation.

### Core Features

#### Symbol Resolution & Search
- **3-Tier Fallback Symbol Resolution** - Symbol Index, AST Direct Parsing, Regex Heuristic
- **BM25F Ranking Algorithm** - Field-weighted search with field-specific scoring
- **Trigram Indexing** - Fast fuzzy matching with ~97% performance improvement
- **Filename Search** - Direct file path matching with fuzzy support
- **Confidence Scoring** - Reliability indicators (0.0-1.0) for all matches

#### Code Analysis & Understanding
- **Skeleton Generation** - 95-98% token reduction via AST folding
- **Tree-sitter AST Parsing** - Robust parsing with error recovery for multiple languages
- **Call Graph Analysis** - Function invocation tracking and cross-file resolution
- **Dependency Graph** - Module relationships with circular dependency detection
- **Fragment Reading** - Extract specific code sections with 90% token savings

#### Editing & Safety
- **ACID Transactions** - All-or-nothing modifications with automatic rollback
- **6-Level Normalization** - Fuzzy matching despite whitespace/formatting differences
- **Crash Recovery** - Write-Ahead Logging (WAL) for automatic recovery on failure
- **Hash Verification** - TOCTOU prevention with xxHash64 validation
- **Error Enhancement** - Helpful suggestions for recovery and next steps

#### Indexing & Performance
- **On-Disk SQLite Indexing** - Persistent, memory-efficient storage
- **Lazy Loading Strategy** - Stream processing for large projects
- **Hot Symbol Cache** - LRU-based caching with automatic invalidation
- **Memory-Bounded Architecture** - Constant ~400MB regardless of project size
- **Incremental Updates** - Modified file detection with efficient re-indexing

#### Development Features
- **Batch Edit Guidance** - Analysis for multi-file refactoring patterns
- **Workflow Guidance** - Best practice suggestions for common tasks
- **Detailed Error Messages** - Tool suggestions and similar symbol recommendations
- **Multiple Read Modes** - full, skeleton, fragment views for token optimization

### Supported Features

| Feature | Details |
|---------|---------|
| **Languages** | TypeScript, JavaScript, Python, JSON |
| **Tools** | Six Pillars (6 tools) + opt-in legacy/compat tools |
| **Platforms** | Claude, Copilot, Cursor, and custom LLM integrations |
| **IDE Integration** | VSCode, JetBrains, Vim, Emacs via plugins |
| **CI/CD** | GitHub Actions, GitLab, pre-commit hooks |

### Performance Characteristics

| Metric | Value |
|--------|-------|
| **Cold Indexing** | 45-60 seconds for 10K files |
| **Search Latency (P50)** | 5-20ms for symbol lookups |
| **Search Latency (P95)** | 50-300ms depending on type |
| **Edit Operation** | 100-500ms for single/batch operations |
| **Memory Usage** | ~400MB constant for any project size |
| **Startup Time** | <500ms for 1000 file projects |

### Safety Guarantees

- ✅ **ACID Transactions** - Atomic, consistent, isolated, durable
- ✅ **Crash Recovery** - Automatic rollback on unexpected termination
- ✅ **Hash Verification** - Prevents silent data corruption
- ✅ **Path Sandboxing** - Directory traversal attack prevention
- ✅ **Error Resilience** - Graceful degradation with helpful recovery hints

### Architecture

Exposes the **Six Pillars** (ADR-033):
1. **navigate** - Find relevant symbols/files
2. **read** - Skeleton/fragment/full views (token-efficient by default)
3. **understand** - Synthesize structure/relationships (opt-in deeper graphs)
4. **change** - Plan (dry-run) → review → apply safely
5. **write** - Create/scaffold files
6. **manage** - status/undo/redo/reindex/history

### Documentation

Comprehensive documentation included:
- **AI Agent Documentation** - [agent/](../agent/) for programmatic integration
- **Architecture Guides** - [architecture/](../architecture/) for deep dives
- **Integration Guides** - [guides/](../) for setup and usage
- **FAQ** - Common questions and troubleshooting

### Known Limitations

| Issue | Severity | Status | Workaround |
|-------|----------|--------|-----------|
| Cluster pre-computation slow on first run | Medium | ⏳ Investigating | Disable via config |
| WASM parser crashes on heavily malformed code | Low | ⏳ Open | Use JS parser fallback |
| Database WAL file not cleaned on exit | Low | ⏳ Open | Manual: `rm .smart-context/index.db-wal` |

### Statistics

- **Source Lines of Code:** ~15,000
- **Test Coverage:** 87%
- **Architecture Decision Records (ADRs):** see `smart-context-mcp/docs/adr/`
- **Architectural Patterns:** 8+ design patterns documented
- **Code Examples:** 60+ from actual source

### Development Team

Built with ❤️ by the Smart Context MCP Team.

**Core maintainers:** @devkwan and team

**Special thanks:**
- Tree-sitter community for robust parsing
- Model Context Protocol specification authors
- Early adopters and contributors

### License

Smart Context MCP is licensed under the MIT License. See [LICENSE](../../LICENSE) for details.

---

## Getting Started

### Installation

```bash
npm install -g smart-context-mcp
```

### Quick Start

See [getting-started.md](./getting-started.md) for platform-specific setup (Claude, Copilot, Cursor, etc.)

### Documentation

- **New Users:** Start with [../README.md](../README.md)
- **Developers:** Read [../architecture/](../architecture/)
- **Integration:** See [integration.md](./integration.md)
- **FAQ:** Check [FAQ.md](./FAQ.md) for common questions

---

## Contributing

We welcome contributions! Please see [CONTRIBUTING.md](./CONTRIBUTING.md) for guidelines.

---

**Version:** 1.0.0  
**Release Date:** 2025-12-15  
**Status:** Stable & Production-Ready

For detailed technical information:
- [Architecture Documentation](../architecture/)
- [Tool Reference](../agent/TOOL_REFERENCE.md)
- [Agent Playbook](../agent/AGENT_PLAYBOOK.md)
- [ADR Index](../architecture/ADR-INDEX.md)
