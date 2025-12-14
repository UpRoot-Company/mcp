# AI Agent Documentation

**Smart Context MCP for Intelligent Code Analysis and Modification**

This section contains everything AI agents need to understand and effectively use Smart Context MCP. Optimized for LLMs and autonomous agents with token constraints.

---

## 📚 Core Documentation (Pick One)

### 1. [ARCHITECTURE.md](./ARCHITECTURE.md) - Start Here
**Understanding how Smart Context works internally**

- Scout → Read → Edit pipeline overview
- BM25F ranking algorithm with math
- Trigram indexing and fuzzy matching
- 6-level normalization hierarchy
- Skeleton generation (95-98% token savings)
- SQLite schema and indexing strategy
- Component architecture diagrams

**Best for:** Understanding the system fundamentals  
**Time:** 20-30 minutes

---

### 2. [AGENT_PLAYBOOK.md](./AGENT_PLAYBOOK.md) - Learn Patterns
**7 proven workflow patterns for common code tasks**

- Symbol Renaming Across Files 🟡
- Impact Analysis Before Refactoring 🔴
- Bug Finding & Fixing 🟢
- Feature Addition 🟡
- Large-Scale Refactoring 🔴
- Dependency Analysis 🟡
- Error Recovery & Fallbacks 🔴

Each pattern includes: step-by-step workflow, token analysis, tool selection, and error handling.

**Best for:** Learning how to structure agent actions  
**Time:** 15-20 minutes

---

### 3. [TOOL_REFERENCE.md](./TOOL_REFERENCE.md) - API Details
**Complete reference for all 10+ tools**

For each tool:
- Purpose and when to use
- Complete parameters with types
- Return format with JSON examples
- 3 usage patterns (🟢 Beginner → 🔴 Advanced)
- Error scenarios and recovery
- Performance characteristics and latency

Tools covered:
- `search_project` - Fast code discovery
- `read_code` - Files with skeleton/fragment support
- `edit_code` - Safe modifications with transactions
- `analyze_relationship` - Impact analysis
- `manage_project` - Undo/redo/status
- `get_batch_guidance` - Multi-file patterns
- Plus 5 more utility tools

**Best for:** Looking up tool parameters and examples  
**Time:** 30-40 minutes (reference)

---

## 🎯 Quick Navigation by Task

**I want to...**

| Task | Read This | Then Reference |
|------|-----------|-----------------|
| Rename a function across files | [AGENT_PLAYBOOK](./AGENT_PLAYBOOK.md#pattern-1) | [search_project + edit_code](./TOOL_REFERENCE.md#search_project) |
| Check what changes will impact | [AGENT_PLAYBOOK](./AGENT_PLAYBOOK.md#pattern-2) | [analyze_relationship](./TOOL_REFERENCE.md#analyze_relationship) |
| Find and fix a bug | [AGENT_PLAYBOOK](./AGENT_PLAYBOOK.md#pattern-3) | [search_project + read_code](./TOOL_REFERENCE.md#search_project) |
| Add a new feature | [AGENT_PLAYBOOK](./AGENT_PLAYBOOK.md#pattern-4) | [get_batch_guidance](./TOOL_REFERENCE.md#get_batch_guidance) |
| Refactor large codebase | [AGENT_PLAYBOOK](./AGENT_PLAYBOOK.md#pattern-5) | [analyze_relationship](./TOOL_REFERENCE.md#analyze_relationship) |
| Understand the system | [ARCHITECTURE.md](./ARCHITECTURE.md) | All 3 files |

---

## 🔑 Key Concepts

### Scout → Read → Edit Pipeline
The canonical 3-stage workflow:

```
┌──────────────────────────────────────────────────────────────────┐
│     SCOUT (200ms)   →   READ (100-300ms)   →   EDIT (100-500ms)  │
│                                                                  │
│ • BM25F ranking        • Full view              • Replace text   │
│ • Trigram matching     • Skeleton view          • Create/delete  │
│ • 3-tier fallback      • Fragment selection     • Transactions   │
│ • Confidence scores    • AST analysis           • Fuzzy matching │
│                                                                  │
│ Avg Token Cost:        Avg Token Cost:          Avg Token Cost:  │
│ 800-2K tokens          200-5K tokens            500-2K tokens    │
└──────────────────────────────────────────────────────────────────┘
```

### Token Efficiency
Smart Context dramatically reduces token usage:

| View | Avg Tokens | Savings | When to Use |
|------|-----------|---------|-------------|
| **full** | 500+ | 0% | Need complete context |
| **skeleton** | 15 | 97% | Structure only |
| **fragment** | 200 | 90% | Specific section |

**Example:** 500-line file takes 500 tokens on full view vs. 15 tokens with skeleton (97% savings!)

See [AGENT_PLAYBOOK.md](./AGENT_PLAYBOOK.md#token-efficiency-analysis) for detailed analysis.

### Reliability
- **ACID Transactions** - All-or-nothing modifications
- **Confidence Scoring** - Match reliability (0.0-1.0)
- **Error Recovery** - Graceful fallback strategies
- **Hash Verification** - TOCTOU attack prevention

---

## 📋 Tool Quick Reference

### Search & Discovery
| Tool | Use For | Speed |
|------|---------|-------|
| `search_project` | Find symbols, files, code patterns | 5-20ms P50 |

### Reading Code
| Tool | Use For | Token Savings |
|------|---------|---------------|
| `read_code` (skeleton) | Get structure | 97% |
| `read_code` (fragment) | Get specific section | 90% |
| `read_code` (full) | Get complete file | 0% |

### Understanding Impact
| Tool | Analysis Type | Output |
|------|---------------|--------|
| `analyze_relationship` | Impact on change | Call graph |
| `analyze_relationship` | Dependencies | Import graph |
| `analyze_relationship` | Data flow | Value trace |

### Safe Modification
| Tool | Purpose | Safety |
|------|---------|--------|
| `edit_code` | Modify code | ACID transaction |
| `get_batch_guidance` | Multi-file patterns | Refactoring hints |
| `manage_project` | Undo/redo | Transaction rollback |

Full details: See [TOOL_REFERENCE.md](./TOOL_REFERENCE.md)

---

## 🚀 Recommended Learning Path

### For New Agents (30-40 minutes)
1. **Read:** [ARCHITECTURE.md](./ARCHITECTURE.md) - Understand the Scout→Read→Edit pipeline
2. **Read:** [AGENT_PLAYBOOK.md](./AGENT_PLAYBOOK.md) - Learn the 7 patterns
3. **Reference:** [TOOL_REFERENCE.md](./TOOL_REFERENCE.md) - Bookmark for later lookup

### For Quick Lookup
- **"How do I call this tool?"** → [TOOL_REFERENCE.md](./TOOL_REFERENCE.md)
- **"What pattern should I use?"** → [AGENT_PLAYBOOK.md](./AGENT_PLAYBOOK.md)
- **"Why does this work?"** → [ARCHITECTURE.md](./ARCHITECTURE.md)

### For Deep Dives
- **Token optimization** → [AGENT_PLAYBOOK.md - Token Analysis](./AGENT_PLAYBOOK.md#token-efficiency-analysis)
- **Algorithm details** → [../architecture/04-advanced-algorithms.md](../architecture/04-advanced-algorithms.md)
- **Safety guarantees** → [../architecture/06-reliability-engineering.md](../architecture/06-reliability-engineering.md)

---

## 💡 Agent Capabilities at a Glance

| Capability | What It Does | Reference |
|------------|-------------|-----------|
| **Symbol resolution** | Find symbols even with fuzzy names | [ARCHITECTURE.md](./ARCHITECTURE.md#symbol-resolution) |
| **Skeleton views** | 97% token reduction for structure | [AGENT_PLAYBOOK.md](./AGENT_PLAYBOOK.md#token-efficiency) |
| **Safe editing** | ACID transactions prevent corruption | [ARCHITECTURE.md](./ARCHITECTURE.md#transactions) |
| **Impact analysis** | See what changes will break | [AGENT_PLAYBOOK.md](./AGENT_PLAYBOOK.md#pattern-2) |
| **Error recovery** | Helpful suggestions on failure | [AGENT_PLAYBOOK.md](./AGENT_PLAYBOOK.md#error-recovery) |
| **Batch operations** | Refactor multiple files safely | [AGENT_PLAYBOOK.md](./AGENT_PLAYBOOK.md#pattern-5) |
| **Fuzzy matching** | Handle formatting differences | [ARCHITECTURE.md](./ARCHITECTURE.md#normalization) |
| **Confidence scores** | Know reliability of each match | [TOOL_REFERENCE.md](./TOOL_REFERENCE.md#confidence) |

---

## 🔗 Connection to Human Documentation

AI agents can also reference human-focused documentation for context:

| Need | Human Doc |
|------|-----------|
| Integration patterns | [../guides/integration.md](../guides/integration.md) |
| Configuration options | [../guides/configuration.md](../guides/configuration.md) |
| General FAQ | [../guides/FAQ.md](../guides/FAQ.md) |
| Architecture deep-dive | [../architecture/](../architecture/) |

---

## ❓ Common Questions

**Q: What's the difference between `read_code(view="skeleton")` and `read_code(view="fragment")`?**
A: Skeleton gives structure only (15 tokens), fragment gives specific lines (200 tokens). Use skeleton for overview, fragment for specific sections.

**Q: How do I know if a match is reliable?**
A: Check the `confidence` field (0.0-1.0). Values >0.9 are highly reliable. Use `confidence` in decision-making.

**Q: Should I use transactions for single edits?**
A: Yes, always. Transactions prevent corruption and allow rollback. They have minimal overhead.

**Q: Can I edit multiple files at once?**
A: Yes, use `edit_code` with multiple edits in one call. All succeed or all fail (ACID guarantee).

**Q: How do I optimize token usage?**
A: Use skeleton views (97% savings), fragment for specific sections (90% savings), and search before reading.

See [../guides/FAQ.md](../guides/FAQ.md) for more.

---

## 📈 Performance Expectations

| Operation | Latency P50 | Latency P95 |
|-----------|------------|------------|
| Symbol search | 5-20ms | 50-100ms |
| File read (skeleton) | 1-5ms | 10-20ms |
| File read (full) | 10-50ms | 100-300ms |
| Single edit | 100-200ms | 500ms |
| Batch edit (10 files) | 500-1000ms | 2-3s |
| Impact analysis | 50-200ms | 500-1000ms |

Cold indexing on first run: 45-60 seconds for 10K files (one-time only).

---

## 🎓 Next Steps

1. **Start with basics:** Read [ARCHITECTURE.md](./ARCHITECTURE.md) (20 min)
2. **Learn patterns:** Study [AGENT_PLAYBOOK.md](./AGENT_PLAYBOOK.md) (15 min)
3. **Build something:** Use [TOOL_REFERENCE.md](./TOOL_REFERENCE.md) as you code
4. **Optimize:** Check [AGENT_PLAYBOOK.md - Token Analysis](./AGENT_PLAYBOOK.md#token-efficiency-analysis) to save tokens

---

## 📞 Getting Help

- **Need tool parameters?** → [TOOL_REFERENCE.md](./TOOL_REFERENCE.md)
- **Confused about workflow?** → [AGENT_PLAYBOOK.md](./AGENT_PLAYBOOK.md)
- **Why something works?** → [ARCHITECTURE.md](./ARCHITECTURE.md)
- **General questions?** → [../guides/FAQ.md](../guides/FAQ.md)
- **Setup issues?** → [../guides/getting-started.md](../guides/getting-started.md)

---

**Version:** 1.0.0  
**Last Updated:** 2025-12-15  
**Status:** Production-Ready ⭐⭐⭐⭐⭐

Made for AI agents. By developers. With ❤️.
