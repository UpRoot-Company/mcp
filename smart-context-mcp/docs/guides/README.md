# Guides

**Practical guides for using, integrating, and configuring Smart Context MCP.**

**Audience:** This directory is written FOR humans (developers, DevOps engineers, system architects).

**For AI agents:** See [../agent/](../agent/) for agent-specific technical documentation.

**Mixed audience guides:** Some guides in this directory (agent-optimization.md, prompt-engineering.md) serve both humans configuring agents AND agents optimizing their own behavior.

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
  - Claude Code
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
  - Claude Code
  - GitHub Copilot (VS Code)
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

### 🤖 Agent Optimization

**[agent-optimization.md](./agent-optimization.md)** - LLM-Specific Configuration and Strategies  
**Time:** 15-20 minutes  
**For:** Optimizing AI agents to work with Smart Context

**Covers:**
- Agent type identification:
  - Claude family (Opus, Sonnet, Haiku)
  - OpenAI Codex (GPT-5.1-Codex)
  - Google Gemini (3 Pro, 2.0 Flash)
- LLM-specific configuration recipes
- Tool conflict resolution strategies
- Performance benchmarks by agent type
- Multi-agent workflows (Opus for planning, Haiku for execution)
- Token budget management by model
- Context window optimization
- Tool permission optimization by agent type
- Prompt engineering tips per agent

**Read this if:** You want to optimize AI agents for Smart Context

---

### 🔄 Tool Conflict Resolution

**[tool-conflicts.md](./tool-conflicts.md)** - Bash vs Smart Context Decision Guide  
**Time:** 10-15 minutes  
**For:** Understanding when to use Bash commands vs smart-context tools

**Covers:**
- Decision matrix: Bash commands vs smart-context tools
- Detailed comparisons (file finding, code search, reading, editing)
- Performance comparison (grep vs search_project: 20x faster)
- Common anti-patterns and corrections
- Permission configuration strategies (restrictive, development, production)
- Hybrid workflows combining both approaches
- Security considerations and dangerous commands
- Performance benchmarks and token cost analysis

**Read this if:** You're deciding whether to use Bash or smart-context tools

---

### 💬 Prompt Engineering

**[prompt-engineering.md](./prompt-engineering.md)** - How to Communicate Effectively with Smart Context  
**Time:** 12-18 minutes  
**For:** AI agents and engineers using Smart Context

**Covers:**
- Core principles: Scout → Read → Edit pipeline
- Prompt templates for common tasks:
  - Symbol renaming across files
  - Impact analysis
  - Bug fixing workflow
  - Code quality audits
- Multi-turn conversation patterns
- Agent-specific prompt variations (Haiku, Sonnet, Opus, GPT-4o, Gemini)
- Error recovery prompts (NO_MATCH, AMBIGUOUS_MATCH, PERMISSION_DENIED)
- Token optimization techniques (skeleton-first, fragment vs full, batch edits)
- Quality checklist before calling tools
- Real-world examples
- Common pitfalls and how to avoid them

**Read this if:** You want to maximize efficiency and quality of Smart Context usage

---

### 🔐 Tool Permissions Configuration

**[permissions.md](./permissions.md)** - Access Control and Security  
**Time:** 10-15 minutes  
**For:** Configuring tool access and security policies

**Covers:**
- `.claude/settings.json` configuration pattern
- Permission patterns by use case
- Bash and tool whitelisting/blacklisting
- Per-agent configuration:
  - Claude Code (Anthropic)
  - Codex (OpenAI)
  - Gemini CLI (Google)
  - GitHub Copilot & Cursor
  - CI/CD systems
- Environment-specific patterns (development, staging, production)
- Best practices and tool exclusion guidelines
- Examples by use case (code review, testing, documentation)

**Read this if:** You need to configure tool access control and security

---

### 🚀 Advanced Tool Tuning & Optimization

  
**Time:** 30-45 minutes  
**For:** Advanced users, DevOps engineers, platform teams

**Covers:**
- All 11 core tools: characteristics, token costs, and latency
- Model-specific tool strategies:
  - Claude Haiku (cost-optimized, 100K context)
  - Claude Sonnet (balanced default, 200K context)
  - Claude Opus (maximum intelligence, 200K context)
  - Codex (agentic coding, 256K context)
  - Gemini Pro (massive context, 1M tokens, bulk ops)
  - Gemini Flash (speed-optimized, 1M tokens)
- Use-case-specific configurations:
  - Analysis-only (read-only)
  - Auto-fix (automated remediation)
  - Performance-optimized (speed + cost)
  - Security-hardened (locked down)
- Environment variable tuning matrices
- Token budget & latency optimization
- Tool selection decision trees
- Advanced patterns and monitoring
- Complete configuration templates (CI/CD, code review, real-time)

**Read this if:** You're building production AI automation, optimizing for specific use cases, or need fine-grained control

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

- **Optimize AI agents for Smart Context**  
  → [agent-optimization.md](./agent-optimization.md)

- **Decide between Bash and smart-context tools**  
  → [tool-conflicts.md](./tool-conflicts.md)

- **Learn how to prompt Smart Context effectively**  
  → [prompt-engineering.md](./prompt-engineering.md)

- **Configure tool permissions and security**  
  → [permissions.md](./permissions.md)

- **Build production AI automation with fine-grained control**  
  → [agent-optimization.md](./agent-optimization.md)

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

### For AI Agents & LLM-Based Tools
1. [prompt-engineering.md](./prompt-engineering.md) - Core principles and templates
2. [agent-optimization.md](./agent-optimization.md) - Model-specific strategies
3. [tool-conflicts.md](./tool-conflicts.md) - Tool selection guidance
4. [permissions.md](./permissions.md) - Access control configuration


### For Developers
1. [integration.md](./integration.md) - Understand PathNormalizer API
2. [module-resolution.md](./module-resolution.md) - Module system
3. [configuration.md](./configuration.md) - Customization options

### For DevOps/CI
1. [integration.md - CI/CD Integration](./integration.md#cicd-integration)
2. [configuration.md](./configuration.md) - Environment variables
3. [permissions.md](./permissions.md) - Security configuration
4. [agent-optimization.md](./agent-optimization.md) - Production tuning
5. [CHANGELOG.md](./CHANGELOG.md) - Version compatibility

### For Platform Engineers & Automation Teams
1. [agent-optimization.md](./agent-optimization.md) - Complete tool reference
2. [agent-optimization.md](./agent-optimization.md) - Model-specific strategies
3. [permissions.md](./permissions.md) - Access control strategies
4. [TOOL_REFERENCE.md](../agent/TOOL_REFERENCE.md) - Tool API details

### For Contributors
1. [CONTRIBUTING.md](./CONTRIBUTING.md) - Setup & guidelines
2. [../architecture/ADR-INDEX.md](../architecture/ADR-INDEX.md) - Design decisions
3. [../architecture/](../architecture/) - Technical deep dives

---

## 🔗 Cross-References

**Related documentation:**
- **AI Agent guides:** [../agent/](../agent/)
  - [AGENT_PLAYBOOK.md](../agent/AGENT_PLAYBOOK.md) - 7 workflow patterns
  - [TOOL_REFERENCE.md](../agent/TOOL_REFERENCE.md) - Tool API reference
  
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
| tool-conflicts.md | 🟡 Intermediate | 10-15m | Tool selection |
| configuration.md | 🟡 Intermediate | 10m | Customization |
| module-resolution.md | 🟡 Intermediate | 10-15m | Problem-solving |
| agent-optimization.md | 🟡 Intermediate | 15-20m | Agent optimization |
| prompt-engineering.md | 🟡 Intermediate | 12-18m | Effective prompting |
| permissions.md | 🟡 Intermediate | 10-15m | Security config |
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
| **Agent Optimization** | agent-optimization.md | LLM-specific strategies |
| **Tool Selection** | tool-conflicts.md | Bash vs smart-context decisions |
| **Prompting** | prompt-engineering.md | Effective communication patterns |
| **Permissions** | permissions.md | Access control and security |

| **Troubleshooting** | Multiple guides | Each guide has troubleshooting |
| **Performance** | getting-started.md | Performance expectations |

---

## 🆘 Troubleshooting Quick Links

**Common issues and solutions:**

- **Installation problems** → [getting-started.md - Troubleshooting](./getting-started.md#troubleshooting)
- **IDE integration issues** → [integration.md - Troubleshooting](./integration.md#troubleshooting)
- **Module resolution errors** → [module-resolution.md - Troubleshooting](./module-resolution.md#troubleshooting)
- **Agent optimization issues** → [agent-optimization.md](./agent-optimization.md)
- **Tool selection questions** → [tool-conflicts.md](./tool-conflicts.md)
- **Prompting effectiveness** → [prompt-engineering.md](./prompt-engineering.md)
- **Permission/security issues** → [permissions.md](./permissions.md)
- **Advanced tuning & optimization** → [agent-optimization.md](./agent-optimization.md)
- **Performance issues** → [FAQ.md](./FAQ.md) (search for "slow", "performance", "latency")
- **Configuration problems** → [configuration.md - Troubleshooting](./configuration.md#troubleshooting-configuration-issues)
- **General questions** → [FAQ.md](./FAQ.md)

---

## 📞 Support Resources

- **Quick answers:** [FAQ.md](./FAQ.md)
- **Agent optimization:** [agent-optimization.md](./agent-optimization.md) + [prompt-engineering.md](./prompt-engineering.md)
- **Tool decisions:** [tool-conflicts.md](./tool-conflicts.md)
- **Security/permissions:** [permissions.md](./permissions.md)
- **Advanced tuning:** [agent-optimization.md](./agent-optimization.md)
- **Troubleshooting:** Each guide has a troubleshooting section
- **Contributing:** [CONTRIBUTING.md](./CONTRIBUTING.md)
- **Architecture:** [../architecture/](../architecture/) for deep dives

---

**Status:** All guides production-ready ⭐⭐⭐⭐⭐  
**Last updated:** 2025-12-15

Choose a guide above to get started!
