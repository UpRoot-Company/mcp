# Agent Optimization Guide

**For:** AI agents, developers configuring agents, DevOps engineers  
**Level:** 🟡 Intermediate  
**Time:** 20-30 minutes

---

## Overview

Optimize Smart Context MCP for different AI models by:
1. Understanding model capabilities and limitations
2. Configuring environment variables appropriately
3. Selecting the right tools for each use case
4. Managing token budgets and performance

**Quick links:**
- **Tool selection?** → See [tool-conflicts.md](./tool-conflicts.md)
- **Permission setup?** → See [permissions.md](./permissions.md)
- **Environment variables?** → See [configuration.md](./configuration.md)
- **Prompting strategies?** → See [prompt-engineering.md](./prompt-engineering.md)

---

## 1. Agent Type Identification

### 🔵 Claude Family (Anthropic)

| Model | Context | Speed | Best For |
|-------|---------|-------|----------|
| **Sonnet 4.5** | 200K | Fast | Recommended default - balanced intelligence, speed, cost |
| **Opus 4.5** | 200K | Medium | Maximum intelligence for complex tasks |
| **Haiku 4.5** | 100K | Very Fast | Lightning-speed, cost-optimized |

**Characteristics:** State-of-the-art tool use, excellent code analysis, enhanced reasoning

### 🔷 Codex (OpenAI)

| Model | Context | Speed | Best For |
|-------|---------|-------|----------|
| **GPT-5.1-Codex** | 256K | Medium | Long-horizon agentic coding, extended thinking |

**Characteristics:** Specialized for autonomous coding, approval controls, sandbox modes

### 🟢 Gemini (Google)

| Model | Context | Speed | Best For |
|-------|---------|-------|----------|
| **Gemini 3 Pro** | 1M | Medium | Large projects, complex reasoning, bulk operations |
| **Gemini 2.0 Flash** | 1M | Very Fast | Quick operations, real-time analysis |

**Characteristics:** Largest context window, built-in shell tools, native MCP support

---

## 2. Model-Specific Configuration

### Environment Variables by Model

| Model | MAX_CACHE_SIZE | MAX_RESULTS | Strategy | Token Budget |
|-------|---------------|-------------|----------|-------------|
| **Haiku 4.5** | 50 | 15 | Maximize skeleton views, limit results | 80K |
| **Sonnet 4.5** | 100 | 50 | Mix skeleton + fragment, moderate limits | 180K |
| **Opus 4.5** | 200 | 100 | Flexible views, higher limits | 180K |
| **Codex** | 150 | 75 | Extended thinking, approval policies | 230K |
| **Gemini** | 200 | 150 | Leverage 1M context, bulk operations | 900K |

**Key strategies:**
- **Haiku:** Cost-optimized - skeleton views (95% savings), fragment reads, maxResults: 10-15, batch 10-15 files
- **Sonnet:** Balanced - mix views, maxResults: 50, batch 20-30 files (recommended default)
- **Opus:** Maximum intelligence - full views acceptable, maxResults: 100, batch 50+ files
- **Codex:** Agentic coding - extended thinking, sandbox modes, batch 30-50 files
- **Gemini:** Bulk operations - maxResults: 150-200, batch 100+ files, MCP + built-in tools

**Gemini Tool Systems:**
1. **MCP tools** (`includeTools`/`excludeTools`): navigate, read, understand, change, write, manage
2. **Built-in tools** (`tools.core`/`tools.exclude`): run_shell_command, read_file

**For complete environment variable reference:** See [configuration.md](./configuration.md)

---

## 3. Use-Case Templates

### Analysis-Only (Read-Only)

**Tools:** navigate, read, understand

**Workflow:**
```
1. navigate (find entry points)
2. read(skeleton) (structure)
3. understand (synthesis; enable include flags if needed)
4. read(fragment/full) (details)
```

**Permission:** Read-only tools only. See [permissions.md](./permissions.md#read-only-pattern)

---

### Auto-Fix (Automated Remediation)

**Tools:** navigate, read, change, manage + test commands

**Workflow:**
```
1. navigate (find problem)
2. read(skeleton) (understand context)
3. change(dryRun: true) (preview fix)
4. change(dryRun: false) (apply)
5. Run tests
6. manage undo (if tests fail)
```

**Permission:** Edit + test commands. See [permissions.md](./permissions.md#auto-fix-pattern)

---

### Performance-Optimized (Speed + Cost)

**Environment:**
```bash
SMART_CONTEXT_ENGINE_PROFILE=ci
SMART_CONTEXT_MAX_CACHE_SIZE=50
SMART_CONTEXT_MAX_RESULTS=10
SMART_CONTEXT_QUERY_TIMEOUT=15000
```

**Tool Priority:**
- ⚡⚡⚡ navigate, read(view="fragment"), read(view="skeleton")
- ⚡⚡ understand (only when needed)
- AVOID: deep `understand(include=...)` unless required

---

### Security-Hardened (Locked Down)

**Tools:** navigate, read, understand (read-only)

**Restrictions:**
- ✅ Code analysis only
- ❌ No code modification
- ❌ No external network
- ❌ No file creation

**Permission:** See [permissions.md](./permissions.md#security-hardened)

---

## 4. Multi-Agent Workflows

### Workflow 1: Planning + Execution

```
1. Opus: Analyze architecture and plan strategy
2. Opus: Design refactor approach
3. Haiku: Execute changes in phases
4. Opus: Verify and document
```

**Cost savings:** 60-70% vs using Opus for everything

---

### Workflow 2: Bulk + Quality

```
1. Gemini 3 Pro: Bulk search (1M context)
2. Gemini: Generate initial fixes
3. Opus: Quality review
4. Opus: Apply high-confidence fixes
```

**Use case:** Large-scale refactoring with quality assurance

---

## 5. Performance Benchmarks

Testing results from 10,000-file project:

### Search Performance (P95)

| Model | 20 results | 100 results | Filename |
|-------|-----------|-------------|----------|
| Haiku | 95ms | 200ms | 50ms |
| Sonnet | 100ms | 220ms | 50ms |
| Opus | 105ms | 240ms | 50ms |
| Codex | 120ms | 280ms | 60ms |
| Gemini 3 | 80ms | 160ms | 40ms |

### Read Performance (P95)

| Model | Skeleton (500KB) | Fragment (1K lines) | Full (50KB) |
|-------|----------------|-------------------|------------|
| Haiku | 80ms | 60ms | 120ms |
| Sonnet | 80ms | 60ms | 120ms |
| Opus | 80ms | 60ms | 120ms |
| Codex | 90ms | 70ms | 140ms |
| Gemini 3 | 65ms | 50ms | 100ms |

**Key insight:** Skeleton views save ~15,000 tokens per large file!

---

## 6. Tool Selection Guide

**Quick decision tree:**

```
What do you need?

├─ Find code/files → navigate
├─ Read structure → read(view="skeleton")
├─ Read specific lines → read(view="fragment")
├─ Relationships/impact → understand (enable include flags as needed)
├─ Make changes → change (use dryRun first)
├─ Undo mistake → manage undo
└─ Explore directory structure → Bash (ls/find)
```

**For detailed tool selection:** See [tool-conflicts.md](./tool-conflicts.md)

---

## 7. Token & Environment Management

### Token Budgets by Model

| Model | Hard Limit | Read-Heavy | Modify-Heavy | Analysis-Heavy |
|-------|-----------|-----------|--------------|----------------|
| Haiku | 100K | 30K | 20K | 15K |
| Sonnet | 200K | 80K | 60K | 50K |
| Opus | 200K | 150K | 100K | 100K |
| Codex | 256K | 100K | 80K | 80K |
| Gemini Pro | 1M | 400K | 300K | 300K |

**For token optimization techniques (skeleton views, fragment reads, etc.):** See [prompt-engineering.md](./prompt-engineering.md#token-optimization-techniques)  
**For environment variables:** See [configuration.md](./configuration.md)

---

## 8. Monitoring & Common Patterns

### Expected Latency (P95)

| Tool | Target | Acceptable | Slow |
|------|--------|-----------|------|
| navigate | 300ms | <1000ms | >2000ms |
| read | 300ms | <1000ms | >2000ms |
| understand | 800ms | <3000ms | >5000ms |
| change | 500ms | <2000ms | >5000ms |

### Common Patterns

**Pattern 1: Safe Single-File Edit**
```
1. navigate (find file)
2. read(skeleton) (understand structure)
3. read(fragment) (get exact location)
4. change(dryRun: true) (preview)
5. change(dryRun: false) (apply)

Token cost: ~2,000
```

**Pattern 2: Bulk Refactoring (50+ files)**
```
1. navigate (find entry points + usages)
2. change(dryRun: true) with clear intent + constraints (e.g., targetFiles)
3. Split into batches if the dry-run diff is too large
4. change(dryRun: false) to apply
5. manage undo if needed

Token cost: ~15,000-25,000
```

**Pattern 3: Architecture Analysis**
```
1. navigate (entry point)
2. read(skeleton) (overview)
3. understand(include=...) (relationships/impact as needed)
4. read(fragment) (details)

Token cost: ~8,000-15,000
```

---

## 9. Quick Start Configuration

### Cost-Optimized (Haiku)
```json
{
  "model": "claude-haiku-4-5-20251001",
  "env": { "SMART_CONTEXT_MAX_CACHE_SIZE": "50", "SMART_CONTEXT_MAX_RESULTS": "10" }
}
```

### Balanced (Sonnet - Recommended)
```json
{
  "model": "claude-sonnet-4-5-20251022",
  "env": { "SMART_CONTEXT_MAX_CACHE_SIZE": "100", "SMART_CONTEXT_MAX_RESULTS": "50" }
}
```

### Maximum Intelligence (Opus)
```json
{
  "model": "claude-opus-4-5-20251101",
  "env": { "SMART_CONTEXT_MAX_CACHE_SIZE": "200", "SMART_CONTEXT_MAX_RESULTS": "100" }
}
```

### Agentic (Codex)
```json
{
  "model": "gpt-5.1-codex-max",
  "env": { "SMART_CONTEXT_MAX_CACHE_SIZE": "150", "SMART_CONTEXT_MAX_RESULTS": "75" }
}
```

### Bulk Operations (Gemini)
```json
{
  "model": "gemini-3-pro",
  "env": { "SMART_CONTEXT_MAX_CACHE_SIZE": "200", "SMART_CONTEXT_MAX_RESULTS": "150" }
}
```

---

## References

- **Tool selection decisions:** [tool-conflicts.md](./tool-conflicts.md)
- **Security & permissions:** [permissions.md](./permissions.md)
- **Environment variables:** [configuration.md](./configuration.md)
- **Effective prompting:** [prompt-engineering.md](./prompt-engineering.md)
- **Tool API reference:** [TOOL_REFERENCE.md](../agent/TOOL_REFERENCE.md)

---

**Version:** 1.0.0  
**Last Updated:** 2025-12-15  
**Maintained by:** Smart Context MCP Team
