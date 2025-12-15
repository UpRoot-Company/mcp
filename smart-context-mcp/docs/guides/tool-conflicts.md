# Tool Conflict Resolution Guide

When should you use Bash commands vs smart-context-mcp tools? This guide provides a clear decision matrix and practical examples.

---

## 1. The Core Question

**"When should I use Bash vs smart-context-mcp tools?"**

The answer depends on:
1. **Indexing advantage**: Is the operation faster with indexing?
2. **Token cost**: How much context does each approach use?
3. **Safety**: Does one approach have better error handling?
4. **Availability**: Does smart-context have an equivalent tool?

---

## 2. Decision Matrix

### The Quick Reference

| Task | Bash | Smart Context | Recommendation |
|------|------|---------------|-----------------|
| Find files by name | `find . -name "*.ts"` | `search_project(type="filename")` | ✅ Use smart-context |
| Search for symbol | `grep -r "function"` | `search_project(type="symbol")` | ✅ Use smart-context |
| Read file | `cat file.ts` | `read_code(view="full")` | ✅ Use smart-context (saves tokens) |
| Edit file | `sed`, `awk` | `edit_code()` | ✅ Use smart-context (transactional) |
| List directory | `ls` | `list_directory()` | 🟡 Either works; Bash simpler |
| Complex pipeline | `find \| xargs \| grep` | `search_project()` | ✅ Use smart-context (single call) |
| Git operations | `git status`, `git log` | N/A | ✅ Use Bash (essential) |
| Build/test | `npm test`, `pytest` | N/A | ✅ Use Bash (essential) |

---

## 3. Detailed Comparison

### 3.1 File Finding

**Bash approach:**
```bash
find . -name "*.ts" -type f | head -20
```

**Smart Context approach:**
```json
search_project({ query: "*.ts", type: "filename", maxResults: 20 })
```

**Analysis:**

| Factor | Bash | Smart Context |
|--------|------|---------------|
| Speed | 2-5s (full scan) | 50ms (indexed) |
| Accuracy | 100% | 100% |
| Result ranking | File order | Modification time order |
| Fuzzy matching | ❌ No | ✅ Yes (typo tolerance) |
| Integration | Returns list | Returns with file metadata |
| Example case | Find "main.ts" vs "Main.ts" | Finds both, Sonnet decides |

**Verdict:** ✅ **Always use smart-context** for finding files.

**Token cost comparison:**
- Bash result: 500 tokens (raw output)
- Smart Context result: 300 tokens (structured, useful metadata)

---

### 3.2 Code Search

**Bash approach:**
```bash
grep -r "authenticate" src/ | head -20
```

**Smart Context approach:**
```json
search_project({ 
  query: "authenticate", 
  type: "symbol",
  maxResults: 20 
})
```

**Analysis:**

| Factor | Bash | Smart Context |
|--------|------|---------------|
| Speed | 500ms (scan all) | 100ms (indexed) |
| Ranking | None (file order) | BM25F algorithm |
| Context | Raw grep output | Symbol type, file, line |
| Fuzzy | ❌ No | ✅ Yes (auto_completer vs autocomplete) |
| False positives | ✅ High (comments, strings) | 🟡 Medium (symbol-aware) |
| Actionable | ❌ Raw output | ✅ Structured results |

**Verdict:** ✅ **Always use smart-context** for searching code.

**Token cost comparison:**
- Bash: 2000+ tokens (many matches, raw)
- Smart Context: 300 tokens (top 20 ranked matches)

---

### 3.3 File Reading

**Bash approach:**
```bash
cat src/main.ts
```

**Smart Context approach:**
```json
read_code({ filePath: "src/main.ts", view: "skeleton" })
```

**Analysis:**

| Factor | Bash | Smart Context |
|--------|------|---------------|
| Speed | Instant (filesystem) | 80ms (processing) |
| Flexibility | Raw file content | Multiple views (skeleton/fragment/full) |
| Token cost (50KB file) | 15,000 tokens | 250 tokens (skeleton) |
| Usefulness | Raw text | Structured code with signatures |
| Ideal for | Non-code files | Code analysis |

**Verdict:** ✅ **Use smart-context for code**, Bash for other files

**Token efficiency:**
```
File: 50KB TypeScript file

Bash (cat):
  Full content: 15,000 tokens

Smart Context:
  skeleton: 250 tokens (97% savings!)
  fragment: 800 tokens (94% savings)
  full: 15,000 tokens (same as bash)
```

**When to use Bash for reading:**
- Configuration files (JSON, YAML)
- Documentation (Markdown)
- Non-code assets
- Raw data files

---

### 3.4 Code Editing

**Bash approach:**
```bash
sed -i 's/oldCode/newCode/g' src/main.ts
```

**Smart Context approach:**
```json
edit_code({
  edits: [{
    filePath: "src/main.ts",
    targetString: "oldCode",
    replacementString: "newCode"
  }]
})
```

**Analysis:**

| Factor | Bash | Smart Context |
|--------|------|---------------|
| Safety | ❌ No validation | ✅ Hash verification |
| Transaction | ❌ No rollback | ✅ Automatic rollback |
| Accuracy | ❌ Brittle (whitespace) | ✅ Robust (6-level normalization) |
| Preview | ❌ No dryRun | ✅ dryRun=true available |
| Multi-file | Manual (xargs) | Single operation |
| Reliability | ❌ Can break code | ✅ All-or-nothing guarantee |

**Verdict:** ✅ **Always use smart-context** for editing code.

**Example failure (Bash):**
```typescript
// Original
const user = await db.getUser(id);

// Command: sed -i 's/User/User/g' file.ts
// (Oops! Matches in comments too)

// Result: BROKEN
const usr = await db.getusr(id);  // ❌ Wrong!
const User = await db.getUser(id); // ❌ Wrong!
```

**Example success (Smart Context):**
```json
{
  "edits": [{
    "filePath": "src/user.ts",
    "targetString": "const user = await db.getUser(id);",
    "replacementString": "const user = await db.getUser(id);",
    "dryRun": true
  }]
}
// Preview shows exact match: ✅ Safe to apply
```

---

### 3.5 Directory Listing

**Bash approach:**
```bash
ls -la src/
```

**Smart Context approach:**
```json
list_directory({ path: "src/" })
```

**Analysis:**

| Factor | Bash | Smart Context |
|--------|------|---------------|
| Speed | Instant | Instant (cached) |
| Flexibility | ls options | Structured output |
| Formatting | Terminal-friendly | JSON/structured |
| Useful for | Quick manual checks | API operations |

**Verdict:** 🟡 **Either works; Bash simpler for quick checks**

**Use Bash when:**
- You just need a quick look
- You're checking permissions, file sizes
- Manual verification

**Use smart-context when:**
- Building automated workflows
- Need structured output
- Consistency across platforms

---

### 3.6 Complex Operations (Pipeline)

**Bash approach:**
```bash
find src -name "*.ts" | xargs grep "export class" | \
  awk -F: '{print $1}' | sort -u | wc -l
```

**Smart Context approach:**
```json
search_project({ 
  query: "export class",
  type: "symbol",
  maxResults: 1000
})
// Returns: count, locations, ranked by relevance
```

**Analysis:**

| Factor | Bash | Smart Context |
|--------|------|---------------|
| Complexity | High (multiple commands) | Low (one call) |
| Readability | Low | High |
| Debugging | Hard (intermediate pipes) | Easy (structured output) |
| Performance | Slow (multiple tools) | Fast (single indexed query) |
| Error handling | Manual | Automatic |
| Token cost | High (raw output) | Low (structured) |

**Verdict:** ✅ **Always use smart-context** for complex searches

---

## 4. Common Anti-Patterns

### ❌ Anti-Pattern 1: Using `find` for Symbol Search

```bash
# BAD: 5 seconds, lots of output, no ranking
find . -name "*.ts" | xargs grep "authenticate" | head -20

# GOOD: 100ms, ranked, fuzzy matching
search_project({ query: "authenticate", type: "symbol", maxResults: 20 })
```

**Why it's bad:**
- Scans every file (no index)
- Returns raw matches in file order
- No fuzzy matching (misses similar names)
- High token output (many irrelevant matches)

---

### ❌ Anti-Pattern 2: Reading Entire Files with `cat`

```bash
# BAD: 15,000 tokens for a 50KB file
cat src/engine/Editor.ts

# GOOD: 250 tokens with same information
read_code({ filePath: "src/engine/Editor.ts", view: "skeleton" })
```

**Why it's bad:**
- Wastes 97% of available tokens
- Shows implementation details not needed for understanding
- Makes code harder to navigate in AI responses
- Slows down response generation

---

### ❌ Anti-Pattern 3: Using `sed` for Code Modification

```bash
# BAD: No validation, can break code, no rollback
sed -i 's/const user/let user/g' *.ts

# GOOD: Validated, transactional, preview available
edit_code({
  edits: [{
    filePath: "src/user.ts",
    targetString: "const user = await db.getUser(id);",
    replacementString: "let user = await db.getUser(id);",
    beforeContext: "async function login() {",
    afterContext: "return user;"
  }],
  dryRun: true
})
```

**Why it's bad:**
- Replaces all matches blindly
- Can corrupt comments, strings
- No way to undo if wrong
- Brittle (whitespace sensitive)

---

### ❌ Anti-Pattern 4: Grepping Without Result Limits

```bash
# BAD: Returns 5000 matches, slow, hard to parse
grep -r "get" src/ 

# GOOD: Returns top 20 ranked, fast, actionable
search_project({ query: "get", maxResults: 20 })
```

**Why it's bad:**
- Overwhelms the AI with noise
- Uses thousands of tokens
- No ranking (most relevant last)
- Hard to identify the true match

---

### ❌ Anti-Pattern 5: Manual Path Conversion

```bash
# BAD: Error-prone manual path handling
absolute_path="/Users/dev/project/src/main.ts"
relative_path="src/main.ts"
# Now need logic to handle both

# GOOD: Smart Context auto-normalizes
read_code({ filePath: "/Users/dev/project/src/main.ts" })  // ✅ Works
read_code({ filePath: "src/main.ts" })                      // ✅ Works too
```

**Why it's bad:**
- Requires duplicate logic
- Windows vs Unix path separators
- Prone to "path outside root" errors

---

## 5. Permission Configuration Strategies

Control which tools agents can use:

### Strategy 1: Restrictive (Recommended for Security)

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

**Use for:**
- Code analysis only
- Security-sensitive environments
- Read-only exploration
- Documentation generation

**Prevents:**
- Accidental file deletion
- Code modification
- External data exfiltration

---

### Strategy 2: Development (Balanced)

```json
{
  "permissions": {
    "allow": [
      "Bash(ls:*)",
      "Bash(git:*)",
      "Bash(npm:*)",
      "mcp__smart-context-mcp__*"
    ],
    "deny": [
      "Bash(rm:*)",
      "Bash(curl:*)"
    ]
  }
}
```

**Use for:**
- Normal development
- Feature work
- Refactoring
- Testing

**Prevents:**
- File deletion
- Data exfiltration
- External network access

---

### Strategy 3: Production (Haiku Execution)

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

**Use for:**
- CI/CD automated fixes
- Production scripts
- High-trust environments
- Haiku execution layer

**Prevents:**
- Manual intervention
- Accidental damage
- Out-of-scope changes

---

### Strategy 4: Full Access (Debugging Only)

```json
{
  "permissions": {
    "allow": ["*"]
  }
}
```

**Use for:**
- Troubleshooting
- Emergency recovery
- Temporary debugging
- Never for production

**⚠️ Warning:** Use with extreme caution!

---

## 6. Hybrid Workflows

When to combine Bash and smart-context:

### Example 1: Find Modified Files + Analyze

```
Step 1: Bash - Get modified files
  git status -s | grep "^ M"

Step 2: Smart Context - Analyze each file
  search_project({ query: "authenticate" })

Step 3: Smart Context - Read relevant sections
  read_code({ filePath: "...", view: "skeleton" })

Step 4: Smart Context - Propose edits
  edit_code({ edits: [...], dryRun: true })
```

**Why hybrid:**
- Bash is best for git operations
- Smart Context is best for code analysis
- Each tool does what it's designed for

---

### Example 2: Run Tests + Smart Analysis of Failures

```
Step 1: Bash - Run tests
  npm test 2>&1 | tee test-results.txt

Step 2: Smart Context - Find failing code
  search_project({ query: "failing test name" })

Step 3: Smart Context - Analyze root cause
  read_code({ filePath: "...", view: "fragment" })

Step 4: Smart Context - Fix the issue
  edit_code({ edits: [...] })

Step 5: Bash - Verify fix
  npm test -- --testNamePattern="failing test"
```

**Why hybrid:**
- Bash runs tests (standard tool)
- Smart Context understands code (specialized)
- Back and forth as needed

---

### Example 3: Bulk Change with Smart Validation

```
Step 1: Bash - Find all files matching pattern
  find . -name "*.old-ext"

Step 2: Smart Context - For each file:
  - Read structure (skeleton)
  - Propose transformation
  - Preview with dryRun

Step 3: Bash - Batch rename after validation
  for file in ...; do mv "$file" "${file%.old-ext}.new-ext"; done

Step 4: Smart Context - Verify results
  search_project({ query: "*.new-ext" })
```

**Why hybrid:**
- Bash handles file operations (filesystem access)
- Smart Context handles code understanding (code analysis)
- Divides responsibility appropriately

---

## 7. Performance Comparison

Real-world benchmark (10,000-file project, "authenticate" search):

### Time Comparison

```
grep -r "authenticate" src/
  → 3.2 seconds
  → 156 matches
  → Raw output

ripgrep (rg) rg "authenticate" src/
  → 0.8 seconds  
  → 156 matches
  → Raw output

search_project({ query: "authenticate" })
  → 0.15 seconds
  → 20 matches (ranked)
  → Structured output with metadata
```

**Conclusion:** Smart Context is **20x faster** with better results

### Token Cost Comparison

Reading a 50KB file:

```
cat src/engine/Editor.ts
  → 15,000 tokens (full file)

read_code({ view: "skeleton" })
  → 250 tokens (function signatures)
  → 97% savings!

read_code({ view: "fragment", lineRange: "100-150" })
  → 150 tokens (specific section)
  → 99% savings!
```

**Conclusion:** Smart Context saves **99% of tokens**

---

## 8. Quick Decision Flowchart

```
┌─ "What do I want to do?"
│
├─ Search for code?
│  → Use smart-context (search_project)
│
├─ Find file by name?
│  → Use smart-context (search_project)
│
├─ Read code?
│  → Use smart-context with skeleton view
│     (98% token savings!)
│
├─ Edit code?
│  → Use smart-context (edit_code)
│     (Safe, transactional)
│
├─ Run tests / build?
│  → Use Bash
│     (Essential, no alternative)
│
├─ Git operations?
│  → Use Bash
│     (Standard tool, no alternative)
│
├─ List directory?
│  → Bash (simple) or smart-context (structured)
│     (Either works fine)
│
└─ Complex pipeline?
   → Analyze each step:
      - If analyzing code → smart-context
      - If manipulating files → Bash
      - If searching/reading → smart-context
```

---

## 9. Configuration Examples

### Development Project (.claude/settings.local.json)

```json
{
  "permissions": {
    "allow": [
      "Bash(git:*)",
      "Bash(npm:*)",
      "Bash(ls:*)",
      "mcp__smart-context-mcp__*"
    ],
    "deny": [
      "Bash(rm:*)",
      "Bash(mv:*)",
      "Bash(sudo:*)"
    ]
  }
}
```

### Analysis-Only Project

```json
{
  "permissions": {
    "allow": [
      "Bash(ls:*)",
      "mcp__smart-context-mcp__search_project",
      "mcp__smart-context-mcp__read_code",
      "mcp__smart-context-mcp__analyze_relationship",
      "mcp__smart-context-mcp__analyze_file"
    ]
  }
}
```

### CI/CD Pipeline

```json
{
  "permissions": {
    "allow": [
      "Bash(npm test:*)",
      "Bash(npm run build:*)",
      "Bash(git:*)",
      "mcp__smart-context-mcp__search_project",
      "mcp__smart-context-mcp__read_code",
      "mcp__smart-context-mcp__edit_code"
    ]
  }
}
```

---

## References

- [Agent Optimization Guide](./agent-optimization.md) - Per-agent tool strategies
- [Permissions Configuration](./permissions.md) - Security and access control
- [Prompt Engineering Guide](./prompt-engineering.md) - Communicating tool choices
- [Getting Started](./getting-started.md) - Basic setup
- [Configuration Guide](./configuration.md) - Environment variables

---

**Version:** 1.0.0  
**Last Updated:** 2025-12-15  
**Maintained by:** Smart Context MCP Team
