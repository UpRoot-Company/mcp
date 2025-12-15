# Human Documentation for Smart Context MCP

Welcome to the comprehensive human-readable documentation for Smart Context MCP. This section is designed for developers, DevOps engineers, and system architects who need to understand, integrate, and maintain the Smart Context system.

## 📚 Documentation Structure

### 🏗️ [Architecture](./architecture/)
**Deep technical documentation on how Smart Context works internally.**

- **[01-system-overview.md](./architecture/01-system-overview.md)** (10min read)
  - Core mission and system philosophy
  - High-level component architecture
  - Key design decisions with rationale
  - Performance characteristics
  - Safety guarantees (ACID, crash recovery)
  - *Best for: Understanding the big picture*

- **[02-core-engine.md](./architecture/02-core-engine.md)** (15min read)
  - SQLite schema and indexing strategy
  - Symbol resolution mechanisms
  - Analysis modes (impact, dependencies, calls, data flow)
  - Operational procedures and troubleshooting
  - Real SQL queries and performance benchmarks
  - *Best for: Understanding how indexing and querying work*

- **[03-tools-and-workflows.md](./architecture/03-tools-and-workflows.md)** (12min read)
  - Tool catalog with practical examples
  - Real-world workflows (Beginner, Intermediate, Advanced)
  - Integration patterns for IDE plugins and CI/CD
  - Workflow selection guide by situation
  - *Best for: Learning common usage patterns*

- **[04-advanced-algorithms.md](./architecture/04-advanced-algorithms.md)** (18min read)
  - BM25F ranking algorithm explained
  - Trigram indexing and fuzzy matching
  - 6-level normalization hierarchy
  - Levenshtein distance and Patience diff
  - Algorithm performance comparisons
  - *Best for: Understanding search and matching logic*

- **[05-semantic-analysis.md](./architecture/05-semantic-analysis.md)** (12min read)
  - Tree-sitter AST parsing with WASM
  - Symbol extraction and skeleton generation
  - Call graph and dependency graph analysis
  - Token efficiency (95-98% savings)
  - *Best for: Understanding code analysis capabilities*

- **[06-reliability-engineering.md](./architecture/06-reliability-engineering.md)** (14min read)
  - ACID transaction lifecycle
  - Crash recovery mechanisms
  - Error enhancement system
  - Safety mechanisms (hash verification, path sandboxing)
  - Testing strategy and patterns
  - *Best for: Understanding reliability and safety guarantees*

- **[ADR-INDEX.md](./architecture/ADR-INDEX.md)** (5min reference)
  - Complete mapping of all 26 ADRs to documentation sections
  - Organized by topic for quick lookup
  - *Best for: Finding architectural decision rationales*

### 📖 [Guides](./guides/)
**Practical guides for common tasks and integration scenarios.**

- **[getting-started.md](./guides/getting-started.md)** (10-15min)
  - Installation (global and local modes)
  - Platform-specific configuration (Claude Desktop, GitHub Copilot, Cursor, Gemini)
  - Hello World examples with progressive difficulty
  - Performance expectations by project size
  - Quick troubleshooting
  - *Best for: Users new to Smart Context*

- **[integration.md](./guides/integration.md)** (20-30min)
  - IDE integration guides (VSCode, JetBrains, Cursor, Vim, Emacs)
  - GitHub Copilot vs VS Code extension development
  - CI/CD pipeline setup (GitHub Actions, GitLab)
  - Pre-commit hooks and build tool plugins
  - Security best practices
  - *Best for: Tool developers and DevOps engineers*

- **[agent-optimization.md](./guides/agent-optimization.md)** (15-20min)
  - Agent type identification (Claude, OpenAI, Gemini families)
  - LLM-specific configuration recipes
  - Performance benchmarks by agent type
  - Multi-agent workflows (Opus for planning, Haiku for execution)
  - Token budget management strategies
  - Context window optimization for different models
  - *Best for: Optimizing AI agents to work with Smart Context*

- **[tool-conflicts.md](./guides/tool-conflicts.md)** (10-15min)
  - Decision matrix: Bash commands vs smart-context tools
  - Performance comparison (grep vs search_project: 20x faster)
  - Common anti-patterns and corrections
  - Permission configuration strategies
  - Hybrid workflows combining both approaches
  - *Best for: Understanding tool conflict resolution*

- **[prompt-engineering.md](./guides/prompt-engineering.md)** (12-18min)
  - Core principles: Scout → Read → Edit pipeline
  - Prompt templates for common tasks
  - Multi-turn conversation patterns
  - Agent-specific prompt variations (Haiku, Sonnet, Opus, GPT-4o, Gemini)
  - Token optimization techniques
  - Error recovery prompts
  - *Best for: AI agents and engineers using Smart Context*

- **[permissions.md](./guides/permissions.md)** (10-15min)
  - `.claude/settings.local.json` configuration pattern
  - Permission patterns (read-only, development, production, minimal)
  - Bash command whitelisting/blacklisting
  - Per-agent configuration (Claude Desktop, VS Code, Cursor, CI/CD)
  - Security considerations and dangerous commands
  - Examples by use case
  - *Best for: Security and access control configuration*

- **[module-resolution.md](./guides/module-resolution.md)** (10-15min)
  - Module resolution types and algorithms
  - Path alias configuration
  - Monorepo support and circular dependency detection
  - Troubleshooting and performance tuning
  - *Best for: Developers working with complex module setups*

- **[configuration.md](./guides/configuration.md)** (10min reference)
  - Environment variables (13 options)
  - Engine profiles (production, ci, test)
  - Performance tuning strategies
  - Database and security configuration
  - Cross-references to agent-optimization and permissions guides
  - *Best for: System customization and optimization*

- **[CONTRIBUTING.md](./guides/CONTRIBUTING.md)** (15min)
  - Development setup instructions
  - Code style and conventions
  - Testing requirements (>80% coverage)
  - Git workflow and commit message format
  - ADR writing guide
  - *Best for: Open source contributors*

- **[FAQ.md](./guides/FAQ.md)** (10min reference)
  - 20+ frequently asked questions
  - General, technical, performance, troubleshooting, and best practices Q&A
  - *Best for: Quick answers to common questions*

- **[CHANGELOG.md](./guides/CHANGELOG.md)** (5-10min reference)
  - Version history (1.0.0, 1.0.0, 1.0.0)
  - Migration guides between major versions
  - Current release information
  - *Best for: Understanding what changed and how to upgrade*

## 🎯 Quick Start by Role

### 👤 **New Users**
1. Read [system-overview.md](./architecture/01-system-overview.md) (10min)
2. Follow [getting-started.md](./guides/getting-started.md) (15min)
3. Try a workflow from [03-tools-and-workflows.md](./architecture/03-tools-and-workflows.md) (5min)

**Total time:** ~30 minutes to productive use

### 🤖 **AI Agents / LLM-Based Tools**
1. Start: [prompt-engineering.md](./guides/prompt-engineering.md) - Core principles and templates
2. Optimize: [agent-optimization.md](./guides/agent-optimization.md) - Model-specific strategies
3. Resolve conflicts: [tool-conflicts.md](./guides/tool-conflicts.md) - When to use Bash vs smart-context
4. Configure: [permissions.md](./guides/permissions.md) - Tool access control
5. Reference: [integration.md](./guides/integration.md) for platform-specific setup

**Total time:** ~1 hour for comprehensive agent optimization

### 🔧 **Developers / System Integrators**
1. Start with [system-overview.md](./architecture/01-system-overview.md) for context
2. Deep dive: [02-core-engine.md](./architecture/02-core-engine.md) and [04-advanced-algorithms.md](./architecture/04-advanced-algorithms.md)
3. For integration: [integration.md](./guides/integration.md)
4. Optimization: [agent-optimization.md](./guides/agent-optimization.md) for working with AI agents
5. Reference: [configuration.md](./guides/configuration.md) and [module-resolution.md](./guides/module-resolution.md)

**Total time:** ~2-3 hours for comprehensive understanding

### 🚀 **DevOps / Infrastructure**
1. Quick reference: [getting-started.md](./guides/getting-started.md#platform-configuration)
2. Focus: [integration.md](./guides/integration.md) (CI/CD section)
3. Permissions: [permissions.md](./guides/permissions.md) for security configuration
4. Operational: [02-core-engine.md](./architecture/02-core-engine.md#operational-procedures)
5. Tuning: [configuration.md](./guides/configuration.md#performance-tuning)

**Total time:** ~1-2 hours for production setup

### 🐛 **Troubleshooters**
1. Quick answers: [FAQ.md](./guides/FAQ.md)
2. Platform-specific: [getting-started.md](./guides/getting-started.md#troubleshooting)
3. Tool conflicts: [tool-conflicts.md](./guides/tool-conflicts.md)
4. Deep analysis: Relevant architecture files by symptom
5. References: [ADR-INDEX.md](./architecture/ADR-INDEX.md) for design rationale

**Total time:** Varies by issue complexity

### 🤝 **Open Source Contributors**
1. Setup: [CONTRIBUTING.md](./guides/CONTRIBUTING.md#development-setup)
2. Code style: [CONTRIBUTING.md](./guides/CONTRIBUTING.md#code-style)
3. Architecture: [system-overview.md](./architecture/01-system-overview.md) → relevant deep dives
4. ADRs: [ADR-INDEX.md](./architecture/ADR-INDEX.md)

**Total time:** ~1 hour to start contributing

## 📊 Documentation Statistics

| Metric | Value |
|--------|-------|
| **Files** | 7 architecture + 14 guides |
| **Total size** | ~200KB of human documentation |
| **Code examples** | 50+ real examples from source |
| **Diagrams** | 8+ Mermaid visualizations |
| **Cross-references** | 120+ links throughout |
| **Coverage** | All major components, workflows, and optimization strategies |

## 🎓 Key Concepts

**Scout → Read → Edit Pipeline**
The canonical 3-stage workflow for code analysis and modification:
1. **Scout** - Find relevant files/symbols using search and indexing
2. **Read** - Understand code structure with AST analysis and skeleton generation
3. **Edit** - Make modifications with transaction safety and crash recovery

**Token Efficiency**
Smart Context dramatically reduces token usage through:
- **Skeleton generation**: 95-98% token reduction (250 tokens vs 15,000+)
- **Fragment reading**: 90% reduction for specific sections
- **Context clustering**: Relevant files only, not entire project
- **Agent-specific optimization**: Tailor token usage to model context windows

**Reliability First**
Built-in safety mechanisms:
- **ACID transactions**: All-or-nothing modifications
- **Crash recovery**: Automatic rollback on failure
- **Confidence scoring**: 0.0-1.0 reliability indicators
- **Error enhancement**: Helpful recovery suggestions

**Performance**
Optimized for large codebases:
- **Cold indexing**: 45-60 seconds for 10K files
- **Search latency**: 5-20ms P50 for symbol lookups
- **Memory efficient**: ~400MB for 10K files
- **Scalable**: Handles enterprise-scale codebases

**Agent Optimization**
Smart Context works with different AI models:
- **Claude Opus**: Large context (200K), detailed analysis
- **Claude Sonnet**: Balanced (200K context), most versatile
- **Claude Haiku**: Fast (100K context), cost-optimized
- **GPT-4o**: High quality, requires explicit prompting
- **Gemini 2.0**: Massive context (1M), bulk operations

## 🔍 Finding What You Need

### By Task
- **I want to integrate Smart Context into my IDE** → [integration.md](./guides/integration.md)
- **I need to optimize AI agents working with my code** → [agent-optimization.md](./guides/agent-optimization.md)
- **I need to configure tool permissions** → [permissions.md](./guides/permissions.md)
- **I want to understand the search algorithm** → [04-advanced-algorithms.md](./architecture/04-advanced-algorithms.md)
- **I'm setting up CI/CD pipeline** → [integration.md](./guides/integration.md#cicd-integration)
- **I need to resolve tool conflicts** → [tool-conflicts.md](./guides/tool-conflicts.md)
- **I need troubleshooting help** → [FAQ.md](./guides/FAQ.md)
- **I'm contributing code** → [CONTRIBUTING.md](./guides/CONTRIBUTING.md)
- **I need performance tuning** → [configuration.md](./guides/configuration.md#performance-tuning) and [agent-optimization.md](./guides/agent-optimization.md#performance-benchmarks)

### By Concept
- **Indexing** → [02-core-engine.md](./architecture/02-core-engine.md)
- **Search/Ranking** → [04-advanced-algorithms.md](./architecture/04-advanced-algorithms.md)
- **Code Analysis** → [05-semantic-analysis.md](./architecture/05-semantic-analysis.md)
- **Transactions/Safety** → [06-reliability-engineering.md](./architecture/06-reliability-engineering.md)
- **Module Resolution** → [guides/module-resolution.md](./guides/module-resolution.md)
- **Prompting AI agents** → [prompt-engineering.md](./guides/prompt-engineering.md)
- **Agent optimization** → [agent-optimization.md](./guides/agent-optimization.md)
- **Tool selection** → [tool-conflicts.md](./guides/tool-conflicts.md)

### By Complexity Level
- 🟢 **Beginner** → getting-started.md, system-overview.md, prompt-engineering.md
- 🟡 **Intermediate** → integration.md, agent-optimization.md, tool-conflicts.md, permissions.md
- 🔴 **Advanced** → 04-advanced-algorithms.md, 05-semantic-analysis.md, 06-reliability-engineering.md

## 📞 Support and Resources

- **Quick answers**: [FAQ.md](./guides/FAQ.md)
- **Agent-specific help**: [agent-optimization.md](./guides/agent-optimization.md), [prompt-engineering.md](./guides/prompt-engineering.md)
- **Security questions**: [permissions.md](./guides/permissions.md)
- **Tool decision help**: [tool-conflicts.md](./guides/tool-conflicts.md)
- **Architecture decisions**: [ADR-INDEX.md](./architecture/ADR-INDEX.md)
- **Code examples**: Throughout each guide and architecture doc
- **Source code**: Reference in each document with line numbers
- **Community**: See [CONTRIBUTING.md](./guides/CONTRIBUTING.md) for contribution guidelines

## 🎯 Documentation Goals

This documentation is designed to:
- ✅ **Be findable** - Multiple entry points and navigation paths
- ✅ **Be understandable** - Clear explanations with examples
- ✅ **Be actionable** - Practical guides with code samples
- ✅ **Be accurate** - Examples tested against actual source code
- ✅ **Be current** - Updated with latest features (v1.0.0)
- ✅ **Be agent-aware** - Guides for optimizing AI agent interactions

## 📋 What's Included

### ✅ Covered
- All major components (search, edit, analysis, indexing)
- Common workflows and integration patterns
- Algorithm explanations with implementations
- Configuration and performance tuning
- AI agent optimization and prompting strategies
- Tool permission and security configuration
- Tool conflict resolution
- Troubleshooting and FAQ
- Contributing guidelines

---

**Last Updated:** 2025-12-15 (v1.0.0)  
**Documentation Status:** Production-Ready  
**Total Learning Time:** 1-3 hours depending on role  
**New in v1.0.0:** Agent optimization guides, prompt engineering, tool conflict resolution, and permissions configuration  
**Next Step:** Choose your role above and start reading!
