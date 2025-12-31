# Getting Started with Smart Context MCP

Welcome! This guide walks you through installing the Smart Context MCP server and connecting it to various AI assistants (Claude, Cursor, GitHub Copilot, Gemini, and others).

**Estimated time:** 10-15 minutes to setup | **Skill level:** Beginner

---

## 1. Prerequisites

Ensure you have:

- **Node.js**: Version 18.0.0 or higher (LTS recommended)
- **Package Manager**: `npm` (v9+) or `pnpm`
- **A code project** to analyze (or use any open-source repo to test)

Verify your Node.js version:
```bash
node --version  # Should be v18.0.0+
npm --version   # Should be v9.0.0+
```

---

## 2. Installation

### Option A: Global Installation (Recommended)

Install globally for easy access from any directory:

```bash
npm install -g smart-context-mcp
```

Verify installation:
```bash
smart-context-mcp --version
# Output: 1.0.0 (or current version)
```

### Option B: Local Installation (Project-Specific)

Install in your project for team consistency:

```bash
cd /path/to/your/project
npm install smart-context-mcp --save-dev
```

Then use via `npx`:
```bash
npx smart-context-mcp
```

---

## 3. Configuration by AI Platform

Smart Context implements the **Model Context Protocol (MCP)** standard. Choose your platform below.

### 3.1 Claude Code (Official CLI Tool)

Claude Code is Anthropic's official CLI tool for agentic coding that runs directly in your terminal.

**Installation:**

```bash
# macOS/Linux
curl -fsSL https://claude.ai/install.sh | bash

# Or with Homebrew (macOS)
brew install --cask claude-code

# Or with npm (requires Node.js 18+)
npm install -g @anthropic-ai/claude-code
```

**Step 1: Add Smart Context MCP Server**

Add the server to your Claude Code configuration:

```bash
# Add globally (all projects)
claude mcp add --transport stdio smart-context -- npx -y smart-context-mcp
```

**Step 2: Configure MCP (Optional)**

Create `.mcp.json` in your project for team configuration:

```json
{
  "mcpServers": {
    "smart-context": {
      "command": "npx",
      "args": ["-y", "smart-context-mcp"]
    }
  }
}
```

**Step 3: Start Claude Code**

```bash
cd your-project
claude
```

**Verify Installation:**

```bash
# List all installed MCP servers
claude mcp list

# Check status within Claude Code
/mcp
```

**Scope Options:**
- `local` (default): Project-specific, stored in `~/.claude.json`
- `project`: Team-shared, stored in `.mcp.json` (tracked in git)
- `user`: All projects globally, stored in `~/.claude.json`

**Troubleshooting:**
- Run `claude mcp list` to verify the server is installed
- Check `.claude.json` or `.mcp.json` for configuration
- For permission configuration, see [Tool Permissions](./permissions.md)

---

### 3.2 GitHub Copilot (VS Code)

GitHub Copilot in VS Code supports MCP natively via `.vscode/mcp.json` configuration (v1.99+, March 2025).

**Step 1: Create config file**

Create `.vscode/mcp.json` in your project (shared with team):

```json
{
  "mcpServers": {
    "smart-context": {
      "command": "npx",
      "args": ["-y", "smart-context-mcp"],
      "cwd": "${workspaceFolder}",
      "env": {
        "SMART_CONTEXT_ROOT": "${workspaceFolder}"
      }
    }
  }
}
```

Alternatively, for personal settings only, edit `.vscode/settings.json`:

```json
{
  "github.copilot.mcp": {
    "smart-context": {
      "command": "npx",
      "args": ["-y", "smart-context-mcp"]
    }
  }
}
```

**Step 2: Use in GitHub Copilot Chat**

Open GitHub Copilot Chat and ask:
```
"Find all authentication logic in this project"
```

GitHub Copilot can now use Smart Context tools to analyze your code.

**Reference:** See [GitHub Copilot MCP Documentation](https://docs.github.com/copilot/customizing-copilot/using-model-context-protocol/extending-copilot-chat-with-mcp)

---

### 3.3 Cursor IDE

**Step 1: Open Cursor Settings**

Go to **Cursor Settings** (Cmd+,) → **Features** → **MCP**

**Step 2: Add new MCP server**

- **Name**: `smart-context`
- **Type**: `stdio`
- **Command**: `npx -y smart-context-mcp`
- **CWD**: (your project directory)

**Step 3: Test connection**

Create a new chat and ask: `"Analyze the project structure"`

---

### 3.4 Gemini CLI

Gemini CLI is Google's open-source AI agent that runs in your terminal. It supports MCP servers for tool integration.

**Step 1: Install Gemini CLI**

```bash
npm install -g @google-gemini/cli
# or
pip install gemini-cli
```

**Step 2: Configure MCP Server**

Edit `~/.gemini/settings.json` (user-level) or `.gemini/settings.json` (project-level):

```json
{
  "mcpServers": {
    "smart-context": {
      "command": "npx",
      "args": ["-y", "smart-context-mcp"],
      "cwd": "/path/to/your/project"
    }
  }
}
```

**Step 3: Use in Gemini CLI**

```bash
gemini "Help me understand the API structure of this project"
```

Gemini CLI can now use Smart Context tools to analyze your codebase.

**Reference:** See [Gemini CLI MCP Configuration](https://geminicli.com/docs/tools/)

---

### 3.5 Other Platforms & Generic MCP Integration

For other platforms supporting MCP, use the general pattern:

```bash
# Command format
npx -y smart-context-mcp

# Working directory: Your project root
# Transport: stdio
```

Consult your platform's MCP documentation for specific configuration details.

---

## 4. Hello World: Your First Queries

Let's verify the installation with three progressive examples.

### Example 1: Find Key Entry Points (Easiest) 🟢

**You ask:**
> "Find the main entry points (package.json, server entry, config). Show me the structure of the main entry file."

**What happens:**
1. AI calls `navigate` to locate entry/config files
2. AI calls `read(view="skeleton")` (or `full` for small/non-code files)
3. AI summarizes structure and next places to look

**Success if:** You see actual directories from your project

---

### Example 2: Token-Efficient Exploration (Intermediate) 🟡

**You ask:**
> "Find the authentication code. Show me the structure of the main auth file without reading the whole implementation."

**What happens:**
1. AI calls `navigate(context="definitions")` to find auth-related symbols/files
2. AI calls `read(view="skeleton")` on the auth file
3. You see function signatures but **no implementation bodies** (Skeleton view compresses 95% of tokens!)

**Expected output (skeleton):**
```typescript
// Only signatures shown, implementation hidden with "..."
export class AuthService {
  login(username: string, password: string): Promise<User> { ... }
  logout(userId: string): Promise<void> { ... }
  validateToken(token: string): boolean { ... }
}
```

**Success if:** 
- ✅ You see function names and signatures
- ✅ Implementation is hidden with `{ ... }`
- ✅ No giant code blocks in the response

---

### Example 3: Cross-File Impact Analysis (Advanced) 🔴

**You ask:**
> "I want to rename the `validateUser` function to `authenticateUser`. What files will this affect? Is it safe?"

**What happens:**
1. AI calls `navigate` to locate definitions/usages
2. AI uses `change(options.dryRun=true)` to propose a safe multi-file plan
3. You review the diff and impact summary
4. (Optional) You approve and AI applies with `change(options.dryRun=false)`

**Success if:**
- ✅ AI identifies all files that use `validateUser`
- ✅ AI shows a preview (diff) before making changes
- ✅ You can review and approve

---

## 5. Performance Expectations

### First Run (Indexing)

```
Timeline for a 1000-file project:

0ms:    Server starts
50ms:   Database initialized
100ms:  Parsers loaded
200ms:  File system scanned
500ms:  ✅ Ready for first query
        (Background indexing continues...)

Background (async):
+1s:    10% indexed
+3s:    50% indexed
+5s:    100% indexed
+10s:   Cluster pre-computation done

Result: Agent can work while indexing happens!
```

### Query Performance

| Operation | Time | Notes |
|-----------|------|-------|
| Search filename | 50ms | Very fast (trigram index) |
| Search symbol | 100ms | Fuzzy matching |
| Read skeleton | 80ms | 95% token savings |
| Edit (dry-run) | 100ms | Fast validation |
| Large refactor (20 files) | 500ms | All-or-nothing transaction |

---

## 6. Troubleshooting

### ❌ "Tool not found" / Connection Failed

**Check these:**

1. **Restart the client** - Claude: Quit fully (Cmd+Q) and reopen | Cursor/IDE: Restart application
2. **Verify `cwd` path exists** - Run: `ls -la /absolute/path/to/your/project`
3. **Check Node.js** - Run: `which node && which npx` (both should return paths)
4. **Check MCP logs** - Claude: Menu → Logs | Cursor: Command Palette → Toggle Output Panel

---

### ❌ "It's slow on the first run"

**Why:** Smart Context builds a SQLite index on startup (async, happens in background).

**Timeline:**
- First query ready: ~500ms
- Background indexing: 5-30 seconds (1000 files) | 1-2 minutes (100K+ files)
- Subsequent queries: 50-300ms (very fast)

**What to do:** Wait 30 seconds on first launch. You can use the AI while indexing continues!

---

### ❌ Change Failed / Plan Looks Wrong

If a `change` dry-run plan doesn’t match what you intended:

- Re-run `read(view="fragment")` on the exact area you want changed (the code may have drifted).
- Re-run `change` with tighter constraints (e.g., specify `targetFiles`, or mention “only change X, keep public API unchanged”).
- If you already applied a bad change: `manage({ command: "undo" })`, then try again with a clearer intent.

---

**For more troubleshooting, configuration options, and advanced setups:**
- [FAQ.md](./FAQ.md) - 20+ common questions
- [configuration.md](./configuration.md) - Environment variables, engine profiles, multi-project setup
- [integration.md](./integration.md) - IDE-specific integration guides

---



## 7. Next Steps

You're ready! Try these:

1. **Quick Wins:**
   - Ask: "Summarize the architecture of this project"
   - Ask: "Find all TODO comments in the code"
   - Ask: "What are the main entry points?"

2. **Learn More:**
   - Read [AGENT_PLAYBOOK.md](../agent/AGENT_PLAYBOOK.md) for advanced patterns
   - See [TOOL_REFERENCE.md](../agent/TOOL_REFERENCE.md) for tool details
   - Check [integration.md](./integration.md) for IDE-specific tips
   - Explore [Agent Optimization Guide](./agent-optimization.md) for LLM-specific strategies

3. **Troubleshoot:**
   - Check the platform logs (Claude → Logs, etc.)
   - Verify Node.js: `node --version`
   - Test directly: `npx smart-context-mcp --version`

---

## Questions?

- **MCP Protocol:** See [modelcontextprotocol.io](https://modelcontextprotocol.io/)
- **Project Issues:** Check [GitHub Issues](https://github.com/your-org/smart-context-mcp/issues)
- **Documentation:** Full docs in [README.md](../README.md)

---

**Version:** 1.0.0  
**Last Updated:** 2025-12-15  
**Maintained by:** Smart Context MCP Team
