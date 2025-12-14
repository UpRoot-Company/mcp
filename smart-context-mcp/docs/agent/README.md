# AI Agent Documentation

**Comprehensive guides for AI agents using Smart Context MCP.**

This section contains everything an AI agent needs to understand and use Smart Context effectively.

---

## 📚 Documentation Hub

### 1. [AGENT_PLAYBOOK.md](./AGENT_PLAYBOOK.md) - Workflow Patterns
**For:** AI agents learning the Scout→Read→Edit pipeline  
**Time to read:** 15-20 minutes

Covers 7 advanced workflow patterns for common tasks:
- Symbol Renaming Across Files 🟡
- Impact Analysis Before Refactoring 🔴
- Bug Finding & Fixing 🟢
- Feature Addition 🟡
- Large-Scale Refactoring 🔴
- Dependency Analysis 🟡
- Error Recovery 🔴

Includes token efficiency analysis, performance optimization, and recovery strategies.

### 2. [TOOL_REFERENCE.md](./TOOL_REFERENCE.md) - Complete API Reference
**For:** Detailed parameter documentation  
**Time to read:** 30-40 minutes

Complete reference for 10+ tools:
- `search_project` - Fast code discovery
- `read_code` - File structure and content
- `edit_code` - Safe code modification
- `analyze_relationship` - Impact analysis
- `manage_project` - Undo/redo/status
- `get_batch_guidance` - Multi-file editing
- Plus 5 more utility tools

Each tool includes:
- Purpose & when to use
- Complete parameters table
- Return format & JSON examples
- 3 usage patterns (🟢 Beginner → 🔴 Advanced)
- Error scenarios & recovery
- Performance characteristics

### 3. [ARCHITECTURE.md](./ARCHITECTURE.md) - Technical Architecture
**For:** Understanding internal design  
**Time to read:** 20-30 minutes

Deep dive into the Scout→Read→Edit pipeline:
- BM25F ranking algorithm
- Trigram indexing for fuzzy search
- 6-level normalization hierarchy
- Skeleton generation (95-98% token savings)
- Transaction-based editing
- SQLite database schema
- Component architecture
- Performance characteristics
- Design patterns

---

## 🎯 Quick Start by Use Case

**I want to...**

- **Rename a function across files**  
  → Read: [AGENT_PLAYBOOK.md - Pattern 1](./AGENT_PLAYBOOK.md#pattern-1-symbol-renaming-across-files)  
  → Reference: [TOOL_REFERENCE.md - search_project + edit_code](./TOOL_REFERENCE.md#search_project)

- **Understand the impact of changes**  
  → Read: [AGENT_PLAYBOOK.md - Pattern 2](./AGENT_PLAYBOOK.md#pattern-2-impact-analysis-before-refactoring)  
  → Reference: [TOOL_REFERENCE.md - analyze_relationship](./TOOL_REFERENCE.md#analyze_relationship)

- **Find and fix a bug**  
  → Read: [AGENT_PLAYBOOK.md - Pattern 3](./AGENT_PLAYBOOK.md#pattern-3-bug-finding--fixing)  
  → Reference: [TOOL_REFERENCE.md - search_project + read_code](./TOOL_REFERENCE.md#search_project)

- **Add a new feature**  
  → Read: [AGENT_PLAYBOOK.md - Pattern 4](./AGENT_PLAYBOOK.md#pattern-4-feature-addition)  
  → Reference: [TOOL_REFERENCE.md - get_batch_guidance](./TOOL_REFERENCE.md#get_batch_guidance)

- **Do large-scale refactoring**  
  → Read: [AGENT_PLAYBOOK.md - Pattern 5](./AGENT_PLAYBOOK.md#pattern-5-large-scale-refactoring)  
  → Reference: [TOOL_REFERENCE.md - Tool Composition Patterns](./TOOL_REFERENCE.md#tool-composition-patterns)

- **Understand how this all works**  
  → Read: [ARCHITECTURE.md](./ARCHITECTURE.md)

---

## 📊 Token Efficiency Guide

Smart Context is optimized for AI agents with token constraints:

| View | Tokens | Savings | When to Use |
|------|--------|---------|------------|
| **skeleton** | 15 | 97% | Structure only |
| **fragment** | 200 | 90% | Specific section |
| **full** | 500+ | 0% | Complete context |

**Example:** 500-line file
- Full read: 500 tokens
- Skeleton: 15 tokens (97% savings!)
- Fragment (100 lines): 50 tokens (90% savings)

See [AGENT_PLAYBOOK.md - Token Efficiency Analysis](./AGENT_PLAYBOOK.md#token-efficiency-analysis) for detailed breakdown.

---

## 🔄 The Scout → Read → Edit Pipeline

```
┌─────────────────────────────────────────────────┐
│         Scout → Read → Edit Pipeline           │
├─────────────────────────────────────────────────┤
│                                                 │
│ SCOUT (200ms)      READ (100-300ms)  EDIT (100-500ms)
│ ├─ Find code       ├─ Full view     ├─ Replace text
│ ├─ BM25F rank      ├─ Skeleton      ├─ Create file
│ ├─ Fuzzy match     ├─ Fragment      ├─ Delete file
│ └─ 400 candidates  └─ AST analysis  └─ Transactions
│                                                 │
│ Token: 800-2K      Token: 200-5K    Token: 500-2K
│                                                 │
└─────────────────────────────────────────────────┘
```

This pipeline is optimized for:
- **Speed:** P50 latency <500ms
- **Accuracy:** Fuzzy matching with confidence scores
- **Safety:** ACID transactions with rollback
- **Token efficiency:** 95-98% savings via skeleton views

---

## 📖 How to Use This Documentation

### For New Agents
1. Start with [ARCHITECTURE.md](./ARCHITECTURE.md) - Understand the big picture
2. Read [AGENT_PLAYBOOK.md](./AGENT_PLAYBOOK.md) - Learn workflow patterns
3. Reference [TOOL_REFERENCE.md](./TOOL_REFERENCE.md) as needed

### For Quick Lookup
- **"How do I...?"** → [TOOL_REFERENCE.md](./TOOL_REFERENCE.md)
- **"What's the pattern?"** → [AGENT_PLAYBOOK.md](./AGENT_PLAYBOOK.md)
- **"Why does it work this way?"** → [ARCHITECTURE.md](./ARCHITECTURE.md)



---



---

## 📝 Key Concepts

**Scout:** Find relevant code using BM25F ranking + trigram indexing  
**Read:** Retrieve code in optimal format (skeleton, fragment, or full)  
**Edit:** Modify code safely with transactions and fuzzy matching  
**Confidence:** Match scoring (0.0-1.0) guides reliability of operations  
**Token Efficiency:** 95-98% reduction via skeleton views  
**Fallback Chain:** Multiple strategies for robust matching

---

## ✨ Features at a Glance

| Feature | Benefit | Reference |
|---------|---------|-----------|
| **Multi-level normalization** | Fuzzy matching despite formatting | [ARCHITECTURE.md](./ARCHITECTURE.md#6-level-normalization-hierarchy) |
| **Skeleton generation** | 97% token savings | [AGENT_PLAYBOOK.md](./AGENT_PLAYBOOK.md#token-efficiency-analysis) |

| **Confidence scoring** | Never silently fail | [ARCHITECTURE.md](./ARCHITECTURE.md) |

---



---


