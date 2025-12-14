# Tools and Workflows

**Practical guide to using Smart Context tools for real-world development tasks.**

---

## Tool Catalog (Human-Readable)

### search_project - Find Code Anywhere

**What it does:** Searches your entire codebase using BM25F ranking and fuzzy matching.

**When to use:**
- Looking for a function/class you can't quite remember the name of
- Finding all files related to a feature (e.g., all authentication code)
- Exploring an unfamiliar codebase
- Locating error messages or specific patterns

**How it works:**
1. Breaks your search into trigrams (3-character chunks)
2. Matches against all file names, symbol definitions, and comments
3. Ranks results by relevance (exact matches score highest)
4. Returns file paths with line numbers and preview snippets

**Tips:**
- Be specific: "validateUser" finds more relevant results than "validate"
- Use quotes for phrases: "user authentication flow"
- Narrow results with file type: `search_project({ query: "auth", fileTypes: ["ts"] })`
- Start with `type: "symbol"` for code definitions
- Use `type: "file"` for finding actual files

**Example: Find all auth-related code**
```
search_project({ query: "auth", maxResults: 20 })
→ Returns auth.ts, middleware/auth.ts, types/auth.ts, etc.
```

---

### read_code - Understand File Structure

**What it does:** Retrieves file content in three modes: full, skeleton (folded), or line ranges.

**When to use:**
- Understanding a module's public interface
- Getting an overview of a large file without reading all details
- Examining specific functions after finding them with search_project
- Preparing for editing (dry-run reading)

**How it works:**
1. **skeleton** mode: Parse file to AST, fold all function/class bodies with `{ ... }`
2. **full** mode: Return complete file content
3. **fragment** mode: Extract specific line ranges

**Token Savings:**
- Skeleton: 95-98% savings (15 tokens vs 500+ for a 500-line file)
- Fragment: 85-92% savings (200 tokens vs 2000 for a 100-line range)

**Tips:**
- Always start with **skeleton** view for large files
- Use **fragment** if skeleton shows you need to examine a specific section
- Use **full** only when you really need every line

**Example: Understand a class structure**
```
read_code({ filePath: "src/Engine.ts", view: "skeleton" })
→ Shows class definition, method signatures, property types
→ Total ~400 tokens (vs 5000+ for full file)
```

---

### edit_code - Modify Code Safely

**What it does:** Make code changes with transactional safety, fuzzy matching, and rollback support.

**When to use:**
- Renaming functions/variables across files
- Updating error messages
- Adding/removing parameters
- Large refactoring (callback to async, pattern conversion, etc.)
- Creating new files or deleting obsolete ones

**How it works:**
1. Takes snapshot of original file (for rollback)
2. Searches for your target string with 6-level normalization (exact → fuzzy)
3. Makes replacement in memory, validates syntax
4. Writes to disk only if all validations pass
5. Records transaction for undo/redo

**Safety Features:**
- Hash verification (detects if file changed since you read it)
- Normalization levels (exact match, then whitespace tolerant, then structural)
- Syntax validation (parses result to ensure no breaking changes)
- Context matching (beforeContext/afterContext for ambiguous cases)
- Transaction logging (can roll back multiple files at once)

**Tips:**
- **ALWAYS** use `dryRun: true` first to preview changes
- Provide `beforeContext` and `afterContext` for ambiguous targets
- Group related edits into one call (they're atomic)
- Start with `normalization: "exact"`, relax if no match found

**Example: Rename function across 3 files**
```
edit_code({
  dryRun: true,
  edits: [
    { filePath: "src/auth.ts", operation: "replace",
      targetString: "export function validateEmail",
      replacementString: "export function isValidEmail" },
    { filePath: "src/middleware.ts", operation: "replace",
      targetString: "validateEmail(req.user.email)",
      replacementString: "isValidEmail(req.user.email)" },
    { filePath: "src/tests/auth.test.ts", operation: "replace",
      targetString: "validateEmail('test@example.com')",
      replacementString: "isValidEmail('test@example.com')" }
  ]
})
→ Preview changes (no actual writes)
→ If looks good: remove dryRun: true and execute
```

---

### analyze_relationship - Understand Impact

**What it does:** Maps out how code is connected (who imports what, who calls whom, type hierarchies).

**When to use:**
- Before refactoring: understanding scope of changes
- Finding all callers of a function
- Tracing where a variable is used
- Understanding type hierarchies (interfaces → implementations)
- Checking for circular dependencies

**How it works:**
1. Builds graph of connections between files/symbols
2. Traverses graph in specified direction (upstream/downstream/both)
3. Returns network of related nodes with relationship types

**Relationship Types:**
- `import`: File A imports from File B
- `calls`: Function A calls Function B
- `implements`: Class A implements Interface B
- `extends`: Class A extends Class B

**Tips:**
- Start with `maxDepth: 2` to limit results
- Use `direction: "upstream"` for "who imports this"
- Use `direction: "downstream"` for "what does this import"
- Check results before large refactoring

**Example: Check impact of changing auth.ts**
```
analyze_relationship({ 
  target: "src/auth.ts", 
  mode: "impact",
  maxDepth: 3 
})
→ Shows all files that import auth.ts (direct and transitive)
→ Understand if this change affects 1 file or 50 files
```

---

### analyze_file - Get File Summary

**What it does:** Generates comprehensive profile of a file: size, complexity, dependencies, symbols.

**When to use:**
- Quick assessment: "Should I read this file in full or skeleton?"
- Understanding complexity before refactoring
- Finding which files import/use this file
- Getting all symbols in a file before selecting specific ones

**Returns:**
- Metadata: line count, language, file size
- Structure: skeleton view + symbol list
- Complexity: function count, nesting depth
- Dependencies: incoming imports + outgoing imports
- Guidance: suggestions for how to read the file

**Example:**
```
analyze_file({ filePath: "src/Engine.ts" })
→ metadata: 1231 lines, TypeScript, 45KB
→ structure: 3 classes, 12 interfaces, 5 utilities
→ complexity: 47 functions, max nesting depth 4
→ usage: imported by 23 files, imports 8 files
→ guidance: "Read skeleton first, too large for full view"
```

---

### get_batch_guidance - Plan Multi-File Edits

**What it does:** Analyzes multiple files and suggests how to group/order edits for safety.

**When to use:**
- Planning edits across 5+ files
- Ensuring dependencies are handled in correct order
- Understanding which files to edit together (shared state)

**Returns:**
- **Clusters**: Groups of files that should be edited together
- **Companion Suggestions**: Files you might have forgotten to update
- **Opportunities**: Automated refactoring suggestions (add imports, add traits)

**Example:**
```
get_batch_guidance({ 
  filePaths: [
    "src/User.ts", 
    "src/Database.ts", 
    "src/API.ts",
    "src/Tests.ts"
  ] 
})
→ Cluster 1: User.ts + Database.ts (tight coupling)
→ Cluster 2: API.ts (depends on Cluster 1)
→ Cluster 3: Tests.ts (can be done last)
→ Suggestion: Update "export" in User.ts first
```

---

## Real-World Workflows

### Workflow 1: Bug Fix (Beginner)

**Goal:** Find and fix a specific error message

**Scenario:** Users report "Invalid token" errors. You want to make the error message more helpful.

**Steps:**
```
1. FIND
   search_project({ 
     query: "Invalid token",
     type: "file"
   })
   → Finds: src/middleware/auth.ts:45

2. UNDERSTAND
   read_code({
     filePath: "src/middleware/auth.ts",
     view: "fragment",
     lineRange: "40-60"
   })
   → See the error message context and surrounding code

3. FIX (with preview)
   edit_code({
     dryRun: true,
     edits: [{
       filePath: "src/middleware/auth.ts",
       operation: "replace",
       targetString: 'throw new Error("Invalid token");',
       replacementString: 'throw new Error("Invalid or expired token. Please log in again.");'
     }]
   })
   → Review the diff

4. APPLY
   edit_code({
     dryRun: false,
     edits: [{
       filePath: "src/middleware/auth.ts",
       operation: "replace",
       targetString: 'throw new Error("Invalid token");',
       replacementString: 'throw new Error("Invalid or expired token. Please log in again.");'
     }]
   })
   → Changes applied

5. VERIFY
   search_project({ query: "Invalid token" })
   → Should show 0 results (replaced)
```

**Token Cost:** ~2000-3000 total
**Time:** 2-3 minutes
**Risk:** Very low (single string replacement with context)

---

### Workflow 2: Feature Addition (Intermediate)

**Goal:** Add a new "search" parameter to an API endpoint

**Scenario:** API endpoint `/api/users` currently supports filtering by `active` status. You want to add `search` parameter.

**Steps:**
```
1. FIND THE ENDPOINT
   search_project({
     query: "GET /api/users",
     type: "symbol"
   })
   → Finds: src/routes/users.ts:12 - getUsersHandler

2. UNDERSTAND THE STRUCTURE
   read_code({
     filePath: "src/routes/users.ts",
     view: "skeleton"
   })
   → See all route handlers, middleware, imports

3. EXAMINE IMPLEMENTATION
   read_code({
     filePath: "src/routes/users.ts",
     view: "fragment",
     lineRange: "12-45"
   })
   → See getUsersHandler implementation

4. FIND RELATED FILES
   analyze_file({
     filePath: "src/routes/users.ts"
   })
   → usage: shows database.ts (0 imports), services/userService.ts imports
   → Understand what files interact with this

5. CHECK IMPACT
   analyze_relationship({
     target: "src/routes/users.ts",
     mode: "impact",
     maxDepth: 2
   })
   → Understand which files depend on this route

6. PLAN EDITS
   get_batch_guidance({
     filePaths: [
       "src/routes/users.ts",
       "src/services/userService.ts",
       "src/tests/users.test.ts"
     ]
   })
   → Shows which files should be edited together

7. MAKE CHANGES (in batches)
   edit_code({
     dryRun: true,
     edits: [
       { filePath: "src/routes/users.ts", 
         operation: "replace",
         targetString: "export function getUsersHandler(req, res) {\n  const active = req.query.active;",
         replacementString: "export function getUsersHandler(req, res) {\n  const active = req.query.active;\n  const search = req.query.search;" },
       { filePath: "src/services/userService.ts",
         operation: "replace",
         targetString: "export function getUsers(active) {",
         replacementString: "export function getUsers(active, search) {" }
     ]
   })
   → Review all changes at once

8. APPLY
   edit_code({
     dryRun: false,
     edits: [/* same edits */]
   })

9. VERIFY
   analyze_relationship({
     target: "getUsersHandler",
     mode: "calls",
     maxDepth: 1
   })
   → Find all callers and verify they pass new param
```

**Token Cost:** ~5000-8000 total
**Time:** 5-10 minutes
**Risk:** Medium (API change requires testing)

---

### Workflow 3: Large Refactoring (Advanced)

**Goal:** Convert callback-based error handling to async/await across 50+ functions

**Scenario:** Legacy codebase uses `(err, result) => {}` callbacks everywhere. You want to modernize to async/await.

**Steps:**
```
1. SEARCH FOR TARGETS
   search_project({
     query: "callback",
     maxResults: 100
   })
   → Find all files with callback patterns

2. ANALYZE SCOPE
   get_batch_guidance({
     filePaths: [/* all 50+ files */],
     pattern: "callback-to-async"
   })
   → Get clusters: which files edit together
   → Get order: which must be done first

3. PLAN REFACTORING (Phase 1: Utilities)
   get_batch_guidance({
     filePaths: ["src/utils/db.ts", "src/utils/http.ts"]
   })
   → These are leaf functions with no dependents
   → Edit these first

4. REFACTOR UTILITIES (Phase 1)
   edit_code({
     dryRun: true,
     edits: [
       { filePath: "src/utils/db.ts",
         operation: "replace",
         targetString: "function query(sql, callback) {\n  /* callback(err, result) */\n}",
         replacementString: "async function query(sql) {\n  /* return result (throws on error) */\n}",
         normalization: "structural"
       }
       /* ... 5-10 more utilities ... */
     ]
   })
   → Review all changes for Phase 1

   edit_code({
     dryRun: false,
     edits: [/* same as dryRun */]
   })

5. VERIFY PHASE 1
   analyze_relationship({
     target: "src/utils/db.ts",
     mode: "impact",
     maxDepth: 5
   })
   → Check if any broken calls exist

6. REFACTOR CALLERS (Phase 2)
   get_batch_guidance({
     filePaths: ["src/middleware.ts", "src/routes.ts"]
   })
   → These files call the utilities
   → Now refactor their callbacks to await

7. REPEAT FOR EACH CLUSTER
   For each cluster in batch guidance:
     a. read_code(skeleton) all files
     b. edit_code(dryRun) for first file in cluster
     c. Verify with analyze_relationship
     d. edit_code(final) when confident

8. FINAL VERIFICATION
   search_project({ query: "callback" })
   → Should find 0 results (all converted)

   manage_project({ command: "status" })
   → Check no unresolved imports
```

**Token Cost:** ~20,000-40,000+ total (10+ phases)
**Time:** 2-4 hours
**Risk:** Very high (behavioral change, requires extensive testing)
**Safety:** Use phase-by-phase approach with checkpoints

---

## Integration Workflows

### Integration 1: Pre-Commit Hook

**Goal:** Prevent commits with console.log statements

**Setup:**
```bash
#!/bin/bash
# .git/hooks/pre-commit

# Find any console.log in staged files
CONSOLE_LOGS=$(git diff --cached --name-only | \
  xargs -I {} search_project({ query: "console.log", filePaths: ["{}"] }))

if [ ! -z "$CONSOLE_LOGS" ]; then
  echo "❌ Error: Found console.log statements:"
  echo "$CONSOLE_LOGS"
  exit 1
fi

echo "✅ No console.log found. Proceeding with commit."
exit 0
```

---

### Integration 2: CI/CD Pipeline

**Goal:** Detect API breaking changes before merge

**GitHub Actions Workflow:**
```yaml
name: Breaking Change Detection

on: [pull_request]

jobs:
  check-breaking-changes:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v2
        with:
          fetch-depth: 0
      
      - name: Analyze API Changes
        run: |
          git diff main...HEAD --name-only | \
          xargs -I {} smart-context analyze_file {}
          
          # Check for removed exports
          REMOVED=$(git diff main...HEAD | grep "^-export " | wc -l)
          if [ $REMOVED -gt 0 ]; then
            echo "❌ Breaking change: $REMOVED exports removed"
            exit 1
          fi
      
      - name: Check Dependency Changes
        run: |
          for file in $(git diff main...HEAD --name-only); do
            smart-context analyze_relationship \
              --target $file \
              --mode impact \
              --maxDepth 3
          done
```

---

### Integration 3: Code Review Bot

**Goal:** Automated pre-review suggestions

**Workflow:**
```
On PR created:
1. analyze_relationship() on all modified files
   → Check for circular dependencies
   → Check for unexpected cross-module access

2. get_batch_guidance() on all modified files  
   → Check for missing companion file updates
   → Suggest ordering of file reviews

3. For each file:
   a. analyze_file() → get complexity metrics
   b. If complexity increased: suggest simplification
   c. If new API: suggest updating tests

4. Comment on PR with findings
```

---

## Workflow Selection Guide

| Situation | Recommended Workflow | Tools |
|-----------|---------------------|-------|
| **Fix a bug** | Bug Fix (Beginner) | search_project → read_code → edit_code |
| **Add a feature** | Feature Addition (Intermediate) | analyze_file → get_batch_guidance → edit_code |
| **Refactor pattern** | Large Refactoring (Advanced) | search_project → get_batch_guidance → multi-phase edit_code |
| **Understand API** | Dependency Analysis | analyze_relationship → read_code |
| **Onboard to new code** | Code Exploration | search_project → read_code (skeleton) → analyze_file |
| **Check impact** | Pre-refactor Verification | analyze_relationship (impact mode) → get_batch_guidance |
| **Rename symbol** | Large Refactoring | search_project → analyze_relationship → get_batch_guidance → edit_code |

---

## Performance Tips for Each Workflow

**For Bug Fix:**
- Use `search_project` with specific keywords
- Use `read_code` (skeleton) first
- edit_code with `dryRun: true` initially

**For Feature Addition:**
- Use `analyze_file` before editing
- Use `get_batch_guidance` to order edits
- Group all edits in single edit_code call

**For Large Refactoring:**
- Break into phases by dependency order
- Use `get_batch_guidance` to cluster files
- Test Phase 1 before proceeding to Phase 2
- Use `dryRun: true` for every phase

---

## See Also

- [TOOL_REFERENCE.md](../agent/TOOL_REFERENCE.md) - Detailed API reference
- [02-core-engine.md](./02-core-engine.md) - How the engine works internally
- [../guides/integration.md](../guides/integration.md) - IDE and tool integration
