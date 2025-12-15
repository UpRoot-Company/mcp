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
1. **MCP tools** (`includeTools`/`excludeTools`): search_project, read_code, edit_code
2. **Built-in tools** (`tools.core`/`tools.exclude`): run_shell_command, read_file

**For complete environment variable reference:** See [configuration.md](./configuration.md)

---

## 3. Use-Case Templates

### Analysis-Only (Read-Only)

**Tools:** search_project, read_code, analyze_relationship, analyze_file

**Workflow:**
```
1. analyze_file (get profile)
2. search_project (find patterns)
3. analyze_relationship (understand impact)
4. read_code (detailed examination)
```

**Permission:** Read-only tools only. See [permissions.md](./permissions.md#read-only-pattern)

---

### Auto-Fix (Automated Remediation)

**Tools:** search_project, read_code, edit_code, manage_project + test commands

**Workflow:**
```
1. search_project (find problem)
2. read_code(skeleton) (understand context)
3. edit_code(dryRun: true) (preview fix)
4. edit_code(final) (apply)
5. Run tests
6. manage_project undo (if tests fail)
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
- ⚡⚡⚡ search_project, read_fragment, list_directory
- ⚡⚡ analyze_file
- AVOID: analyze_relationship, get_batch_guidance

---

### Security-Hardened (Locked Down)

**Tools:** search_project, read_code, analyze_relationship (read-only)

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

├─ Find code/files → search_project
├─ Understand file → read_code(skeleton) or analyze_file
├─ Specific lines → read_fragment
├─ Relationships → analyze_relationship
├─ Make changes → edit_code (use dryRun first)
├─ Undo mistake → manage_project undo
└─ Explore structure → list_directory
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
| search_project | 300ms | <1000ms | >2000ms |
| read_code | 300ms | <1000ms | >2000ms |
| read_fragment | 100ms | <500ms | >1000ms |
| edit_code | 500ms | <2000ms | >5000ms |
| analyze_relationship | 800ms | <3000ms | >5000ms |

### Common Patterns

**Pattern 1: Safe Single-File Edit**
```
1. search_project (find file)
2. read_code(skeleton) (understand structure)
3. read_fragment (get exact location)
4. edit_code(dryRun: true) (preview)
5. edit_code(final) (apply)

Token cost: ~2,000
```

**Pattern 2: Bulk Refactoring (50+ files)**
```
1. search_project(maxResults: 100)
2. get_batch_guidance (clustering)
3. For each cluster:
   - read_code(skeleton)
   - edit_code(dryRun)
   - edit_code(final)

Token cost: ~15,000-25,000
```

**Pattern 3: Architecture Analysis**
```
1. analyze_file (entry point)
2. analyze_relationship (impact, maxDepth: 5)
3. search_project (patterns)
4. read_code (multiple files, skeleton)

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
