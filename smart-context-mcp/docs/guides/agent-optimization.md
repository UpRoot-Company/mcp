# Agent-Specific Optimization Guide

This guide helps you optimize Smart Context MCP for different AI agent types and language models, ensuring maximum performance and token efficiency.

---

## 1. Agent Type Identification

Smart Context performs differently based on the AI model's capabilities:

### 🔵 Claude Family (Anthropic)

| Model | Context | Speed | Best For |
|-------|---------|-------|----------|
| **Claude Sonnet 4.5** | 200K tokens | Fast | Recommended default - complex agents, coding, most tasks |
| **Claude Opus 4.5** | 200K tokens | Medium | Maximum intelligence for complex specialized tasks |
| **Claude Haiku 4.5** | 100K tokens | Very Fast | Lightning-speed, most cost-efficient, with reasoning |

**Characteristics:**
- State-of-the-art tool use and multi-turn reasoning
- Excellent code analysis and edge-case handling  
- Claude 4.5 models: Enhanced reasoning and extended thinking

### 🔷 Codex (OpenAI - Agentic Coding)

| Model | Context | Speed | Best For |
|-------|---------|-------|----------|
| **GPT-5.1-Codex-Max** | 256K tokens | Medium | Long-horizon agentic coding (recommended) |
| **GPT-5.1-Codex-Mini** | 256K tokens | Fast | Cost-effective agentic tasks |

**Characteristics:**
- Specialized for agentic coding and reasoning
- Extended thinking for deep analysis
- Agents.md for project instructions
- Sandbox and approval controls

### 🟢 Google Gemini (Terminal Agent)

| Model | Context | Speed | Best For |
|-------|---------|-------|----------|
| **Gemini 3 Pro** | 1M tokens | Medium | Large projects, complex reasoning, bulk operations |
| **Gemini 2.0 Flash** | 1M tokens | Very Fast | Quick operations, prototyping, real-time analysis |

**Characteristics:**
- Largest context window (1M tokens)
- Built-in tools: shell commands, file system, web, memory, todos
- Native MCP support with `includeTools` / `excludeTools` control
- No IDE dependency - terminal-based agent

---

## 2. Tool Conflict Resolution

One of the most critical optimization decisions: **when to use which tool**.

### Decision Matrix

| Task | Bash Command | Smart Context Tool | Recommendation | Why |
|------|-------------|-------------------|----------------|-----|
| Find files by name | `find . -name "*.ts"` | `search_project(type="filename")` | ✅ Use smart-context | Trigram index is 40x faster |
| Search for symbol | `grep -r "function"` | `search_project(type="symbol")` | ✅ Use smart-context | BM25F ranking, fuzzy matching |
| Read file content | `cat file.ts` | `read_code(view="full")` | 🟡 Bash for non-code, smart-context for code | skeleton saves 95% tokens |
| Edit file | `sed -i 's/old/new/' file` | `edit_code()` | ✅ Use smart-context | Transaction safety, rollback |
| List directory | `ls -la` | `list_directory()` | 🟡 Bash is fine for quick checks | Both work, Bash is simpler |
| Complex search with transforms | `find . \| xargs grep \| awk` | `search_project()` | ✅ Use smart-context | Single command, ranked results |
| Git operations | `git status`, `git log` | N/A | ✅ Use Bash | No alternative, essential |
| Run tests | `npm test`, `pytest` | N/A | ✅ Use Bash | No alternative, essential |

---

## 3. LLM-Specific Configuration Recipes

### 🟢 Claude Haiku 4.5 (Fast, Cost-Efficient)

**Profile:** Lightning-fast with reasoning capability, most cost-efficient, best for rapid iterations

**Configuration:**
```json
{
  "env": {
    "SMART_CONTEXT_MAX_CACHE_SIZE": "50",
    "SMART_CONTEXT_ENGINE_PROFILE": "production"
  }
}
```

**Optimization strategies:**
- Maximize skeleton views (95%+ token savings)
- Fragment reads with explicit line ranges
- Lower search result limits (maxResults: 10)
- Batch-aware edits (max 10 files per dryRun)
- Explicit sequencing in prompts

**Use case:** Smaller projects (< 5,000 files), quick fixes, cost-sensitive operations

---

### 🟡 Claude Sonnet 4.5 (Recommended Default)

**Profile:** Best balance of intelligence, speed, and cost

**Configuration:**
```json
{
  "env": {
    "SMART_CONTEXT_MAX_CACHE_SIZE": "100",
    "SMART_CONTEXT_ENGINE_PROFILE": "production"
  }
}
```

**Optimization strategies:**
- Mixed view approach (skeleton + fragments)
- Moderate search limits (maxResults: 50)
- Reasonable batch sizes (20-30 files)
- Standard multi-turn workflow

**Use case:** Most development tasks, the default choice

---

### 🔴 Claude Opus 4.5 (Maximum Intelligence)

**Profile:** Highest intelligence for complex specialized tasks, architectural decisions

**Configuration:**
```json
{
  "env": {
    "SMART_CONTEXT_MAX_CACHE_SIZE": "200",
    "SMART_CONTEXT_ENGINE_PROFILE": "production"
  }
}
```

**Optimization strategies:**
- Flexible view usage (can use full views liberally)
- Higher search result limits (maxResults: 100)
- Large batch operations (50+ file edits)
- Complex multi-file analysis with full impact analysis

**Use case:** Large projects, critical refactors, architectural changes

---

### 🔷 Codex (OpenAI - Agentic Coding)

**Profile:** Specialized for long-horizon agentic coding with extended thinking

**Configuration:**
```json
{
  "env": {
    "SMART_CONTEXT_MAX_CACHE_SIZE": "150",
    "SMART_CONTEXT_ENGINE_PROFILE": "production"
  }
}
```

**Optimization strategies:**
- Extended thinking for deep analysis
- Use approval policies for safe autonomous execution
- Batch processing (30-50 files per batch)
- Leverage sandbox modes for workspace control

**Use case:** Long-horizon agentic tasks, autonomous code generation

---

### 🟢 Gemini CLI (Google - Bulk Operations)

**Profile:** Massive context (1M tokens), excellent for large-scale analysis

**Configuration:**
```json
{
  "env": {
    "SMART_CONTEXT_MAX_CACHE_SIZE": "200",
    "SMART_CONTEXT_ENGINE_PROFILE": "production"
  }
}
```

**Tool System:**

Gemini CLI has TWO separate tool systems:
1. **Smart Context MCP tools** (controlled by `includeTools` / `excludeTools`)
   - `search_project`, `read_code`, `edit_code`, `analyze_relationship`, etc.
2. **Gemini built-in tools** (controlled by `tools.core` / `tools.exclude`)
   - `run_shell_command`: Execute shell commands
   - `read_file`, `write_file`, `list_files`: File system operations
   - `web_fetch`, `google_web_search`: Web access
   - `save_memory`, `write_todos`: Session management

**MCP Configuration:**
```json
{
  "mcpServers": {
    "smart-context": {
      "command": "npx",
      "args": ["-y", "smart-context-mcp"],
      "includeTools": [
        "search_project",
        "read_code",
        "edit_code",
        "analyze_relationship",
        "analyze_file"
      ]
    }
  }
}
```

**Shell Command Control:**
```json
{
  "tools": {
    "core": [
      "run_shell_command(git)",
      "run_shell_command(npm)",
      "run_shell_command(node)"
    ],
    "exclude": [
      "run_shell_command(rm)",
      "run_shell_command(curl)",
      "run_shell_command(eval)"
    ]
  }
}
```

**Optimization strategies:**
- Leverage massive 1M context window
- High search result limits (maxResults: 150)
- Bulk processing (100+ file edits in single batch)
- Deep analysis patterns for architectural decisions
- Use both MCP and built-in tools strategically

**Use case:** Large-scale refactoring, architectural analysis, bulk operations

---

## 4. Performance Benchmarks by Agent Type

Results from testing with a 10,000-file project:

### Search Performance

| Operation | Haiku | Sonnet | Opus | Codex | Gemini 3 |
|-----------|-------|--------|------|-------|----------|
| `search_project(symbol)` 20 results | 95ms | 100ms | 105ms | 120ms | 80ms |
| `search_project(symbol)` 100 results | 200ms | 220ms | 240ms | 280ms | 160ms |
| `search_project(filename)` | 50ms | 50ms | 50ms | 60ms | 40ms |

### Read Performance

| Operation | Haiku | Sonnet | Opus | Codex | Gemini 3 |
|-----------|-------|--------|------|-------|----------|
| `read_code(skeleton)` 500KB file | 80ms | 80ms | 80ms | 90ms | 65ms |
| `read_code(fragment)` 1000 lines | 60ms | 60ms | 60ms | 70ms | 50ms |
| `read_code(full)` 50KB file | 120ms | 120ms | 120ms | 140ms | 100ms |

### Edit Performance

| Operation | Haiku | Sonnet | Opus | Codex | Gemini 3 |
|-----------|-------|--------|------|-------|----------|
| Single file edit | 150ms | 150ms | 150ms | 170ms | 130ms |
| 10-file batch (dryRun) | 400ms | 400ms | 400ms | 450ms | 320ms |
| 50-file batch (dryRun) | 1200ms | 1200ms | 1200ms | 1400ms | 900ms |

**Key insight:** Use `view="skeleton"` saves 15,000 tokens per large file!

---

## 5. Multi-Agent Workflows

### Workflow 1: Opus for Planning, Haiku for Execution
```
1. Opus: Analyze architecture
2. Opus: Plan refactor strategy
3. Haiku: Execute Phase 1-3
4. Opus: Verify and document
```

### Workflow 2: Gemini for Bulk, Claude for Quality
```
1. Gemini 3 Pro: Bulk search across 1M tokens
2. Gemini: Generate fixes
3. Claude Opus: Quality review
4. Claude Opus: Apply high-confidence fixes
```

---

## 6. Token Budget Management

Hard limits by agent:
```
Claude Haiku:     100,000 tokens
Claude Sonnet:    200,000 tokens
Claude Opus:      200,000 tokens
Codex:            256,000 tokens
Gemini:           1,000,000 tokens
```

Graceful degradation:
- Reduce search results: `maxResults: 10` (was 50)
- Use skeletons only: `view: "skeleton"`
- Batch smaller edits: Edit 5 files instead of 20
- Request summaries instead of detailed analysis

---

## 7. Context Window Optimization

### 100K Context (Claude Haiku, Sonnet)
- Max operations: 20-50
- Search (50 results)
- Read mixture (skeleton + fragments)
- Edit (20-30 files per batch)

### 200K Context (Claude Opus)
- Max operations: 50-100+
- Search (100 results)
- Read (full files, multiple at once)
- Edit (50-100 file batches)

### 256K Context (Codex)
- Max operations: 60-120
- Search (100 results)
- Read (skeleton + fragments)
- Edit (30-50 files with approval policies)

### 1M Context (Gemini)
- Max operations: Unlimited
- Read entire projects
- Batch edit thousands of files
- Complex multi-file analysis

---

## 8. Tool Permission Optimization by Agent Type

Different agents have different permission models.

### 🔵 Claude Code (Anthropic CLI)

**Configuration:** `.claude/settings.json`

**Development:**
```json
{
  "permissions": {
    "allow": [
      "Bash(git:*)",
      "Bash(npm:*)",
      "mcp__smart-context-mcp__*"
    ],
    "deny": ["Bash(rm:*)", "Bash(curl:*)", "Bash(wget:*)"]
  }
}
```

**Production:**
```json
{
  "permissions": {
    "allow": [
      "Bash(npm test:*)",
      "Bash(npm run build:*)",
      "mcp__smart-context-mcp__search_project",
      "mcp__smart-context-mcp__read_code",
      "mcp__smart-context-mcp__edit_code"
    ]
  }
}
```

---

### 🔷 Codex (OpenAI)

**Configuration:** `~/.codex/config.toml`

**Development:**
```toml
[mcp.servers.smart-context.permissions]
approval_policy = "on-request"
sandbox_mode = "workspace-write"

[mcp.servers.smart-context.excludeTools]
tools = ["Bash(rm:*)", "Bash(eval:*)", "Bash(curl:*)"]
```

**Autonomous:**
```toml
[mcp.servers.smart-context.permissions]
approval_policy = "never"
sandbox_mode = "workspace-write"
```

---

### 💚 Gemini CLI (Google)

**Configuration:** `~/.gemini/settings.json`

**Development (MCP + Shell):**
```json
{
  "mcpServers": {
    "smart-context": {
      "command": "npx",
      "args": ["-y", "smart-context-mcp"],
      "includeTools": [
        "search_project",
        "read_code",
        "edit_code",
        "analyze_relationship"
      ]
    }
  },
  "tools": {
    "core": [
      "run_shell_command(git)",
      "run_shell_command(npm)",
      "run_shell_command(node)"
    ],
    "exclude": [
      "run_shell_command(rm)",
      "run_shell_command(curl)"
    ]
  }
}
```

**Analysis Only (Read-Only):**
```json
{
  "mcpServers": {
    "smart-context": {
      "command": "npx",
      "args": ["-y", "smart-context-mcp"],
      "includeTools": [
        "search_project",
        "read_code",
        "analyze_relationship"
      ],
      "excludeTools": ["edit_code"]
    }
  },
  "tools": {
    "exclude": ["run_shell_command"]
  }
}
```

**Key Points:**
- `includeTools` / `excludeTools` control Smart Context MCP tools
- `tools.core` / `tools.exclude` control Gemini's built-in shell commands
- Command restriction via string matching is NOT a security boundary
- For security, use explicit `core` allowlist only

---

### 📋 Others (GitHub Copilot, Cursor, CI/CD)

**GitHub Copilot & Cursor:**
- Use `.claude/settings.json` (same as Claude Code)
- Safe Development pattern

**CI/CD:**
```json
{
  "permissions": {
    "allow": [
      "Bash(npm test:*)",
      "Bash(npm run build:*)",
      "mcp__smart-context-mcp__search_project",
      "mcp__smart-context-mcp__read_code",
      "mcp__smart-context-mcp__edit_code"
    ]
  }
}
```

---

## 9. Permission Summary & Recommendations

**Speed Impact:**
- Restrictive (maximum approval): -30% speed
- Safe development: -5% speed
- Autonomous (no approval): +0% speed

**By Context:**
- **Local Development:** Safe Development pattern
- **CI/CD Automation:** Restrictive pattern
- **Production Agents:** Restrictive + approval_policy
- **Untrusted Code:** Maximum restrictions

**Tool Exclusion Best Practices:**

Always exclude:
```
Bash(rm:*)        → File deletion
Bash(eval:*)      → Code execution
Bash(exec:*)      → Process replacement
Bash(sudo:*)      → Privilege escalation
```

Usually safe:
```
Bash(git:*)                    → Version control
Bash(npm:*)                    → Package management
mcp__smart-context-mcp__*      → All smart-context tools (sandboxed)
```

---

## 10. Prompt Engineering Tips by Agent Type

### For Haiku
```
"Search for X, then read skeleton, then edit."
(Be explicit, no inference)
```

### For Sonnet
```
"Find all occurrences of X. Show me the most relevant one in skeleton view. 
Then propose edits with dryRun."
(Natural flow, inference expected)
```

### For Opus
```
"Comprehensively analyze X. Consider edge cases. Propose the highest-quality solution."
(Detailed, quality-focused)
```

### For Codex
```
"Analyze X autonomously. Use extended thinking for deep analysis."
(Autonomous, extended thinking)
```

### For Gemini
```
"Process all occurrences of X across the entire project. 
Return: [count, locations, proposed solution]."
(Bulk-first thinking)
```

---

## 11. Quick Start Templates

### Cost-Optimized (Claude Haiku)
```json
{
  "model": "claude-haiku-4-5-20251001",
  "env": { "SMART_CONTEXT_MAX_CACHE_SIZE": "50" },
  "view": "skeleton",
  "max_results": 10
}
```

### Balanced (Claude Sonnet - Recommended)
```json
{
  "model": "claude-sonnet-4-5-20251022",
  "env": { "SMART_CONTEXT_MAX_CACHE_SIZE": "100" },
  "max_results": 50
}
```

### Production (Claude Opus)
```json
{
  "model": "claude-opus-4-5-20251101",
  "env": { "SMART_CONTEXT_MAX_CACHE_SIZE": "200" },
  "max_results": 50
}
```

### Agentic (Codex)
```json
{
  "model": "gpt-5.1-codex-max",
  "env": { "SMART_CONTEXT_MAX_CACHE_SIZE": "150" },
  "approval_policy": "on-failure",
  "max_results": 75
}
```

### Bulk Operations (Gemini)
```json
{
  "model": "gemini-3-pro",
  "env": { "SMART_CONTEXT_MAX_CACHE_SIZE": "200" },
  "max_results": 150
}
```

---

## References

- [Permissions Configuration](./permissions.md) - Detailed security and access control
- [Tool Conflict Resolution](./tool-conflicts.md) - Bash vs smart-context decisions
- [Prompt Engineering Guide](./prompt-engineering.md) - Communication patterns
- [Getting Started](./getting-started.md) - Basic setup

---

**Version:** 2.2.0  
**Last Updated:** 2025-12-15  
**Maintained by:** Smart Context MCP Team
