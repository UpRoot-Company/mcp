# Frequently Asked Questions (FAQ)

Quick answers to common questions about Smart Context MCP.

**Note (ADR-033):** The primary interface is the **Six Pillars** (`navigate`, `read`, `understand`, `change`, `write`, `manage`). Some older sections may still mention legacy tool names (e.g. `read_code`); see `smart-context-mcp/docs/legacy/LEGACY_TOOL_CATALOG.md` for mappings.

---

## General Questions

### Q: What is Smart Context MCP?

**A:** Smart Context is a Model Context Protocol (MCP) server that helps AI assistants (Claude, Copilot, Gemini, etc.) efficiently analyze and modify large codebases.

**Key benefits:**
- 95% token savings through smart skeleton views
- Safe atomic editing across multiple files
- Intelligent fuzzy matching for formatting differences
- Built-in transaction safety (all-or-nothing edits)

Think of it as a "smart middleware" between AI and your filesystem.

---

### Q: How is Smart Context different from Language Server Protocol (LSP)?

**A:**

| Feature | Smart Context (MCP) | LSP |
|---------|-------------------|-----|
| **Purpose** | Help AI understand code | IDE syntax/autocomplete |
| **Protocol** | Model Context Protocol | Language Server Protocol |
| **Use Case** | Large-scale refactoring | Local development |
| **Optimization** | Token efficiency | Real-time feedback |
| **Safety** | Transactional edits | Direct file access |

**In short:** LSP helps your IDE; Smart Context helps AI agents.

---

### Q: Which AI assistants are supported?

**Supported:**
- ✅ Claude (Claude Desktop)
- ✅ GitHub Copilot CLI
- ✅ Cursor IDE
- ✅ Gemini CLI
- ✅ Any MCP-compatible platform

**Installation time:** ~5 minutes

**See:** [Getting Started Guide](./getting-started.md)

---

### Q: How do I choose between skeleton, fragment, and full views?

**A:** Use this decision tree:

```
Do you need to understand the overall structure?
  ├─ YES → read(view="skeleton") ⭐ Recommended
  └─ NO  → Do you know the line numbers?
           ├─ YES → read(view="fragment", lineRange="10-50")
           └─ NO  → read(view="full") (only if needed)
```

**Examples:**

| Task | View | Why |
|------|------|-----|
| Explore a new file | `skeleton` | Understand structure without noise |
| Check specific function | `fragment` | Read exact lines you need |
| Understand algorithm | `full` | Need to see all implementation |
| Find where to add code | `skeleton` | See overall organization |

**Token savings:** Skeleton uses 95% fewer tokens than full view.

---

### Q: Is my code secure? Will it be sent to Anthropic?

**A:** 

✅ **Secure:**
- Code stays on your machine
- Smart Context runs locally
- No data is sent to Anthropic by default

⚠️ **Important:**
- When you use Claude, your conversations are sent to Anthropic's servers
- Claude processes your code (that's the point!)
- Your code is handled per Anthropic's [Privacy Policy](https://www.anthropic.com/legal/privacy)

**If security is critical:** Use on-premise Claude deployments or self-hosted AI.

---

---

## Technical Questions

### Q: Why does Smart Context use SQLite instead of keeping everything in memory?

**A:** 

**Problem with in-memory:**
```
100 files    → 50MB RAM
1,000 files  → 300MB RAM
10,000 files → 2GB RAM
100,000 files → 20GB RAM ❌ OOM!
```

**Solution with SQLite:**
```
Any size project → ~200MB RAM (constant!)
```

**Benefits:**
- Scales to 100K+ file projects
- Fast startup (<500ms)
- Incremental indexing
- Survives process restarts

---

### Q: How does skeleton generation work?

**A:** Smart Context uses **Tree-sitter AST (Abstract Syntax Tree)** to parse code, then "folds" implementation details:

**Before (skeleton view):**
```typescript
// 400 lines, ~1600 tokens
function calculateTax(income: number, deductions: number): number {
  if (income < 0) throw new Error("Invalid income");
  const taxableIncome = income - deductions;
  // ... 15 more lines of calculation ...
  return Math.round(finalTax * 100) / 100;
}
```

**After (skeleton view):**
```typescript
// 1 line, ~50 tokens
function calculateTax(income: number, deductions: number): number { ... }
```

**How it works:**
1. Parse code into AST tree
2. Extract function signatures, class names, imports
3. Replace method bodies with `{ ... }`
4. Keep structure, remove noise

**Result:** 95-98% token savings!

---

### Q: What is the "confidence-based matching" mentioned in documentation?

**A:** When you ask AI to edit code, formatting might differ slightly:

```typescript
// What's in the file (extra spaces)
const  timeout  =  5000;

// What AI might provide
const timeout = 5000;
```

**Without confidence matching:** Edit fails ❌

**With confidence matching:**
1. Try exact match (100% confidence)
2. Try normalizing line endings (95% confidence)
3. Try normalizing indentation (87% confidence)
4. Try collapsing all whitespace (82% confidence)
5. Try structural matching (75% confidence)

**Result:** Edits succeed even with minor formatting differences ✅

**6-level hierarchy:**
```
Exact
  ↓ (if fails)
Line-endings normalization
  ↓
Trailing whitespace
  ↓
Indentation normalization
  ↓
All whitespace collapsing
  ↓
Structural matching
```

---

### Q: How are edits made transactional?

**A:** Smart Context uses **ACID transactions**:

```
1. SNAPSHOT: Save original file content + hash
2. VALIDATE: Check all edits are safe
3. APPLY: Make changes in memory
4. VERIFY: Confirm hash matches expectation
5. COMMIT: Write to disk

If ANY step fails → ROLLBACK (undo all changes)
```

**Example:**
```
You request: Edit 10 files
  ✅ Files 1-9 succeed
  ❌ File 10 fails

Result: ALL 10 edits are rolled back (no partial edits)
```

**Safety benefit:** Your codebase never ends up in a broken state.

---

### Q: What languages does Smart Context support?

**Built-in:**
- TypeScript / JavaScript
- Python
- JSON
- Plus fallback parsing

**Custom:** Add any Tree-sitter language via `languages.json`

**See:** [Configuration Guide](./configuration.md) for details

---

---

## Performance Questions

### Q: Why is the first query slower?

**A:** Smart Context builds an index on startup:

```
Timeline:
0ms:    Server starts
50ms:   Database initialized
100ms:  Parsers loaded
200ms:  File system scanned
500ms:  ✅ Ready!

Background (async):
+1s:    10% indexed
+5s:    100% indexed
+10s:   Cluster pre-computation done
```

**Key:** Agent can work while indexing happens!

**How to speed up:**
- Exclude unneeded directories (add `.mcpignore`)
- Reduce `MAX_CACHE_SIZE` if memory-constrained
- Use `ci` profile for smaller cache

---

### Q: How fast are searches?

**A:**

| Operation | Typical Time | Note |
|-----------|---|---|
| Search by filename | 50ms | Very fast (trigram index) |
| Search by symbol | 100ms | Fuzzy Levenshtein |
| Search by content | 200ms | Full-text with BM25F |
| Read skeleton | 80ms | 95% token savings |
| Edit (10 files) | 500ms | Atomic transaction |

**In practice:** Feels instant to humans.

---

### Q: Does Smart Context slow down my IDE?

**A:** 

✅ **No impact on IDE performance:**
- Runs as separate MCP server
- Uses its own memory/CPU
- Doesn't modify IDE internals

⚠️ **First startup:** 
- Indexing happens in background
- Might use 20-30% CPU for 5-10 seconds
- Don't worry—it's async

**Total overhead:** Negligible after first startup.

---

### Q: What's the maximum project size Smart Context can handle?

**A:**

| Project Size | Supported? | Notes |
|---|---|---|
| Small (<1K files) | ✅ | Instant startup |
| Medium (1K-10K) | ✅ | <1 second startup |
| Large (10K-100K) | ✅ | 5-30 second startup |
| Huge (100K+) | ✅ | 1-2 minute startup |

**Memory usage:** Constant ~200MB regardless of size.

**Example:** 100K file Google Chromium repo → 200MB RAM.

---

---

## Troubleshooting Questions

### Q: AI says "Tool not found"

**A:** Check these in order:

1. **Did you restart the client?** (Claude, Cursor, etc.)
   - Full quit + reopen (not just refresh)

2. **Is the path correct?**
   ```bash
   ls -la /path/to/your/project
   # Should show your project files
   ```

3. **Is Node.js installed?**
   ```bash
   node --version  # Should be v18+
   npx --version   # Should be v9+
   ```

4. **Check logs** (platform-specific):
   - Claude: Menu → Logs
   - Cursor: Output Panel → MCP

---

### Q: "Path is outside root directory"

**A:** Smart Context is sandboxed for security.

**Cause:** Trying to access files outside configured `cwd`.

**Fix:**
```json
// ❌ Too narrow
"cwd": "/Users/you/projects/my-app"

// ✅ Correct
"cwd": "/Users/you/projects"
```

---

### Q: "NO_MATCH" error when editing

**A:** Target string not found (whitespace/formatting differs).

**Recovery:**
1. Ask AI: "Show me the current content around line X"
2. Copy exact string including whitespace
3. Retry with `normalization: "whitespace"`

**Example:**
```json
{
  "normalization": "whitespace",  // Tolerates spacing differences
  "targetString": "const timeout = 5000;"
}
```

---

### Q: "AMBIGUOUS_MATCH" error

**A:** Multiple matches for target string (e.g., `return true;` appears 5 times).

**Recovery:**
```json
{
  "targetString": "return true;",
  "beforeContext": "if (isAdmin) {",  // Unique context
  "afterContext": "} else {",
  "lineRange": {"start": 40}
}
```

---

### Q: Database is slow / corrupted

**A:** 

**Slow:**
```bash
# Optimize database
sqlite3 .smart-context/index.db "VACUUM;"
```

**Corrupted:**
```bash
# Delete and rebuild
rm .smart-context/index.db
# Restart server (it rebuilds automatically)
```

---

### Q: How do I disable a specific language?

**A:** Create `languages.json`:

```json
{
  "typescript": { "enabled": true },
  "python": { "enabled": false },
  "ruby": { "enabled": false }
}
```

Then:
```bash
SMART_CONTEXT_LANGUAGE_CONFIG=./languages.json npx smart-context-mcp
```

---

---

## Best Practices

### Q: What's the most efficient workflow?

**A:** Follow **Navigate → Read → Change** (Six Pillars):

```
1. Navigate: navigate(context="definitions") ~100 tokens
2. Read:     read(view="skeleton")          ~150 tokens
3. Change:   change(dryRun=true)            ~100 tokens

Total: ~350 tokens

❌ Bad approach:
read(view="full") on 10 files = 50,000 tokens!

✅ Savings: 99% token reduction!
```

---

### Q: When should I use `dryRun=true`?

**A:** **Always for edits you haven’t reviewed yet** (especially multi-file).

```
1. Ask AI: "Here's what I want to change..."
2. AI: change(dryRun=true)     ← Preview first
3. You: "Looks good" or "Fix this..."
4. AI: change(dryRun=false)    ← Commit
```

**Risk of skipping dry-run:** Wrong changes committed.

---

### Q: How many files can I edit at once?

**A:** 

**Recommended:** 5-20 files per transaction

```json
{
  "edits": [
    { "filePath": "src/A.ts", ... },
    { "filePath": "src/B.ts", ... },
    // ...
    { "filePath": "src/T.ts", ... }
  ]
}
```

**Why batch?**
- Atomicity (all succeed or all fail)
- 3x faster than individual edits
- Better for reviewing diffs

---

### Q: What's the best way to do large refactorings?

**A:** Work in batches:

```
Batch 1: Rename in files 1-5  ← dryRun=true
         (review) ✅
         ← dryRun=false (commit)

Batch 2: Rename in files 6-10 ← dryRun=true
         (review) ✅
         ← dryRun=false (commit)

...repeat for all files
```

**Why?** Easier to review, less risk of failures.

---

---

## Still Have Questions?

- **Documentation:** [README.md](../README.md)
- **Getting Started:** [Getting Started Guide](./getting-started.md)
- **Configuration:** [Configuration Guide](./configuration.md)
- **Workflows:** [AGENT_PLAYBOOK.md](../agent/AGENT_PLAYBOOK.md)
- **MCP Standard:** [modelcontextprotocol.io](https://modelcontextprotocol.io/)

---

**Version:** 1.0.0  
**Last Updated:** 2025-12-14  
**Maintained by:** Smart Context MCP Team
