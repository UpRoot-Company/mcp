# Advanced Tool Tuning & Optimization Guide

**For:** Advanced users, DevOps engineers, and platform teams building AI-powered automation

**Level:** 🔴 Advanced (requires familiarity with agent-optimization.md, permissions.md, and TOOL_REFERENCE.md)

**Time:** 30-45 minutes to understand; 1-2 hours to implement custom configuration

---

## Overview

Smart Context MCP provides 11 core tools with extensive configuration options. This guide shows how to:

1. **Select and configure tools** for specific LLM models
2. **Combine environment variables** with permission rules for optimal performance
3. **Build use-case-specific configurations** (analysis-only, auto-fix, performance-focused, security-hardened)
4. **Optimize token usage** and latency by model and use case
5. **Implement monitoring** and fallback strategies

---

## Part 1: Understanding the Tool Landscape

### 11 Core Tools & Characteristics

| Tool | Category | Token Cost | Speed | Safety | Best For |
|------|----------|-----------|-------|--------|----------|
| **search_project** | Discovery | 800-2000 | ⚡⚡⚡ Fast | 🟢 Safe | Finding code/files |
| **read_code** | Analysis | 250-15000 | ⚡⚡ Medium | 🟢 Safe | Understanding structure |
| **read_fragment** | Analysis | 100-1000 | ⚡⚡⚡ Fast | 🟢 Safe | Specific line ranges |
| **analyze_relationship** | Analysis | 1000-4000 | ⚡⚡ Medium | 🟢 Safe | Impact analysis |
| **analyze_file** | Analysis | 300-1200 | ⚡⚡⚡ Fast | 🟢 Safe | File profiling |
| **get_batch_guidance** | Planning | 400-1500 | ⚡⚡ Medium | 🟢 Safe | Multi-file planning |
| **edit_code** | Modification | 500-10000 | ⚡ Slow | 🟢🟢 Very Safe | Code changes |
| **write_file** | Modification | 200-5000 | ⚡ Slow | 🟡 Moderate | File creation |
| **list_directory** | Discovery | 200-500 | ⚡⚡⚡ Fast | 🟢 Safe | Directory exploration |
| **read_file** | Analysis | 100-15000 | ⚡⚡ Medium | 🟢 Safe | General file reading |
| **manage_project** | Meta | 50-200 | ⚡⚡⚡ Fast | 🟢 Safe | Undo/redo/status |

### Tool Permission Groups (for permissions.md)

```json
{
  "readOnly": [
    "search_project",
    "read_code",
    "read_fragment",
    "read_file",
    "list_directory",
    "analyze_file",
    "analyze_relationship"
  ],
  "planning": [
    "get_batch_guidance"
  ],
  "modification": [
    "edit_code",
    "write_file"
  ],
  "meta": [
    "manage_project"
  ]
}
```

---

## Part 2: Model-Specific Tool Strategies

### 🟢 Claude Haiku 4.5
**Profile:** Lightning-fast, cost-optimized (100K context)

**Environment Variables:**
```bash
SMART_CONTEXT_ENGINE_PROFILE=production
SMART_CONTEXT_MAX_CACHE_SIZE=50
SMART_CONTEXT_SYMBOL_CACHE_SIZE=20
SMART_CONTEXT_QUERY_TIMEOUT=20000
SMART_CONTEXT_MAX_RESULTS=15
```

**Optimal Tool Stack:**
```
Priority 1: search_project, read_code(skeleton), read_fragment
Priority 2: edit_code, analyze_file, list_directory
Avoid: analyze_relationship, get_batch_guidance, write_file
```

**Token Budget:** Max 80K per operation

**Use Case:** Single function fixes, quick searches, cost-optimized automation

---

### 🟡 Claude Sonnet 4.5
**Profile:** Balanced, recommended default (200K context)

**Environment Variables:**
```bash
SMART_CONTEXT_ENGINE_PROFILE=production
SMART_CONTEXT_MAX_CACHE_SIZE=100
SMART_CONTEXT_SYMBOL_CACHE_SIZE=50
SMART_CONTEXT_QUERY_TIMEOUT=30000
SMART_CONTEXT_MAX_RESULTS=50
```

**Optimal Tool Stack:**
```
All tools available - use selectively
- Use analyze_relationship for complex refactoring
- Use get_batch_guidance for multi-file changes
- Mix skeleton and full views efficiently
```

**Token Budget:** Max 180K per operation

**Use Case:** General development, refactoring, analysis

---

### 🔴 Claude Opus 4.5
**Profile:** Maximum intelligence (200K context)

**Environment Variables:**
```bash
SMART_CONTEXT_ENGINE_PROFILE=production
SMART_CONTEXT_MAX_CACHE_SIZE=200
SMART_CONTEXT_SYMBOL_CACHE_SIZE=150
SMART_CONTEXT_QUERY_TIMEOUT=45000
SMART_CONTEXT_MAX_RESULTS=100
```

**Optimal Tool Stack:**
```
All tools - leverage maximum capabilities
- Deep analysis with maxDepth: 7
- Full code reads for comprehensive context
- Complex architectural decisions
```

**Token Budget:** Max 180K per operation (still respects budget)

**Use Case:** Large architectural changes, comprehensive analysis, complex refactoring

---

### 🔵 Codex (OpenAI GPT-5.1-Codex)
**Profile:** Agentic coding, extended thinking (256K context)

**Environment Variables:**
```bash
SMART_CONTEXT_ENGINE_PROFILE=production
SMART_CONTEXT_MAX_CACHE_SIZE=150
SMART_CONTEXT_QUERY_TIMEOUT=40000
SMART_CONTEXT_MAX_RESULTS=75
```

**Optimal Tool Stack:**
```
- search_project, read_code, edit_code (core)
- Analyze changes carefully with read_fragment
- Use extended thinking for planning
- Explicit tool sequencing (no inference)
```

**Token Budget:** Max 230K per operation

**Use Case:** Autonomous code generation, long-horizon agentic tasks

---

### 🟢 Gemini 3 Pro
**Profile:** Massive context (1M tokens), advanced reasoning

**Environment Variables:**
```bash
SMART_CONTEXT_ENGINE_PROFILE=production
SMART_CONTEXT_MAX_CACHE_SIZE=500
SMART_CONTEXT_SYMBOL_CACHE_SIZE=200
SMART_CONTEXT_QUERY_TIMEOUT=60000
SMART_CONTEXT_MAX_RESULTS=200
```

**Optimal Tool Stack:**
```
- Bulk operations: search_project({ maxResults: 200 })
- Deep analysis: analyze_relationship({ maxDepth: 10 })
- Large batch edits in single operation
- Full file reads acceptable
```

**Token Budget:** Max 900K per operation (leverage 1M context)

**Use Case:** Massive refactoring, project-wide analysis, bulk operations

---

### 🟡 Gemini 2.0 Flash
**Profile:** Speed + context (1M tokens)

**Environment Variables:**
```bash
SMART_CONTEXT_ENGINE_PROFILE=ci
SMART_CONTEXT_MAX_CACHE_SIZE=200
SMART_CONTEXT_QUERY_TIMEOUT=20000
SMART_CONTEXT_MAX_RESULTS=100
```

**Optimal Tool Stack:**
```
Priority 1: search_project, read_fragment, edit_code
Avoid: analyze_relationship, get_batch_guidance (slower)
Speed-focused: Multiple quick calls beat one deep analysis
```

**Token Budget:** Max 800K per operation (real-time preference)

**Use Case:** Real-time fixes, rapid iteration, speed-critical automation

---

## Part 3: Use-Case-Specific Configurations

### Use Case 1: Analysis-Only (Read-Only)

**Permission Config:**
```json
{
  "permissions": {
    "allow": [
      "mcp__smart-context-mcp__search_project",
      "mcp__smart-context-mcp__read_code",
      "mcp__smart-context-mcp__analyze_relationship",
      "mcp__smart-context-mcp__analyze_file"
    ],
    "deny": [
      "mcp__smart-context-mcp__edit_code",
      "mcp__smart-context-mcp__write_file"
    ]
  }
}
```

**Recommended Tool Sequence:**
```
1. analyze_file (comprehensive profile)
2. search_project (find patterns)
3. analyze_relationship (understand impact)
4. read_code (detailed examination)
```

---

### Use Case 2: Auto-Fix (Automated Remediation)

**Permission Config:**
```json
{
  "permissions": {
    "allow": [
      "Bash(npm test:*)",
      "Bash(npm run build:*)",
      "mcp__smart-context-mcp__search_project",
      "mcp__smart-context-mcp__read_code",
      "mcp__smart-context-mcp__edit_code",
      "mcp__smart-context-mcp__manage_project"
    ],
    "deny": [
      "Bash(rm:*)",
      "mcp__smart-context-mcp__write_file"
    ]
  }
}
```

**Workflow:**
```
1. search_project (find problem pattern)
2. read_code(skeleton) (understand structure)
3. edit_code(dryRun: true) (preview fix)
4. edit_code(final) (apply fix)
5. Test (verify fix)
6. manage_project undo (if test fails)
```

---

### Use Case 3: Performance-Optimized (Speed + Cost)

**Environment Config:**
```bash
SMART_CONTEXT_ENGINE_PROFILE=ci
SMART_CONTEXT_MAX_CACHE_SIZE=50
SMART_CONTEXT_QUERY_TIMEOUT=15000
SMART_CONTEXT_MAX_RESULTS=10
```

**Tool Priority:**
```
1. ⚡⚡⚡ search_project (fast, ~200ms)
2. ⚡⚡⚡ read_fragment (fast, ~100ms)
3. ⚡⚡ analyze_file (medium, ~400ms)
AVOID: analyze_relationship, get_batch_guidance
```

---

### Use Case 4: Security-Hardened (Locked Down)

**Permission Config:**
```json
{
  "permissions": {
    "allow": [
      "mcp__smart-context-mcp__search_project",
      "mcp__smart-context-mcp__read_code",
      "mcp__smart-context-mcp__analyze_relationship"
    ],
    "deny": [
      "mcp__smart-context-mcp__edit_code",
      "mcp__smart-context-mcp__write_file",
      "Bash(curl:*)",
      "Bash(wget:*)"
    ]
  }
}
```

**Restrictions:**
```
✅ Code analysis only (read-only)
❌ No code modification
❌ No external network access
❌ No file creation/deletion
```

---

## Part 4: Advanced Configuration Templates

### Template 1: CI/CD Auto-Fix (TypeScript Project)

```json
{
  "mcpServers": {
    "smart-context": {
      "command": "npx",
      "args": ["-y", "smart-context-mcp"],
      "env": {
        "SMART_CONTEXT_ENGINE_PROFILE": "ci",
        "SMART_CONTEXT_MAX_CACHE_SIZE": "75",
        "SMART_CONTEXT_QUERY_TIMEOUT": "25000",
        "SMART_CONTEXT_MAX_RESULTS": "20"
      }
    }
  },
  "permissions": {
    "allow": [
      "Bash(git:*)",
      "Bash(npm run lint:*)",
      "Bash(npm run test:*)",
      "mcp__smart-context-mcp__search_project",
      "mcp__smart-context-mcp__read_code",
      "mcp__smart-context-mcp__edit_code",
      "mcp__smart-context-mcp__analyze_file"
    ],
    "deny": ["Bash(rm:*)", "mcp__smart-context-mcp__write_file"]
  }
}
```

### Template 2: Code Review Agent (Gemini Pro)

```json
{
  "mcpServers": {
    "smart-context": {
      "command": "npx",
      "args": ["-y", "smart-context-mcp"],
      "includeTools": [
        "search_project",
        "read_code",
        "analyze_relationship",
        "analyze_file",
        "get_batch_guidance"
      ]
    }
  },
  "tools": {
    "core": ["run_shell_command(git)"]
  }
}
```

### Template 3: Performance-Critical (Gemini Flash)

```json
{
  "mcpServers": {
    "smart-context": {
      "command": "npx",
      "args": ["-y", "smart-context-mcp"],
      "env": {
        "SMART_CONTEXT_ENGINE_PROFILE": "ci",
        "SMART_CONTEXT_MAX_CACHE_SIZE": "200",
        "SMART_CONTEXT_QUERY_TIMEOUT": "15000",
        "SMART_CONTEXT_MAX_RESULTS": "50"
      },
      "includeTools": [
        "search_project",
        "read_code",
        "read_fragment",
        "edit_code"
      ],
      "excludeTools": [
        "analyze_relationship",
        "get_batch_guidance"
      ]
    }
  }
}
```

---

## Part 5: Token & Latency Optimization

### Token Budget per Operation (Recommended)

| Model | Budget | Read-Heavy | Modify-Heavy | Analysis-Heavy |
|-------|--------|-----------|--------------|----------------|
| **Haiku** | 100K | 30K | 20K | 15K |
| **Sonnet** | 200K | 80K | 60K | 50K |
| **Opus** | 200K | 150K | 100K | 100K |
| **Codex** | 256K | 100K | 80K | 80K |
| **Gemini Pro** | 1M | 400K | 300K | 300K |
| **Gemini Flash** | 1M | 300K | 250K | 200K |

### Latency Guidelines (P95)

| Tool | Target (ms) | Acceptable | Slow |
|------|-----------|-----------|------|
| search_project | 300 | <1000 | >2000 |
| read_code | 300 | <1000 | >2000 |
| read_fragment | 100 | <500 | >1000 |
| edit_code | 500 | <2000 | >5000 |
| analyze_relationship | 800 | <3000 | >5000 |
| analyze_file | 400 | <1000 | >3000 |
| get_batch_guidance | 800 | <2000 | >3000 |

---

## Part 6: Tool Selection Decision Tree

```
What do you need to do?

├─ Find code/files?
│  └─ search_project (primary)
│
├─ Understand a file?
│  ├─ Quick overview → analyze_file (~300 tokens)
│  ├─ Structure only → read_code(skeleton) (~400 tokens)
│  └─ Specific lines → read_fragment (~200 tokens)
│
├─ Understand relationships?
│  └─ analyze_relationship (depth depends on scope)
│
├─ Make changes?
│  ├─ Single file → edit_code(dryRun: true first)
│  ├─ Multiple files → get_batch_guidance first
│  └─ New file → write_file (use edit_code for code)
│
├─ Recover from mistake?
│  └─ manage_project undo
│
└─ Explore structure?
   └─ list_directory
```

---

## Part 7: Monitoring & Debugging

### Check Operation Tokens (Estimates)

```javascript
const tokenCosts = {
  search_project: 800,
  read_code_skeleton: 400,
  read_code_full: 5000,
  read_fragment: 200,
  analyze_relationship: 2500,
  analyze_file: 600,
  edit_code: 1000,
  get_batch_guidance: 1200,
  manage_project: 100
};
```

### Latency Expectations

**Fast (<500ms):**
- read_fragment
- list_directory
- manage_project
- search_project (small results)

**Medium (500-1500ms):**
- read_code (skeleton)
- analyze_file
- search_project (large results)

**Slow (>1500ms):**
- read_code (full)
- analyze_relationship
- get_batch_guidance
- edit_code (batch)

---

## Part 8: Common Patterns

### Pattern 1: Safe Single-File Edit

```
1. search_project (find file)
2. read_code(skeleton) (understand structure)
3. read_fragment(line range) (get exact location)
4. edit_code(dryRun: true) (preview)
5. edit_code(final) (apply)
Token cost: ~2000
```

### Pattern 2: Bulk Refactoring (50+ files)

```
1. search_project(query, maxResults: 100)
2. get_batch_guidance(clustering)
3. For each cluster:
   - read_code(skeleton)
   - edit_code(dryRun)
   - edit_code(final)
   - manage_project(status)
Token cost: ~15000-25000
```

### Pattern 3: Architecture Analysis

```
1. analyze_file(entry point)
2. analyze_relationship(impact, maxDepth: 5)
3. search_project(patterns)
4. read_code(multiple files, skeleton)
5. Generate report
Token cost: ~8000-15000
```

---

## Further Reading

- [Agent Optimization Guide](./agent-optimization.md) - Model selection
- [Tool Conflict Resolution](./tool-conflicts.md) - Bash vs smart-context
- [Permissions Configuration](./permissions.md) - Security setup
- [TOOL_REFERENCE.md](../agent/TOOL_REFERENCE.md) - Complete tool documentation
- [Prompt Engineering](./prompt-engineering.md) - Effective prompting

---

**Version:** 1.0.0
**Last Updated:** 2025-12-15
**Audience:** Advanced users, platform engineers, DevOps teams
