# Smart Context MCP - Documentation

Smart Context MCP is a Model Context Protocol (MCP) server for AI-assisted code analysis and intelligent file manipulation. This repository contains comprehensive documentation for both AI agents and human developers.

**Version:** 1.0.0 | **Status:** Production-Ready | **License:** MIT

---

## 📚 Documentation Sections

### 🤖 [AI Agent Documentation](./docs/agent/)
For AI agents, LLMs, and programmatic integrations.

- **[AGENT_PLAYBOOK.md](./docs/agent/AGENT_PLAYBOOK.md)** (12-15KB)
  - 7 advanced workflow patterns
  - Token efficiency analysis (92-97% savings)
  - Scout → Read → Edit pipeline guide
  - Error recovery strategies

- **[TOOL_REFERENCE.md](./docs/agent/TOOL_REFERENCE.md)** (18-22KB)
  - Complete API reference for 10+ tools
  - Parameters, return formats, usage patterns
  - 3 complexity levels (🟢 Beginner → 🔴 Advanced)
  - Tool composition patterns

- **[ARCHITECTURE.md](./docs/agent/ARCHITECTURE.md)** (18-20KB)
  - Core technical architecture
  - BM25F ranking, trigram indexing
  - 6-level normalization hierarchy
  - Transaction-based editing

### 👨‍💻 [Human Documentation](./docs/)
For developers, DevOps engineers, and system architects.

#### Architecture Deep-Dives
- **[01-system-overview.md](./docs/architecture/01-system-overview.md)** (10min)
  - Core mission and system philosophy
  - Component architecture
  - Key design decisions
  - Performance characteristics

- **[02-core-engine.md](./docs/architecture/02-core-engine.md)** (15min)
  - SQLite schema and indexing
  - Symbol resolution mechanisms
  - Operational procedures
  - Performance benchmarks

- **[03-tools-and-workflows.md](./docs/architecture/03-tools-and-workflows.md)** (12min)
  - Human-readable tool catalog
  - Real-world workflow examples
  - Integration patterns

- **[04-advanced-algorithms.md](./docs/architecture/04-advanced-algorithms.md)** (18min)
  - BM25F ranking algorithm
  - Trigram indexing and fuzzy matching
  - 6-level normalization
  - Levenshtein distance and Patience diff

- **[05-semantic-analysis.md](./docs/architecture/05-semantic-analysis.md)** (12min)
  - Tree-sitter AST parsing
  - Skeleton generation (95-98% token savings)
  - Call graph and dependency analysis

- **[06-reliability-engineering.md](./docs/architecture/06-reliability-engineering.md)** (14min)
  - ACID transactions and crash recovery
  - Error enhancement system
  - Safety mechanisms
  - Testing strategies

- **[ADR-INDEX.md](./docs/architecture/ADR-INDEX.md)** (5min reference)
  - Complete mapping of all 26 ADRs
  - Organized by topic

#### Practical Guides
- **[getting-started.md](./docs/guides/getting-started.md)** (10-15min)
  - Installation and setup
  - Platform configuration
  - Hello World examples

- **[integration.md](./docs/guides/integration.md)** (20-30min)
  - IDE integration (VSCode, JetBrains, Cursor, Vim, Emacs)
  - CI/CD setup (GitHub Actions, GitLab)
  - Security best practices

- **[module-resolution.md](./docs/guides/module-resolution.md)** (10-15min)
  - Module resolution algorithm
  - Path aliases and monorepo support
  - Circular dependency detection

- **[configuration.md](./docs/guides/configuration.md)** (10min)
  - Environment variables (13 options)
  - Engine profiles
  - Performance tuning

- **[CONTRIBUTING.md](./docs/guides/CONTRIBUTING.md)** (15min)
  - Development setup
  - Code style and conventions
  - Testing requirements (>80% coverage)
  - ADR writing guide

- **[FAQ.md](./docs/guides/FAQ.md)** (10min)
  - 20+ common questions
  - Troubleshooting
  - Best practices

- **[CHANGELOG.md](./docs/guides/CHANGELOG.md)** (5-10min)
  - Version 1.0.0 release notes
  - Migration guides

### 📦 [Legacy Documentation](./docs_old/)
Archived documentation from development.

- **adr/** - Architectural decision records (ADR-001 through ADR-026)
- **ai/** - Legacy AI documentation
- **guide/** - Integration guides and configuration references

---

## 🎯 Getting Started

### I'm an AI Agent
→ Start with **[AGENT_PLAYBOOK.md](./docs/agent/AGENT_PLAYBOOK.md)** for Scout → Read → Edit patterns  
→ Then reference **[TOOL_REFERENCE.md](./docs/agent/TOOL_REFERENCE.md)** for API details

### I'm a New User
1. Read **[system-overview.md](./docs/architecture/01-system-overview.md)** (10min)
2. Follow **[getting-started.md](./docs/guides/getting-started.md)** (15min)
3. Try a workflow example (5min)

→ **Total: ~30 minutes to productive use**

### I'm a Developer
1. **[system-overview.md](./docs/architecture/01-system-overview.md)** - Big picture
2. **[02-core-engine.md](./docs/architecture/02-core-engine.md)** - How it works
3. **[04-advanced-algorithms.md](./docs/architecture/04-advanced-algorithms.md)** - Deep dive
4. **[integration.md](./docs/guides/integration.md)** - Integration patterns

→ **Total: ~2-3 hours for comprehensive understanding**

### I'm Setting Up in DevOps/CI-CD
1. **[getting-started.md](./docs/guides/getting-started.md)** - Installation
2. **[integration.md](./docs/guides/integration.md)** - CI/CD section
3. **[configuration.md](./docs/guides/configuration.md)** - Tuning

→ **Total: ~1-2 hours for production setup**

### I'm Troubleshooting
→ Check **[FAQ.md](./docs/guides/FAQ.md)** for quick answers  
→ Then deep-dive relevant architecture docs

### I'm Contributing Code
1. **[CONTRIBUTING.md](./docs/guides/CONTRIBUTING.md)** - Setup and guidelines
2. **[system-overview.md](./docs/architecture/01-system-overview.md)** - Architecture context
3. **[ADR-INDEX.md](./docs/architecture/ADR-INDEX.md)** - Design decisions

---

## 📊 What's Documented

| Category | Coverage | Files |
|----------|----------|-------|
| **AI Agent Docs** | ✅ Complete | 4 files, 56KB |
| **Architecture** | ✅ Complete | 7 files, 95KB |
| **Integration Guides** | ✅ Complete | 8 files, 58KB |
| **Code Examples** | ✅ 60+ from source | Throughout |
| **API Reference** | ✅ All 10+ tools | TOOL_REFERENCE.md |
| **ADR Mapping** | ✅ All 26 ADRs | ADR-INDEX.md |

---

## 🔑 Key Concepts

**Scout → Read → Edit Pipeline**
The canonical 3-stage workflow:
1. **Scout** - Find relevant files/symbols via indexing
2. **Read** - Understand code with AST analysis and skeleton generation
3. **Edit** - Modify with transaction safety and crash recovery

**Token Efficiency**
- **Skeleton views**: 95-98% token reduction
- **Fragment reading**: 90% reduction for specific sections
- **Clustering**: Relevant files only, not entire project

**Enterprise-Grade Reliability**
- **ACID transactions** - All-or-nothing modifications
- **Crash recovery** - Automatic rollback on failure
- **Error enhancement** - Helpful recovery suggestions
- **Hash verification** - TOCTOU prevention

---

## 📖 Documentation Navigation

### By Use Case
- **Integrating into IDE** → [integration.md](./docs/guides/integration.md)
- **Understanding search** → [04-advanced-algorithms.md](./docs/architecture/04-advanced-algorithms.md)
- **Configuring for CI/CD** → [integration.md](./docs/guides/integration.md)
- **Understanding architecture** → [01-system-overview.md](./docs/architecture/01-system-overview.md)
- **Quick answers** → [FAQ.md](./docs/guides/FAQ.md)

### By Complexity
- 🟢 **Beginner** → getting-started.md, system-overview.md
- 🟡 **Intermediate** → integration.md, 03-tools-and-workflows.md
- 🔴 **Advanced** → 04-advanced-algorithms.md, 05-semantic-analysis.md, 06-reliability-engineering.md

---

## 🌐 For the International MCP Community

- **Language**: English
- **Format**: Markdown with code examples
- **Scope**: Complete coverage for v1.0.0
- **Community**: See [CONTRIBUTING.md](./docs/guides/CONTRIBUTING.md)

---

## 📝 Documentation Statistics

- **Total files**: 20 documentation files
- **Total size**: ~195KB of comprehensive docs
- **Code examples**: 60+ from actual source code
- **Diagrams**: 8+ Mermaid visualizations
- **Cross-references**: 95+ links throughout
- **Coverage**: All major components and workflows

---

**Last Updated:** 2025-12-15 (v1.0.0)  
**Status:** Production-Ready  
**License:** MIT  
**Author:** devkwan

→ **Start with your role above and choose your learning path!**
