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

Smart Context handles all path formats automatically - send absolute or relative paths, both work identically.

**Key utilities for integration:**

- **PathNormalizer**: Converts between absolute/relative paths, validates paths are within project root
- **RootDetector**: Auto-detects project root from file paths (searches for `.git`, `package.json`, etc.)

**Example:**
```typescript
import { PathNormalizer, RootDetector } from 'smart-context-mcp/utils';

const root = await RootDetector.detectCurrentProjectRoot();
const normalizer = new PathNormalizer(root);

// Both work identically
normalizer.normalize('/project/src/main.ts');  // → 'src/main.ts'
normalizer.normalize('src/main.ts');           // → 'src/main.ts'
```

---

## IDE-Specific Integration

**For basic platform setup (Claude Code, GitHub Copilot, Cursor, Gemini CLI):**  
See [getting-started.md](./getting-started.md#platform-configuration)

This section covers advanced IDE integrations and extension development.

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
