# Tool Permission Configuration Guide

Smart Context MCP can be integrated with various AI agents and platforms. This guide explains how to configure tool permissions to balance flexibility with security.

---

## 1. Overview

Tool permissions control which tools and commands are available to agents. Use permissions to:

- **Prevent unsafe operations** (e.g., `rm -rf /`)
- **Enforce security policies** (e.g., no external network access)
- **Optimize for workflows** (e.g., enable only needed tools)
- **Sandbox untrusted agents** (e.g., third-party AI agents)

---

## 2. The `.claude/settings.json` Pattern

### Location

`.claude/settings.json` is a project-level configuration file that controls tool access:

```
/Users/dev/my-project/
├── .claude/
│   └── settings.json        ← Tool permissions & MCP config
├── src/
├── package.json
└── README.md
```

### Why Project-Level Config?

- **Project-specific**: Different projects can have different permissions
- **Not in version control**: Keep configurations out of git
- **Local override**: Overrides global settings
- **Easy to change**: No need to restart IDE/agent

### Basic Structure

```json
{
  "permissions": {
    "allow": [
      "Bash(ls:*)",
      "Bash(pwd:*)",
      "mcp__smart-context-mcp__search_project",
      "mcp__smart-context-mcp__read_code"
    ]
  }
}
```

### Optional: `.gitignore` Entry

Add to `.gitignore` to prevent accidental commits:

```bash
.claude/settings.json
```

---

## 3. Permission Patterns

Pre-built configurations for common use cases:

### Pattern 1: Read-Only (Safest)

**Best for:** Code analysis, documentation generation, security audits

```json
{
  "permissions": {
    "allow": [
      "Bash(ls:*)",
      "Bash(find:*)",
      "Bash(cat:*)",
      "Bash(pwd:*)",
      "mcp__smart-context-mcp__search_project",
      "mcp__smart-context-mcp__read_code",
      "mcp__smart-context-mcp__read_file",
      "mcp__smart-context-mcp__list_directory",
      "mcp__smart-context-mcp__analyze_relationship",
      "mcp__smart-context-mcp__analyze_file"
    ]
  }
}
```

**What agents can do:**
- ✅ Search code
- ✅ Read files
- ✅ Analyze relationships
- ❌ Modify files
- ❌ Run commands

---

### Pattern 2: Safe Development (Recommended)

**Best for:** Normal development, refactoring, feature work

```json
{
  "permissions": {
    "allow": [
      "Bash(ls:*)",
      "Bash(pwd:*)",
      "Bash(git:*)",
      "Bash(npm:*)",
      "Bash(npm run build:*)",
      "Bash(npm test:*)",
      "mcp__smart-context-mcp__*"
    ],
    "deny": [
      "Bash(rm:*)",
      "Bash(mv:*)",
      "Bash(curl:*)",
      "Bash(wget:*)"
    ]
  }
}
```

**Use when:**
- Trust the AI agent
- Working on your own projects
- Need full smart-context capabilities
- Running automated tests

---

### Pattern 3: Restrictive (Production Agents)

**Best for:** CI/CD agents, untrusted agents, automated fixes only

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
    ]
  }
}
```

**Use when:**
- Running automated CI/CD pipelines
- Agent has limited trust
- Need strict guardrails

---

### Pattern 4: Minimal (Analysis Only)

**Best for:** Security audits, code review, compliance checks

```json
{
  "permissions": {
    "allow": [
      "mcp__smart-context-mcp__search_project",
      "mcp__smart-context-mcp__read_code",
      "mcp__smart-context-mcp__analyze_file",
      "mcp__smart-context-mcp__analyze_relationship"
    ]
  }
}
```

---

## 4. Wildcard Patterns

### Bash Wildcards

```json
{
  "permissions": {
    "allow": [
      "Bash(npm:*)",     // All npm commands
      "Bash(git:*)",     // All git commands
      "Bash(ls:*)"       // All ls variants
    ]
  }
}
```

### Smart Context Wildcards

```json
{
  "permissions": {
    "allow": [
      "mcp__smart-context-mcp__search_*",     // search_project, etc.
      "mcp__smart-context-mcp__read_*",       // read_code, read_file
      "mcp__smart-context-mcp__*"             // All smart-context tools
    ]
  }
}
```

---

## 5. Security Considerations

### Dangerous Commands (Never Allow)

| Command | Why | Alternative |
|---------|-----|-------------|
| `rm` | Deletes files permanently | Use smart-context for edits |
| `eval` | Arbitrary code execution | No safe alternative |
| `exec` | Process replacement | No safe alternative |
| `sudo` | Privilege escalation | No safe alternative |
| `curl` | Network access (data exfil) | Whitelist only safe URLs |
| `wget` | Network access (data exfil) | Whitelist only safe URLs |

### Recommended Blacklist

```json
{
  "permissions": {
    "deny": [
      "Bash(rm:*)",
      "Bash(rmdir:*)",
      "Bash(mv:*)",
      "Bash(eval:*)",
      "Bash(exec:*)",
      "Bash(sudo:*)",
      "Bash(curl:*)",
      "Bash(wget:*)"
    ]
  }
}
```

---

## 6. Per-Agent Configuration

Different agents have different configuration methods and permission systems.

---

### 🔵 Claude Code (Anthropic CLI)

**Setup:**
```bash
claude mcp add --transport stdio smart-context -- npx -y smart-context-mcp
```

**Configuration File:** `.claude/settings.json`

**Permission Configuration:**
```json
{
  "mcpServers": {
    "smart-context": {
      "command": "npx",
      "args": ["-y", "smart-context-mcp"]
    }
  },
  "permissions": {
    "allow": [
      "Bash(git:*)",
      "Bash(npm:*)",
      "mcp__smart-context-mcp__*"
    ],
    "deny": [
      "Bash(rm:*)",
      "Bash(curl:*)",
      "Bash(wget:*)"
    ]
  }
}
```

**Recommended Strategy:**
- Use **Safe Development** pattern for daily work
- All smart-context tools are safe by default
- Restrict dangerous Bash commands

---

### 🔷 Codex CLI (OpenAI)

**Setup:**
```bash
codex mcp add smart-context -- npx -y smart-context-mcp
```

**Configuration File:** `~/.codex/config.toml`

**Permission Configuration:**
```toml
[mcp.servers.smart-context]
command = "npx"
args = ["-y", "smart-context-mcp"]

[mcp.servers.smart-context.permissions]
approval_policy = "on-request"
sandbox_mode = "workspace-write"

[mcp.servers.smart-context.excludeTools]
tools = ["Bash(rm:*)", "Bash(curl:*)", "Bash(eval:*)"]
```

**Recommended Strategy:**
- Development: `approval_policy = "on-request"` + `sandbox_mode = "workspace-write"`
- Autonomous: `approval_policy = "never"` + `sandbox_mode = "workspace-write"`
- CI/CD: `approval_policy = "on-failure"` + `sandbox_mode = "workspace-write"`

---

### 💚 Gemini CLI (Google)

**Setup:**
```bash
gemini mcp add smart-context -- npx -y smart-context-mcp
```

**Configuration File:** `~/.gemini/settings.json`

**MCP Server Configuration (Smart Context):**
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
      ],
      "excludeTools": []
    }
  }
}
```

**Shell Command Control (Gemini's built-in tool):**

Gemini CLI has its own shell command tool separate from MCP. Control it via:

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
      "run_shell_command(eval)",
      "run_shell_command(curl)",
      "run_shell_command(wget)"
    ]
  }
}
```

**Gemini CLI Built-in Tools:**
- `run_shell_command`: Execute shell commands (controlled by `tools.core` / `tools.exclude`)
- `read_file`, `write_file`, `list_files`, `search_files`: File system access
- `web_fetch`: Fetch web content
- `google_web_search`: Web search
- `save_memory`, `write_todos`: Session management

**Complete Configuration Example (Development):**
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
  },
  "tools": {
    "core": [
      "run_shell_command(git)",
      "run_shell_command(npm)",
      "run_shell_command(node)"
    ],
    "exclude": [
      "run_shell_command(rm)",
      "run_shell_command(eval)",
      "run_shell_command(curl)"
    ]
  }
}
```

**Recommended Strategy:**
- Development: Enable all smart-context tools + allow essential shell commands (git, npm)
- Analysis: Use `excludeTools` to hide `edit_code`
- Security: Use explicit `core` allowlist (most secure)

**Important Notes:**
- `includeTools` / `excludeTools` control Smart Context MCP tools
- `tools.core` / `tools.exclude` control Gemini's built-in shell command execution
- Command limitation via string matching is not a security boundary
- For security-critical use, use explicit `core` allowlist only

---

### 📋 Others (GitHub Copilot, Cursor, CI/CD)

**GitHub Copilot & Cursor:**
- Both use `.claude/settings.json` (same as Claude Code)
- Use **Safe Development** pattern
- Supports all common MCP configurations

**CI/CD (GitHub Actions / GitLab CI):**
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

**Other MCP-Compatible Tools:**
- Follow the **Safe Development** or **Restrictive** patterns above
- Check tool documentation for specific configuration file locations

---

## 7. Environment-Specific Patterns

### Development (Local)
```json
{
  "permissions": {
    "allow": [
      "Bash(git:*)",
      "Bash(npm:*)",
      "mcp__smart-context-mcp__*"
    ],
    "deny": ["Bash(curl:*)", "Bash(wget:*)"]
  }
}
```

### Staging (Automated)
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

### Production (Minimal)
```json
{
  "permissions": {
    "allow": [
      "Bash(npm test:*)",
      "mcp__smart-context-mcp__read_code",
      "mcp__smart-context-mcp__search_project"
    ]
  }
}
```

---

## 8. Best Practices

1. **Start Restrictive, Expand as Needed**
   - Begin with read-only, add tools incrementally

2. **Use Wildcards Sparingly**
   - Explicit is safer than wildcards

3. **Document Why Each Permission Exists**
   - Add comments explaining necessity

4. **Review Quarterly**
   - Remove unused permissions
   - Update for new workflows

5. **Never Commit Secrets**
   - Use `.env` for credentials
   - Add `.claude/settings.json` to `.gitignore`

6. **Always Deny Dangerous Commands**
   - `rm`, `eval`, `exec`, `sudo`, `curl`, `wget`

---

## 9. Tool Exclusion Best Practices

**Always exclude:**
```
Bash(rm:*)        → File deletion
Bash(eval:*)      → Code execution
Bash(exec:*)      → Process replacement
Bash(sudo:*)      → Privilege escalation
```

**Usually safe:**
```
Bash(git:*)                        → Version control (audit trail)
Bash(npm:*)                        → Package management (reversible)
mcp__smart-context-mcp__*          → All smart-context tools (sandboxed)
```

---

## References

- [Agent Optimization Guide](./agent-optimization.md) - Tool strategies per agent
- [Tool Conflict Resolution](./tool-conflicts.md) - Bash vs smart-context decisions
- [Getting Started](./getting-started.md) - Basic setup
- [Configuration Guide](./configuration.md) - Environment variables

---

**Version:** 1.0.0  
**Last Updated:** 2025-12-15  
**Maintained by:** Smart Context MCP Team
