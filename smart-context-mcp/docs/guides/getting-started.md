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

### 3.5 Codex CLI (OpenAI)

Codex is OpenAI's CLI tool for agentic coding with extended thinking.

**Installation:**

```bash
curl -fsSL https://install.openai.com/codex | bash
```

**Add MCP Server:**

```bash
codex mcp add smart-context -- npx -y smart-context-mcp
```

**Configuration:** `~/.codex/config.toml`

```toml
model = "gpt-5.1-codex-max"
model_reasoning_effort = "high"
```

**Reference:** [Codex Docs](https://developers.openai.com/codex)

---

### 3.6 Other Platforms & Generic MCP Integration

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

### Example 1: File Structure (Easiest) 🟢

**You ask:**
> "What's the project structure? Show me the main directories."

**What happens:**
1. AI calls `list_directory` tool
2. Smart Context returns directory tree
3. AI summarizes structure

**Success if:** You see actual directories from your project

---

### Example 2: Token-Efficient Exploration (Intermediate) 🟡

**You ask:**
> "Find the authentication code. Show me the structure of the main auth file without reading the whole implementation."

**What happens:**
1. AI calls `search_project(type="symbol")` to find auth-related code
2. AI calls `read_code(view="skeleton")` on the auth file
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
1. AI calls `search_project` to find all occurrences
2. AI calls `analyze_relationship(mode="impact")` to see dependencies
3. AI plans atomic edits for all affected files
4. AI uses `edit_code(dryRun=true)` to preview changes
5. (Optional) You approve and AI applies with `dryRun=false`

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

1. **Did you restart the client?**
   - Claude: Quit fully (Cmd+Q) and reopen
   - Cursor: Restart the application
   - GitHub Copilot: Restart terminal/IDE

2. **Is the `cwd` path correct?**
   ```bash
   # Verify the directory exists
   ls -la /absolute/path/to/your/project
   ```

3. **Is Node.js in your PATH?**
   ```bash
   which node
   which npx
   # Both should return paths
   ```

4. **Check MCP logs** (Platform-specific):
   - Claude: Menu → Logs → Look for `smart-context` entries
   - Cursor: Command Palette → Toggle Output Panel

---

### ❌ "FileSystemError: Path is outside root directory"

**What it means:** Smart Context is sandboxed for security. It can only access files under the `cwd` you configured.

**Fix:**
1. Update `cwd` in config to the correct project root
2. Don't try to access `../sibling-project` from within a project config
3. For multi-project setups, use a common parent directory as `cwd`

**Example:**
```json
{
  "cwd": "/Users/you/projects"  // ✅ Access all projects here
  // NOT "/Users/you/projects/my-app"  ❌ Too narrow
}
```

---

### ❌ "It's slow on the first run"

**Why:** Smart Context builds a high-performance SQLite index on startup.

**Timeline:**
- First query: 500ms (after indexing completes)
- Indexing in background: 5-30 seconds (depends on project size)
- Subsequent queries: 50-300ms (very fast)

**What to do:**
- Wait 30 seconds on first launch for full indexing
- Use AI while indexing happens—it's async!
- For very large projects (>100K files), first index may take 1-2 minutes

---

### ❌ "Skeleton view shows too much / too little"

**Too much?** (You expected less detail)
- Skeleton shows function signatures by default
- To hide more, request: "Show me just the class and function names"
- The AI can use `skeletonOptions: { detailLevel: "minimal" }`

**Too little?** (You need more context)
- Ask the AI to use `read_code(view="fragment", lineRange="start-end")`
- Or request the full file: "Show me the complete implementation"

---

### ❌ Edit Failed: "NO_MATCH" / "AMBIGUOUS_MATCH"

**NO_MATCH: "Target string not found"**
- Whitespace might differ (extra spaces, different line endings)
- Code might have changed since last read
- **Recovery:** Ask AI to `read_code` again, then retry with exact whitespace

**AMBIGUOUS_MATCH: "Found 3 matches"**
- Target string appears multiple times (`return true;`, etc.)
- **Recovery:** Ask AI to add `beforeContext` / `afterContext` to disambiguate
- Or specify exact line number with `lineRange`

**Example fix:**
```json
// Instead of generic target:
"targetString": "return true;"

// Use specific context:
"targetString": "return true;",
"beforeContext": "if (isAdmin) {",
"afterContext": "} else {",
"lineRange": {"start": 40, "end": 40}
```

---

## 7. Advanced: Custom Configuration

### Environment Variables

Control Smart Context behavior with environment variables:

```bash
# In your config:
"env": {
  "SMART_CONTEXT_DEBUG": "true",        # Enable debug logging
  "SMART_CONTEXT_ENGINE_PROFILE": "ci", # production|ci|test
  "SMART_CONTEXT_MAX_CACHE_SIZE": "500" # MB, default 200
}
```

---

### Multi-Project Setup

Configure multiple projects in Claude:

```json
{
  "mcpServers": {
    "smart-context-api": {
      "command": "npx",
      "args": ["-y", "smart-context-mcp"],
      "cwd": "/Users/you/projects/my-api"
    },
    "smart-context-web": {
      "command": "npx",
      "args": ["-y", "smart-context-mcp"],
      "cwd": "/Users/you/projects/my-web"
    }
  }
}
```

Then ask: "Using smart-context-api, find the login endpoint."

---

## 8. Next Steps

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
