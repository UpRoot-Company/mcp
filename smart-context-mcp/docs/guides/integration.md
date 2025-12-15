# IDE & Tool Integration Guide

This guide explains how to integrate Smart Context MCP with IDEs, build tools, and CI/CD pipelines. Smart Context automatically handles path normalization, so it works seamlessly with any tool format.

---

## Quick Start for Tool Developers

### 1. Initialize with Project Root

```typescript
import { SmartContextServer } from 'smart-context-mcp';
import { RootDetector } from 'smart-context-mcp/utils/RootDetector';

// Auto-detect project root
const projectRoot = await RootDetector.detectCurrentProjectRoot();

// Or explicitly set it
const smartContext = new SmartContextServer({
  rootPath: '/path/to/project',
  // ... other config
});
```

### 2. Send Paths in Any Format

Smart Context automatically normalizes paths - absolute or relative, both work identically:

```typescript
// Both work the same way:

// Absolute path
await smartContext.editCode({
  edits: [{
    operation: 'replace',
    filePath: '/Users/dev/project/src/main.ts',  // Absolute ✅
    targetString: 'oldCode',
    replacementString: 'newCode'
  }]
});

// Relative path
await smartContext.editCode({
  edits: [{
    operation: 'replace',
    filePath: 'src/main.ts',  // Relative ✅
    targetString: 'oldCode',
    replacementString: 'newCode'
  }]
});
```

**Result:** Same behavior, no manual path conversion needed.

---

## Path Normalization

### PathNormalizer Class

Handles automatic conversion between absolute and relative paths:

```typescript
import { PathNormalizer } from 'smart-context-mcp/utils/PathNormalizer';

const normalizer = new PathNormalizer('/project/root');

// Convert absolute to relative
normalizer.normalize('/project/root/src/main.ts');  // → 'src/main.ts'

// Keep relative unchanged
normalizer.normalize('src/main.ts');  // → 'src/main.ts'

// Normalize path sequences
normalizer.normalize('/project/root/src/../main.ts');  // → 'main.ts'

// Verify path is within root (security)
normalizer.isWithinRoot('src/main.ts');              // → true
normalizer.isWithinRoot('../../../etc/passwd');      // → false

// Convert back to absolute for file operations
normalizer.toAbsolute('src/main.ts');  // → '/project/root/src/main.ts'
```

### RootDetector Class

Auto-detects project root from any file path:

```typescript
import { RootDetector } from 'smart-context-mcp/utils/RootDetector';

// Async detection (recommended)
const root = await RootDetector.detectRoot(
  '/project/src/deeply/nested/file.ts'
);
// → '/project' (found package.json)

// Sync detection (faster, blocking)
const rootSync = RootDetector.detectRootSync(filePath);

// Custom markers (for non-standard projects)
const root = await RootDetector.detectRoot(filePath, [
  '.git',
  'package.json',
  'pyproject.toml',
  'Cargo.toml'
]);

// Get detection details
const { root, markerFound, depth } = 
  await RootDetector.detectRootWithDetails(filePath);
// → {
//   root: '/project',
//   markerFound: 'package.json',
//   depth: 3
// }

// Check if file is in project
const isWithin = await RootDetector.isWithinProject(
  'src/main.ts',
  projectRoot
);  // → true
```

---

## IDE-Specific Integration

### Claude Code (Official CLI Tool)

Claude Code is Anthropic's official CLI tool for agentic coding.

**Installation:**

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

**Add MCP Server:**

```bash
claude mcp add --transport stdio smart-context -- npx -y smart-context-mcp
```

**Configuration:** `.mcp.json` or `.claude/settings.json`

**Reference:** [Claude Code Docs](https://code.claude.com/docs/en/overview)

---

### Codex CLI (OpenAI)

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

[mcp_servers.smart-context]
command = "npx"
args = ["-y", "smart-context-mcp"]
```

**Key Features:**
- Extended thinking for deep reasoning
- Agents.md for project instructions
- Models: GPT-5.1-Codex-Max or Mini

**Reference:** [Codex Docs](https://developers.openai.com/codex)

---

### GitHub Copilot (VS Code)

GitHub Copilot is a Microsoft/GitHub product available in VS Code (v1.99+, March 2025) and other IDEs. It supports MCP via configuration files.

**Setup in VS Code:**

**Method 1: Project-level configuration (shared with team)**

Create `.vscode/mcp.json` in your project:

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

**Method 2: Personal settings (user-specific)**

Edit `.vscode/settings.json` or VS Code settings UI:

```json
{
  "github.copilot.mcp": {
    "smart-context": {
      "command": "npx",
      "args": ["-y", "smart-context-mcp"],
      "cwd": "${workspaceFolder}"
    }
  }
}
```

**Using in GitHub Copilot Chat:**

Open the Copilot Chat view and ask:
```
"Find all authentication logic in this project"
```

GitHub Copilot can now use Smart Context tools to analyze your code.

**Reference:** See [GitHub Copilot MCP Documentation](https://docs.github.com/copilot/customizing-copilot/using-model-context-protocol/extending-copilot-chat-with-mcp)

---

### VS Code MCP Extension Development

For building custom MCP-compatible extensions in VS Code:

**Setup:**

```typescript
import * as vscode from 'vscode';
import { SmartContextServer } from 'smart-context-mcp';
import { RootDetector } from 'smart-context-mcp/utils/RootDetector';

export async function initSmartContext(context: vscode.ExtensionContext) {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  
  if (!workspaceFolder) {
    vscode.window.showWarningMessage('No workspace folder open');
    return;
  }

  try {
    const projectRoot = workspaceFolder.uri.fsPath;
    
    const smartContext = new SmartContextServer({
      rootPath: projectRoot,
      logger: {
        debug: (msg) => console.log(`[Smart Context] ${msg}`),
        info: (msg) => console.log(`[Smart Context] ${msg}`),
        warn: (msg) => console.warn(`[Smart Context] ${msg}`),
        error: (msg) => console.error(`[Smart Context] ${msg}`)
      }
    });

    console.log('Smart Context initialized:', projectRoot);
    return smartContext;
  } catch (error) {
    vscode.window.showErrorMessage(
      `Failed to initialize Smart Context: ${error}`
    );
  }
}
```

**Using in commands:**

```typescript
const disposable = vscode.commands.registerCommand(
  'smart-context.editFile',
  async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) return;

    try {
      // VSCode provides absolute path
      const absolutePath = editor.document.uri.fsPath;

      // SmartContext auto-normalizes it
      const result = await smartContext.editCode({
        edits: [{
          operation: 'replace',
          filePath: absolutePath,  // Absolute path ✅
          targetString: 'oldCode',
          replacementString: 'newCode'
        }]
      });

      if (result.success) {
        vscode.window.showInformationMessage('Code updated successfully');
      } else {
        vscode.window.showErrorMessage(`Edit failed: ${result.message}`);
      }
    } catch (error) {
      vscode.window.showErrorMessage(`Error: ${error}`);
    }
  }
);
```

---

### JetBrains IDEs (IntelliJ, PyCharm, WebStorm, etc.)

JetBrains IDEs support both absolute and relative path formats.

**Setup:**

```typescript
// For IntelliJ IDEA
import com.intellij.openapi.project.Project;

export async function initSmartContextForJetBrains(project: Project) {
  const projectRoot = project.getBasePath();

  const smartContext = new SmartContextServer({
    rootPath: projectRoot,
    // ... config
  });

  return smartContext;
}

// Action handler
export async function performSmartContextEdit(
  project: Project,
  file: VirtualFile,
  smartContext: SmartContextServer
) {
  // JetBrains provides VirtualFile
  const filePath = file.getPath();  // Can be absolute or relative

  const result = await smartContext.editCode({
    edits: [{
      operation: 'replace',
      filePath: filePath,  // Works with both formats ✅
      targetString: 'oldCode',
      replacementString: 'newCode'
    }]
  });

  return result;
}
```

**PyCharm Python Example:**

```python
from pathlib import Path
from smart_context_mcp import SmartContextServer, RootDetector

# Initialize
project_root = RootDetector.detect_current_project_root()
smart_context = SmartContextServer(root_path=project_root)

# Edit file
result = smart_context.edit_code(
  edits=[{
    'operation': 'replace',
    'filePath': '/path/to/project/src/main.py',  # Auto-normalized
    'targetString': 'old_code',
    'replacementString': 'new_code'
  }]
)

print(f"Success: {result['success']}")
```

---

### Cursor IDE

Cursor integrates seamlessly with MCP servers.

**Configuration:**

1. Go to **Cursor Settings** → **Features** → **MCP**
2. Add new server:
   - Name: `smart-context`
   - Command: `npx -y smart-context-mcp`
   - CWD: `/path/to/project`

**Using in code:**

```typescript
// Cursor handles all path normalization
const request = {
  edits: [
    {
      filePath: editor.getActiveFile(),  // Cursor's absolute path
      operation: 'replace',
      targetString: 'oldCode',
      replacementString: 'newCode'
    }
  ]
};

// Send directly - Smart Context normalizes
const result = await smartContext.editCode(request);
```

---

### Gemini CLI

Gemini CLI is Google's open-source AI agent that runs in your terminal. It supports MCP server integration for extended functionality.

**Installation:**

```bash
# Via npm
npm install -g @google-gemini/cli

# Or via pip
pip install gemini-cli

# Verify installation
gemini --version
```

**Configuration:**

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

**Available Settings Categories:**

Gemini CLI supports comprehensive settings via `/settings` command:

- **General**: Preview features, Vim mode, auto-updates, session retention
- **Output**: Format selection (text or JSON)
- **UI**: Display options, accessibility features
- **Model**: Session configuration, compression thresholds
- **Context**: File discovery, .gitignore respect
- **Tools**: Shell configuration, auto-accept settings
- **Security**: YOLO mode (auto-approve), folder trust
- **Experimental**: Codebase Investigator agent

**Using Smart Context in Gemini CLI:**

```bash
# Start Gemini CLI in your project
gemini

# Ask questions that use Smart Context tools
gemini "Analyze the API structure of this project"
gemini "Find all authentication logic and show me the flow"
gemini "What are the main entry points?"
```

**Features:**

- **Agent Mode**: Autonomous reasoning with tool integration
- **Built-in Tools**: File system, shell, web search, memory, todos
- **MCP Integration**: Extends capabilities with custom tools
- **Large Context**: 1M tokens for Gemini 3 Pro (state-of-the-art reasoning)
- **Speed**: Gemini 2.0 Flash for rapid iterations

**Reference:** See [Gemini CLI Documentation](https://geminicli.com/docs/)

---

### Vim/Neovim

For Vim/Neovim integration via LSP or custom plugins:

```vim
" init.vim / init.lua configuration

" Using coc-nvim
" Configure in coc-settings.json
{
  "languageserver": {
    "smart-context": {
      "command": "npx",
      "args": ["-y", "smart-context-mcp"],
      "filetypes": ["typescript", "javascript", "python", "json"],
      "initializationOptions": {
        "rootPath": "${workspaceFolder}"
      }
    }
  }
}
```

**Using in plugin:**

```lua
-- Using Neovim's LSP
local project_root = vim.loop.cwd()

local smart_context = require('smart_context_mcp').new({
  root_path = project_root
})

-- Edit current file
local result = smart_context:edit_code({
  edits = {{
    filePath = vim.fn.expand('%:p'),  -- Absolute path
    operation = 'replace',
    targetString = 'oldCode',
    replacementString = 'newCode'
  }}
})
```

---

### Emacs

For Emacs integration:

```elisp
;; emacs configuration

(require 'lsp-mode)

(lsp-register-client
  (make-lsp-client
    :new-connection (lsp-stdio-connection
      '("npx" "-y" "smart-context-mcp"))
    :server-id 'smart-context))

;; Edit function
(defun smart-context-edit ()
  (interactive)
  (let ((file-path (buffer-file-name)))
    (lsp-send-request
      (lsp--make-request
        "smart-context/editCode"
        (list
          :edits (vector
            (list
              :filePath file-path
              :operation "replace"
              :targetString "oldCode"
              :replacementString "newCode")))))))
```

---

## CI/CD Integration

### GitHub Actions

**Setup MCP server in workflow:**

```yaml
name: Smart Context Analysis

on: [push, pull_request]

jobs:
  analyze:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
      
      - name: Install Smart Context
        run: npm install -g smart-context-mcp
      
      - name: Run analysis
        env:
          SMART_CONTEXT_ENGINE_PROFILE: ci
          SMART_CONTEXT_MAX_CACHE_SIZE: 100
        run: |
          smart-context-mcp --version
          # Use in custom scripts
          node analyze-imports.js
```

**Custom analysis script:**

```javascript
// analyze-imports.js
const { SmartContextServer } = require('smart-context-mcp');
const { RootDetector } = require('smart-context-mcp/utils/RootDetector');

async function analyzeProject() {
  const projectRoot = await RootDetector.detectCurrentProjectRoot();
  
  const smartContext = new SmartContextServer({
    rootPath: projectRoot,
    engineProfile: 'ci'  // Optimized for CI
  });

  // Analyze all TypeScript files
  const results = await smartContext.searchProject({
    query: '*.ts',
    type: 'filename',
    maxResults: 1000
  });

  console.log(`Found ${results.results.length} TypeScript files`);
}

analyzeProject().catch(console.error);
```

---

### GitLab CI

**Setup in `.gitlab-ci.yml`:**

```yaml
stages:
  - analyze

smart-context-analysis:
  stage: analyze
  image: node:18
  script:
    - npm install -g smart-context-mcp
    - node analyze-project.js
  variables:
    SMART_CONTEXT_ENGINE_PROFILE: "ci"
    SMART_CONTEXT_MAX_CACHE_SIZE: "100"
```

---

### Pre-commit Hooks

**Setup `.pre-commit-config.yaml`:**

```yaml
repos:
  - repo: local
    hooks:
      - id: smart-context-check
        name: Smart Context Import Check
        entry: node pre-commit-hook.js
        language: node
        types: [typescript, javascript]
```

**Hook script:**

```javascript
// pre-commit-hook.js
const { SmartContextServer } = require('smart-context-mcp');
const { RootDetector } = require('smart-context-mcp/utils/RootDetector');
const fs = require('fs');
const path = require('path');

async function checkImports(files) {
  const projectRoot = await RootDetector.detectCurrentProjectRoot();
  const smartContext = new SmartContextServer({ rootPath: projectRoot });

  let hasErrors = false;

  for (const file of files) {
    const content = fs.readFileSync(file, 'utf-8');
    const imports = content.match(/import .* from ['\"](.+?)['\"]/g) || [];

    for (const importStr of imports) {
      const match = importStr.match(/from ['\"](.+?)['\"]/);;
      if (!match) continue;

      const importPath = match[1];
      
      // Resolve the import
      const resolved = await smartContext.analyzeRelationship({
        target: importPath,
        mode: 'dependencies'
      });

      if (!resolved) {
        console.error(`Unresolved import in ${file}: ${importPath}`);
        hasErrors = true;
      }
    }
  }

  process.exit(hasErrors ? 1 : 0);
}

const files = process.argv.slice(2);
checkImports(files).catch(err => {
  console.error(err);
  process.exit(1);
});
```

---

## Build Tool Integration

### Webpack Plugin

```typescript
// plugins/SmartContextPlugin.ts
import { SmartContextServer } from 'smart-context-mcp';
import { RootDetector } from 'smart-context-mcp/utils/RootDetector';

class SmartContextPlugin {
  private smartContext: SmartContextServer;

  async apply(compiler: any) {
    const projectRoot = await RootDetector.detectCurrentProjectRoot();
    
    this.smartContext = new SmartContextServer({
      rootPath: projectRoot
    });

    // Analyze imports before bundling
    compiler.hooks.beforeCompile.tapPromise(
      'SmartContextPlugin',
      async () => {
        const imports = await this.smartContext.searchProject({
          query: 'import',
          type: 'file',
          maxResults: 1000
        });

        console.log(`Found ${imports.results.length} import statements`);
      }
    );
  }
}

export default SmartContextPlugin;
```

**webpack.config.js:**

```javascript
const SmartContextPlugin = require('./plugins/SmartContextPlugin');

module.exports = {
  // ... webpack config
  plugins: [
    new SmartContextPlugin()
  ]
};
```

---

### Vite Plugin

```typescript
// vite-plugin-smart-context.ts
import { SmartContextServer } from 'smart-context-mcp';
import { RootDetector } from 'smart-context-mcp/utils/RootDetector';

export default function smartContextPlugin() {
  let smartContext: SmartContextServer;

  return {
    name: 'vite-smart-context',

    async configResolved() {
      const projectRoot = await RootDetector.detectCurrentProjectRoot();
      smartContext = new SmartContextServer({ rootPath: projectRoot });
    },

    async resolveId(id: string) {
      // Use Smart Context for module resolution
      if (id.startsWith('@')) {
        const resolved = await smartContext.analyzeRelationship({
          target: id,
          mode: 'dependencies'
        });
        return resolved;
      }
    }
  };
}
```

---

## Security Best Practices

### Path Validation

Always validate paths before processing:

```typescript
const normalizer = new PathNormalizer('/project');

// Block these:
normalizer.normalize('/etc/passwd');                    // ❌ Outside root
normalizer.normalize('../../../etc/passwd');            // ❌ Escaping root
normalizer.normalize('/project/../../../etc/passwd');   // ❌ Escaping root

// Allow these:
normalizer.normalize('src/main.ts');                    // ✅ Within root
normalizer.normalize('/project/src/main.ts');           // ✅ Within root
```

### Symlink Security

For enhanced security, resolve symlinks:

```typescript
const normalizer = new PathNormalizer('/project');

// Resolves symlinks before checking
const realPath = await normalizer.normalizeWithSymlinks(
  'src/link-to-file.ts'
);

// Ensure symlink doesn't escape
if (!normalizer.isWithinRoot(realPath)) {
  throw new Error('Symlink escapes project root');
}
```

---

## Troubleshooting

### Error: "Path is outside the allowed root directory"

**Cause:** File being edited is outside the configured project root.

**Fix:**

```typescript
// 1. Verify the root is correct
const detectedRoot = await RootDetector.detectRoot(filePath);
console.log('Detected root:', detectedRoot);

// 2. Use RootDetector to auto-detect
const root = await RootDetector.detectCurrentProjectRoot();

// 3. Verify file is in project
const isWithin = await RootDetector.isWithinProject(filePath);
console.log('File within project:', isWithin);
```

---

### Error: "Path has inconsistent separators"

**Cause:** Windows backslashes mixed with forward slashes.

**Fix:**

```typescript
// Use forward slashes only (Smart Context normalizes automatically)
const filePath = 'src/main.ts';  // ✅ Correct
const filePath = 'src\\main.ts'; // ❌ Avoid
```

---

### Error: "No matches found" when editing

**Cause:** Usually content mismatch, not path-related. Check:

1. Target string matches exactly (whitespace matters)
2. File is readable and accessible
3. Encoding is UTF-8

**Debug:**

```typescript
const normalizer = new PathNormalizer(projectRoot);

// Verify path is valid
const isWithin = normalizer.isWithinRoot(filePath);
console.log('Valid path:', isWithin);

// Read actual content
const content = await fs.promises.readFile(
  normalizer.toAbsolute(filePath),
  'utf-8'
);
console.log('Content available:', content.length > 0);
```

---

## References

- [Getting Started Guide](./getting-started.md) - Installation & setup
- [Configuration Guide](./configuration.md) - Environment variables
- [Agent Optimization Guide](./agent-optimization.md) - LLM-specific tuning
- [Prompt Engineering Guide](./prompt-engineering.md) - Effective communication
- [Tool Conflict Resolution](./tool-conflicts.md) - Bash vs smart-context decisions
- [Permissions Configuration](./permissions.md) - Security and access control
- [AGENT_PLAYBOOK.md](../agent/AGENT_PLAYBOOK.md) - Usage patterns
- [TOOL_REFERENCE.md](../agent/TOOL_REFERENCE.md) - Tool API details
- [Model Context Protocol](https://modelcontextprotocol.io/) - MCP standard

---

**Version:** 1.0.0  
**Last Updated:** 2025-12-15  
**Maintained by:** Smart Context MCP Team
