# Configuration Guide

Smart Context MCP is highly configurable through environment variables and configuration files. This guide covers all configuration options.

**Quick start:** Smart Context works out-of-the-box with zero config. Customize only if needed.

---

## 1. Environment Variables

Control Smart Context behavior via environment variables.

### Server Configuration

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `SMART_CONTEXT_ROOT` | string | `process.cwd()` | Project root directory for analysis |
| `SMART_CONTEXT_DEBUG` | boolean | `false` | Enable debug logging to console |
| `SMART_CONTEXT_ENGINE_PROFILE` | enum | `production` | `production` \| `ci` \| `test` (see below) |
| `SMART_CONTEXT_LOG_LEVEL` | enum | `info` | `debug` \| `info` \| `warn` \| `error` (minimum level for structured logs; overrides `SMART_CONTEXT_DEBUG` when set) |
| `SMART_CONTEXT_ALLOW_STDOUT_LOGS` | boolean | `false` | Write logs to stdout (disables MCP-safe log redirection). Use only outside MCP hosts. |

> **Stdout guard:** By default Smart Context routes `console.log`/`console.info`/`console.debug` output to `stderr` so MCP transports can use stdout exclusively for protocol frames. Set `SMART_CONTEXT_ALLOW_STDOUT_LOGS=true` only when you need legacy stdout logging (for example when running the CLI outside an MCP host).

### Performance Tuning

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `SMART_CONTEXT_MAX_CACHE_SIZE` | number | `200` | Maximum AST cache size in MB |
| `SMART_CONTEXT_SYMBOL_CACHE_SIZE` | number | `50` | LRU cache size for symbols (entries) |
| `SMART_CONTEXT_INDEX_BATCH_SIZE` | number | `100` | Files indexed per batch during startup |
| `SMART_CONTEXT_QUERY_TIMEOUT` | number | `30000` | Query timeout in milliseconds |
| `SMART_CONTEXT_MAX_RESULTS` | number | `400` | Maximum search results per query |

### Database Configuration

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `SMART_CONTEXT_DB_PATH` | string | `.smart-context/index.db` | SQLite database path |
| `SMART_CONTEXT_WAL_MODE` | boolean | `true` | Enable Write-Ahead Logging for concurrent access |
| `SMART_CONTEXT_DB_BUSY_TIMEOUT` | number | `5000` | Database busy timeout in ms |

### Language & Parser Configuration

| Variable | Type | Default | Description |
|----------|------|---------|-------------|
| `SMART_CONTEXT_PARSER_BACKEND` | enum | `auto` | `auto` \| `wasm` \| `js` \| `snapshot` (fallback chain) |
| `SMART_CONTEXT_LANGUAGE_CONFIG` | string | `(built-in)` | Path to custom language configuration JSON |
| `SMART_CONTEXT_DISABLE_WASM` | boolean | `false` | Force JavaScript parser instead of WASM |
| `SMART_CONTEXT_WASM_DIR` | string | `(auto-detect)` | Override directory used to resolve bundled `tree-sitter-wasms` files (useful when running the MCP server from a different project) |

---

## 2. Engine Profiles

Different profiles optimize for different scenarios.

### Profile: `production` (Default)

**Use when:** Running the server normally.

**Settings:**
```
- Full index persistence (SQLite)
- All parsers enabled (WASM + fallback)
- Maximum caching (200MB AST cache)
- Cluster pre-computation enabled
- Debug logging disabled
```

**Example:**
```bash
SMART_CONTEXT_ENGINE_PROFILE=production npx smart-context-mcp
```

---

### Profile: `ci`

**Use when:** Running in CI/CD pipelines.

**Settings:**
```
- Minimal memory (50MB AST cache)
- Fast indexing (larger batch sizes)
- No cluster pre-computation
- Strict error handling
- Detailed logging for debugging
```

**Example:**
```bash
# In your CI pipeline
SMART_CONTEXT_ENGINE_PROFILE=ci npx smart-context-mcp
```

---

### Profile: `test`

**Use when:** Running unit tests.

**Settings:**
```
- In-memory database (no disk writes)
- Snapshot-based parsing (deterministic)
- Tiny memory footprint
- Fast startup
```

**Example (in Jest):**
```javascript
process.env.SMART_CONTEXT_ENGINE_PROFILE = 'test';
const { SmartContextServer } = require('smart-context-mcp');
const server = new SmartContextServer({ root: '/tmp/test-project' });
```

---

## 3. Language Configuration

Configure which file types are indexed and how they're parsed.

### Built-in Languages

By default, Smart Context supports:

```typescript
{
  "typescript": {
    "extensions": [".ts", ".tsx"],
    "parser": "tree-sitter-typescript"
  },
  "javascript": {
    "extensions": [".js", ".jsx"],
    "parser": "tree-sitter-javascript"
  },
  "python": {
    "extensions": [".py"],
    "parser": "tree-sitter-python"
  },
  "json": {
    "extensions": [".json"],
    "parser": "tree-sitter-json"
  }
}
```

### Custom Language Configuration

Create a `languages.json` file:

```json
{
  "typescript": {
    "extensions": [".ts", ".tsx"],
    "parser": "tree-sitter-typescript",
    "enabled": true
  },
  "rust": {
    "extensions": [".rs"],
    "parser": "tree-sitter-rust",
    "enabled": true
  },
  "ruby": {
    "extensions": [".rb"],
    "parser": "tree-sitter-ruby",
    "enabled": false
  }
}
```

Then use it:

```bash
SMART_CONTEXT_LANGUAGE_CONFIG=/path/to/languages.json npx smart-context-mcp
```

---

## 4. Claude Desktop Configuration Examples

### Minimal Configuration

```json
{
  "mcpServers": {
    "smart-context": {
      "command": "npx",
      "args": ["-y", "smart-context-mcp"],
      "cwd": "/path/to/project"
    }
  }
}
```

### Full Configuration with Tuning

```json
{
  "mcpServers": {
    "smart-context": {
      "command": "npx",
      "args": ["-y", "smart-context-mcp"],
      "cwd": "/path/to/project",
      "env": {
        "SMART_CONTEXT_DEBUG": "true",
        "SMART_CONTEXT_ENGINE_PROFILE": "production",
        "SMART_CONTEXT_MAX_CACHE_SIZE": "500",
        "SMART_CONTEXT_DB_PATH": ".smart-context/index.db",
        "SMART_CONTEXT_SYMBOL_CACHE_SIZE": "100"
      }
    }
  }
}
```

### Multi-Project Setup

```json
{
  "mcpServers": {
    "smart-context-api": {
      "command": "npx",
      "args": ["-y", "smart-context-mcp"],
      "cwd": "/Users/you/projects/my-api",
      "env": { "SMART_CONTEXT_ENGINE_PROFILE": "production" }
    },
    "smart-context-web": {
      "command": "npx",
      "args": ["-y", "smart-context-mcp"],
      "cwd": "/Users/you/projects/my-web",
      "env": { "SMART_CONTEXT_ENGINE_PROFILE": "production" }
    },
    "smart-context-monorepo": {
      "command": "npx",
      "args": ["-y", "smart-context-mcp"],
      "cwd": "/Users/you/monorepo",
      "env": {
        "SMART_CONTEXT_ENGINE_PROFILE": "production",
        "SMART_CONTEXT_MAX_CACHE_SIZE": "800",
        "SMART_CONTEXT_SYMBOL_CACHE_SIZE": "200"
      }
    }
  }
}
```

---

## 5. Performance Tuning

### For Large Projects (>10K files)

Increase cache and batch sizes:

```bash
SMART_CONTEXT_MAX_CACHE_SIZE=1000 \
SMART_CONTEXT_SYMBOL_CACHE_SIZE=500 \
SMART_CONTEXT_INDEX_BATCH_SIZE=500 \
npx smart-context-mcp
```

**Effect:**
- Faster startup (larger batches)
- Faster queries (bigger cache)
- More RAM usage (~500MB-1GB)

**See also:** [Agent Optimization Guide](./agent-optimization.md) for model-specific tuning

---

### For CI/CD Pipelines

Optimize for speed and reliability:

```bash
SMART_CONTEXT_ENGINE_PROFILE=ci \
SMART_CONTEXT_MAX_CACHE_SIZE=100 \
SMART_CONTEXT_INDEX_BATCH_SIZE=1000 \
SMART_CONTEXT_LOG_LEVEL=warn \
npx smart-context-mcp
```

**Effect:**
- Fast indexing
- Minimal memory (good for containers)
- No unnecessary logging

**See also:** [Agent Optimization Guide - Token Budget Management](./agent-optimization.md#token-budget-management)

---

### For Small/Memory-Constrained Devices

Minimize memory usage:

```bash
SMART_CONTEXT_ENGINE_PROFILE=test \
SMART_CONTEXT_MAX_CACHE_SIZE=50 \
SMART_CONTEXT_SYMBOL_CACHE_SIZE=10 \
npx smart-context-mcp
```

**Effect:**
- Tiny memory footprint (<100MB)
- Slower queries
- Suitable for Raspberry Pi, containers

---

## 6. Database Management

### Check Database Status

```bash
# View database file
ls -lh .smart-context/index.db

# Size (typical)
# 100 files:    1MB
# 1,000 files:  10MB
# 10,000 files: 100MB
```

### Manual Optimization

```bash
# Vacuum database (reclaim space)
sqlite3 .smart-context/index.db "VACUUM;"

# Check for corruption
sqlite3 .smart-context/index.db "PRAGMA integrity_check;"

# Rebuild index (if issues detected)
rm .smart-context/index.db
# Server will rebuild on next start
```

### Backup & Restore

```bash
# Backup
cp .smart-context/index.db .smart-context/index.db.backup

# Restore
cp .smart-context/index.db.backup .smart-context/index.db
```

---

## 7. Security Configuration

### Restrict Access to Project Root

Smart Context is sandboxed by default. It cannot access files outside the `cwd`:

```json
{
  "cwd": "/Users/you/projects/my-app"
  // ✅ Can access: /Users/you/projects/my-app/**
  // ❌ Cannot access: /Users/you/projects/other-app/**
  // ❌ Cannot access: /etc/passwd, etc.
}
```

**To allow multi-project access:**

```json
{
  "cwd": "/Users/you/projects"
  // ✅ Can access: /Users/you/projects/**
  // ❌ Cannot access: /Users/you/**
}
```

**See also:** [Permissions Guide](./permissions.md) for tool access control

---

### Disable Debug Mode in Production

Always use in production:

```bash
SMART_CONTEXT_DEBUG=false  # ✅ Secure (no internal details logged)
SMART_CONTEXT_DEBUG=true   # ❌ Debug only (logs sensitive info)
```

---

## 8. Troubleshooting Configuration

### ❌ "Too much memory usage"

**Check current settings:**
```bash
echo $SMART_CONTEXT_MAX_CACHE_SIZE
# If unset, using 200MB default
```

**Fix:**
```bash
SMART_CONTEXT_MAX_CACHE_SIZE=100 npx smart-context-mcp
```

**See also:** [Agent Optimization Guide - Token Budget Management](./agent-optimization.md#6-token-budget-management)

---

### ❌ "Queries are slow"

**Possible causes:**

1. **Cache too small:**
   ```bash
   SMART_CONTEXT_SYMBOL_CACHE_SIZE=500  # Increase from default 50
   ```

2. **Parser overhead (large files):**
   ```bash
   SMART_CONTEXT_PARSER_BACKEND=wasm  # Faster than JS
   ```

3. **Database busy:**
   ```bash
   SMART_CONTEXT_DB_BUSY_TIMEOUT=10000  # Increase from 5000ms
   ```

**See also:** [Prompt Engineering Guide - Token Optimization](./prompt-engineering.md#token-optimization-techniques)

---

### ❌ "Database corruption detected"

**Recovery:**

```bash
# Delete corrupted database
rm .smart-context/index.db

# Restart (will rebuild)
npx smart-context-mcp

# Verify
sqlite3 .smart-context/index.db "SELECT COUNT(*) FROM files;"
```

---

### ❌ "Parser crashes on specific files"

**Fallback to JavaScript parser:**

```bash
SMART_CONTEXT_PARSER_BACKEND=js npx smart-context-mcp
```

**Or disable problematic language:**

Create `languages.json`:
```json
{
  "typescript": { "enabled": true },
  "python": { "enabled": false },
  "ruby": { "enabled": false }
}
```

```bash
SMART_CONTEXT_LANGUAGE_CONFIG=./languages.json npx smart-context-mcp
```

---

## 9. Advanced: Custom Backup Strategy

### Hourly Backups (Linux/Mac)

```bash
#!/bin/bash
# backup-smart-context.sh

DB_PATH=".smart-context/index.db"
BACKUP_DIR=".smart-context/backups"

mkdir -p "$BACKUP_DIR"

# Keep last 24 backups
ls -t "$BACKUP_DIR"/index.db.* | tail -n +25 | xargs rm -f

# Create new backup
cp "$DB_PATH" "$BACKUP_DIR/index.db.$(date +%s)"
```

Schedule with cron:
```bash
# Run hourly
0 * * * * /path/to/backup-smart-context.sh
```

---

## 10. Configuration Reference Checklist

Before deploying to production, verify:

- [ ] `SMART_CONTEXT_ROOT` points to correct project
- [ ] `SMART_CONTEXT_DEBUG` is `false`
- [ ] `SMART_CONTEXT_ENGINE_PROFILE` is `production`
- [ ] `SMART_CONTEXT_MAX_CACHE_SIZE` is reasonable for your RAM
- [ ] Tool permissions configured (see [Permissions Guide](./permissions.md))
- [ ] Database backup strategy is in place
- [ ] Log rotation is configured (if logging to file)

---

## Further Reading

### Getting Started & Integration
- **[Getting Started](./getting-started.md)** - Installation & setup for all platforms
- **[Integration Guide](./integration.md)** - IDE-specific configuration (VS Code, Cursor, JetBrains, Vim, Emacs)



### Tool & Security Configuration
- **[Tool Conflict Resolution Guide](./tool-conflicts.md)** - Bash vs smart-context decisions
- **[Permissions Guide](./permissions.md)** - `.claude/settings.local.json` configuration and security
- **[Agent README](../agent/README.md)** - Quick navigation by task and concept

---

**Version:** 1.0.0  
**Last Updated:** 2025-12-15  
**Maintained by:** Smart Context MCP Team
