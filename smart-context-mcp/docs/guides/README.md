# Guides

**Practical guides for using, integrating, and configuring Smart Context MCP.**

This section contains everything you need to install, configure, integrate, and troubleshoot Smart Context.

---

## 📚 Complete Guide Index

### 🚀 Getting Started

**[getting-started.md](./getting-started.md)** - Installation and First Use  
**Time:** 10-15 minutes  
**For:** New users, quick setup

**Covers:**
- Prerequisites and installation (global vs local)
- Platform-specific configuration:
  - Claude Desktop
  - GitHub Copilot
  - Cursor IDE
  - Google Gemini
  - OpenAI Codex
- 3 Hello World examples (progressive difficulty)
- Performance expectations
- Troubleshooting by platform

**Start here if:** You're new to Smart Context

---

### 🔌 Integration

**[integration.md](./integration.md)** - IDE and Tool Integration  
**Time:** 20-30 minutes  
**For:** Tool developers, IDE setup

**Covers:**
- Quick start for tool developers
- PathNormalizer and RootDetector APIs
- IDE-specific integration guides:
  - VSCode Copilot (with TypeScript example)
  - JetBrains IDEs (IntelliJ, PyCharm, etc.)
  - Cursor IDE
  - Vim/Neovim (Lua configuration)
  - Emacs (Elisp configuration)
- CI/CD Pipeline integration:
  - GitHub Actions example
  - GitLab CI example
  - Pre-commit hooks (bash)
- Build tool plugins:
  - Webpack
  - Vite
- Security best practices
- Comprehensive troubleshooting

**Read this if:** You want to integrate Smart Context with your IDE or pipeline

---

### 📦 Module Resolution

**[module-resolution.md](./module-resolution.md)** - Module Dependency System  
**Time:** 10-15 minutes  
**For:** Understanding module resolution, monorepo setup

**Covers:**
- How module resolution works
- Resolution types:
  - Relative imports (./,  ../)
  - Absolute imports
  - Node modules (npm packages)
  - Path aliases (@components, @utils)
  - Directory indexes
- Configuration:
  - Automatic detection
  - TypeScript path aliases
  - Monorepo setup
  - Custom markers
- Real-world examples with traces
- Troubleshooting:
  - Unresolved modules
  - Wrong file resolution
  - Monorepo issues
  - Circular imports
- Performance tuning
- Advanced topics (package exports, declaration files)
- Best practices

**Read this if:** You have import/module resolution issues

---

### ⚙️ Configuration

**[configuration.md](./configuration.md)** - Environment Variables and Settings  
**Time:** 10 minutes  
**For:** Customizing Smart Context behavior

**Covers:**
- 13 Environment variables:
  - Server configuration (port, root)
  - Performance settings (cache size, threads)
  - Database settings (path, mode)
  - Parser backend (wasm, js, snapshot)
  - Debug options
- 3 Engine profiles:
  - production (high safety)
  - ci (balanced)
  - test (fast)
- Language configuration:
  - Custom language mappings
  - File extension associations
  - Tree-sitter grammars
- Performance tuning:
  - Large projects (>100K files)
  - CI/CD environments
  - Memory-constrained devices
- Database management:
  - SQLite operations
  - Index optimization
  - Backup procedures
- Security configuration:
  - Path restrictions
  - Backup retention
  - Transaction timeouts
- Troubleshooting configuration issues

**Read this if:** You need to customize Smart Context

---

### 🤝 Contributing

**[CONTRIBUTING.md](./CONTRIBUTING.md)** - Development Guide  
**Time:** 15 minutes  
**For:** Contributors to the Smart Context project

**Covers:**
- Quick start (fork, install, test, dev)
- Development setup
- Project structure overview
- TypeScript code style guide:
  - Naming conventions
  - Formatting rules
  - File organization
- Testing requirements:
  - >80% coverage target
  - Unit test structure
  - Integration tests
- Git workflow:
  - Branch naming
  - Conventional commits
  - Commit message format
- ADR writing guide:
  - When to write
  - Template structure
  - Decision documentation
- Pull request process:
  - PR template
  - Review checklist
- Release process:
  - Version bumping
  - Testing
  - Tagging

**Read this if:** You want to contribute to Smart Context

---

### ❓ FAQ

**[FAQ.md](./FAQ.md)** - Frequently Asked Questions  
**Time:** 10 minutes  
**For:** Quick answers to common questions

**Covers 20+ Q&A pairs:**

**General Questions**
- What is Smart Context MCP?
- How does it compare to LSP?
- What languages are supported?
- Which AI assistants work with it?

**Technical Questions**
- Why SQLite instead of in-memory?
- How does skeleton generation work?
- What is the token savings?
- What are the 6 normalization levels?
- How do ACID transactions work?

**Performance Questions**
- How long does indexing take?
- What's the search latency?
- Does it work on large projects?
- Will it slow down my IDE?

**Troubleshooting Questions**
- Index corruption recovery
- Slow search performance
- Edit failures and recovery
- Memory usage issues

**Best Practices**
- When to use skeleton vs full?
- How many files to edit at once?
- Optimal search strategies
- Workflow recommendations

**Read this if:** You have quick questions

---

### 📋 Changelog

**[CHANGELOG.md](./CHANGELOG.md)** - Version History and Migration  
**Time:** 5-10 minutes  
**For:** Understanding updates and migrating versions

**Covers:**
- Version 1.0.0 (Current Release)
  - 26 ADRs implemented
  - Symbol resolution 3-tier fallback
  - Filename search type
  - Agent workflow guidance
  - Enhanced error messages
  - Batch edit guidance
  - Memory-bounded architecture
  - 6-level normalization (upgraded from 3-level)
- Version 1.0.0 (Initial Release)
  - Core Scout → Read → Edit pipeline
  - SQLite indexing
  - ACID transactions
- Version 1.0.0 (Early MCP Implementation)
- Migration guides:
  - Initial release: API changes
  - Feature updates: New features
- Known issues per version
- Performance metrics
- Roadmap for 5.0-5.2

**Read this if:** You're upgrading or need version history

---

## 🎯 Quick Navigation by Task

**I want to...**

- **Install Smart Context**  
  → [getting-started.md](./getting-started.md)

- **Set up in my IDE (VSCode, Vim, etc.)**  
  → [integration.md](./integration.md)

- **Use in my CI/CD pipeline**  
  → [integration.md - CI/CD Integration](./integration.md#cicd-integration)

- **Fix module resolution issues**  
  → [module-resolution.md](./module-resolution.md)

- **Customize behavior with environment variables**  
  → [configuration.md](./configuration.md)

- **Answer a quick question**  
  → [FAQ.md](./FAQ.md)

- **Contribute to the project**  
  → [CONTRIBUTING.md](./CONTRIBUTING.md)

- **See what changed in a new version**  
  → [CHANGELOG.md](./CHANGELOG.md)

---

## 📖 Reading Recommendations

### For New Users
1. [getting-started.md](./getting-started.md) - Install & configure
2. [integration.md](./integration.md) - Set up your IDE
3. [FAQ.md](./FAQ.md) - Answer quick questions

### For Developers
1. [integration.md](./integration.md) - Understand PathNormalizer API
2. [module-resolution.md](./module-resolution.md) - Module system
3. [configuration.md](./configuration.md) - Customization options

### For DevOps/CI
1. [integration.md - CI/CD Integration](./integration.md#cicd-integration)
2. [configuration.md](./configuration.md) - Environment variables
3. [CHANGELOG.md](./CHANGELOG.md) - Version compatibility

### For Contributors
1. [CONTRIBUTING.md](./CONTRIBUTING.md) - Setup & guidelines
2. [../architecture/ADR-INDEX.md](../architecture/ADR-INDEX.md) - Design decisions
3. [../architecture/](../architecture/) - Technical deep dives

---

## 🔗 Cross-References

**Related documentation:**
- **AI Agent guides:** [../../agent/](../../agent/)
  - [AGENT_PLAYBOOK.md](../../agent/AGENT_PLAYBOOK.md) - 7 workflow patterns
  - [TOOL_REFERENCE.md](../../agent/TOOL_REFERENCE.md) - Tool API reference
  
- **Architecture documentation:** [../architecture/](../architecture/)
  - [01-system-overview.md](../architecture/01-system-overview.md) - System design
  - [02-core-engine.md](../architecture/02-core-engine.md) - Internal mechanisms
  - [03-tools-and-workflows.md](../architecture/03-tools-and-workflows.md) - Tool guide
  - [04-advanced-algorithms.md](../architecture/04-advanced-algorithms.md) - Algorithm deep dives
  - [05-semantic-analysis.md](../architecture/05-semantic-analysis.md) - AST & analysis
  - [06-reliability-engineering.md](../architecture/06-reliability-engineering.md) - Safety & recovery

---

## 📊 Guide Complexity Levels

| Guide | Level | Time | Best For |
|-------|-------|------|----------|
| getting-started.md | 🟢 Beginner | 10-15m | First-time setup |
| FAQ.md | 🟢 Beginner | 5-10m | Quick answers |
| configuration.md | 🟡 Intermediate | 10m | Customization |
| module-resolution.md | 🟡 Intermediate | 10-15m | Problem-solving |
| integration.md | 🟡 Intermediate | 20-30m | IDE/CI setup |
| CONTRIBUTING.md | 🔴 Advanced | 15m | Development |
| CHANGELOG.md | 📋 Reference | 5-10m | Version info |

---

## ✨ Key Features Documented

| Feature | Guide | Details |
|---------|-------|---------|
| **Installation** | getting-started.md | Global/local, platform-specific |
| **IDE Integration** | integration.md | VSCode, Vim, JetBrains, Emacs |
| **CI/CD Pipeline** | integration.md | GitHub Actions, GitLab, pre-commit |
| **Configuration** | configuration.md | 13 environment variables |
| **Module Resolution** | module-resolution.md | Aliases, monorepo, troubleshooting |
| **Troubleshooting** | Multiple guides | Each guide has troubleshooting |
| **Performance** | Getting-started.md | Performance expectations |

---

## 🆘 Troubleshooting Quick Links

**Common issues and solutions:**

- **Installation problems** → [getting-started.md - Troubleshooting](./getting-started.md#troubleshooting)
- **IDE integration issues** → [integration.md - Troubleshooting](./integration.md#troubleshooting)
- **Module resolution errors** → [module-resolution.md - Troubleshooting](./module-resolution.md#troubleshooting)
- **Performance issues** → [FAQ.md](./FAQ.md) (search for "slow", "performance", "latency")
- **Configuration problems** → [configuration.md - Troubleshooting](./configuration.md#troubleshooting-configuration-issues)
- **General questions** → [FAQ.md](./FAQ.md)

---

## 📞 Support Resources

- **Questions:** [FAQ.md](./FAQ.md)
- **Problems:** Troubleshooting sections in each guide
- **Contributing:** [CONTRIBUTING.md](./CONTRIBUTING.md)
- **Architecture:** [../architecture/](../architecture/) for deep dives

---

**Status:** All guides production-ready ⭐⭐⭐⭐⭐  
**Last updated:** 2025-12-14

Choose a guide above to get started!
