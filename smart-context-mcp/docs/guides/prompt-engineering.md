# Prompt Engineering Guide for Smart Context MCP

This guide shows AI agents how to formulate effective requests to smart-context-mcp for maximum efficiency and reliability.

---

## 1. Core Principles

Three principles that unlock 90% of smart-context's power:

### Principle 1: Scout Before You Read

**Bad approach:**
```json
{
  "tool": "read_code",
  "filePath": "src/auth/manager.ts"
}
// User: "Analyze authentication"
// Result: Massive file dump, token waste
```

**Good approach:**
```json
// First: Search to understand what exists
{
  "tool": "search_project",
  "query": "authenticate",
  "type": "symbol",
  "maxResults": 10
}

// Then: Read only what matters
{
  "tool": "read_code",
  "filePath": "src/auth/manager.ts",
  "view": "skeleton"
}

// Finally: Deep dive if needed
{
  "tool": "read_code",
  "filePath": "src/auth/manager.ts",
  "view": "fragment",
  "lineRange": "45-78"
}
```

**Why it works:**
- 100ms search finds the right file
- Skeleton view shows structure (250 tokens)
- Fragment shows details (800 tokens)
- Total: 1,050 tokens vs 15,000 (7x more efficient)

### Principle 2: Use Skeleton by Default

**Token savings comparison for a 50KB file:**

```
view="full"      → 15,000 tokens (100%)
view="skeleton"  → 250 tokens (1.7%)
view="fragment"  → 800 tokens (5.3%)
```

**When to use each:**

| View | Use When | Token Cost |
|------|----------|------------|
| `skeleton` | Exploring structure | 1.7% |
| `fragment` | Targeting specific lines | 5% |
| `full` | File is <10 lines | 100% |

### Principle 3: Use contextual clues to avoid ambiguity

```json
// Bad: Too generic
{
  "targetString": "return true;"
}
// Result: AMBIGUOUS_MATCH (found 47 times)

// Good: Add context to disambiguate
{
  "targetString": "return true;",
  "beforeContext": "if (isValidUser(user)) {",
  "afterContext": "} else {"
}
// Result: Single match, unambiguous
```

---

## 2. Prompt Templates for Common Tasks

### Template 1: Symbol Rename Across Files

**Goal:** Safely rename a symbol (function, class, const) throughout the codebase.

**Step-by-step prompt:**

```
Task: Rename "validateUser" to "authenticateUser"

Step 1: Find all occurrences
Use: search_project({
  query: "validateUser",
  type: "symbol",
  maxResults: 50
})
Analysis: How many results? In which files?

Step 2: Review each occurrence
For each file in results:
  Use: read_code({
    filePath: "...",
    view: "skeleton"
  })
  Question: Is this a definition or usage?

Step 3: Create edit plan
Create edits with specific context for each:
  - Function definition (rename declaration)
  - All call sites (update calls)
  - Type exports (update types)

Step 4: Preview changes
Use: edit_code({
  edits: [...],
  dryRun: true
})
Question: Does the preview look correct?

Step 5: Apply changes
Use: edit_code({
  edits: [...],
  dryRun: false
})

Step 6: Verify
Use: search_project({
  query: "validateUser",
  type: "symbol"
})
Question: Any remaining occurrences? (Should be 0)
```

---

### Template 2: Impact Analysis

**Goal:** Understand what breaks if we change module X.

**Step-by-step prompt:**

```
Task: Analyze impact of changing authentication module

Step 1: Analyze downstream impact
Use: analyze_relationship({
  target: "src/auth/AuthService.ts",
  mode: "impact",
  direction: "downstream",
  maxDepth: 3
})
Result: Understand what depends on this module

Step 2: Read the module skeleton
Use: read_code({
  filePath: "src/auth/AuthService.ts",
  view: "skeleton"
})
Result: Understand the public interface

Step 3: For each impacted file
Use: read_code({
  filePath: "src/controller/UserController.ts",
  view: "skeleton"
})
Result: Understand each dependent

Step 4: Assess risk level
Based on:
- How many files depend on this? (Count from Step 1)
- How deeply integrated? (Read from Step 3)
- Breaking changes possible? (Compare interfaces)

Risk assessment:
- Low: <5 files, superficial integration
- Medium: 5-20 files, some integration
- High: >20 files, deep integration
```

---

### Template 3: Bug Fix Workflow

**Goal:** Locate, understand, and fix a specific bug.

**Step-by-step prompt:**

```
Task: Fix the login bug in v2.3

Step 1: Search for relevant code
Use: search_project({
  query: "login",
  type: "symbol",
  maxResults: 20
})
Result: Find auth-related code

Step 2: Identify the issue
Use: read_code({
  filePath: "src/auth/login.ts",
  view: "skeleton"
})
Result: Understand function structure

Step 3: Deep dive into the bug
Use: read_code({
  filePath: "src/auth/login.ts",
  view: "fragment",
  lineRange: "34-56"
})
Result: See the problematic code

Step 4: Check related files
Use: search_project({
  query: "validateToken",
  type: "symbol"
})
Then read those files to understand context

Step 5: Plan the fix
Create edit with:
- Exact line number (lineRange)
- Surrounding context (beforeContext/afterContext)
- Clear before/after comparison

Step 6: Preview the fix
Use: edit_code({
  edits: [{
    filePath: "src/auth/login.ts",
    targetString: "...",
    replacementString: "...",
    beforeContext: "...",
    afterContext: "..."
  }],
  dryRun: true
})

Step 7: Apply the fix
Use: edit_code({
  edits: [...],
  dryRun: false
})

Step 8: Verify
Use: search_project({ query: "..." })
to ensure the fix doesn't have side effects
```

---

### Template 4: Code Quality Audit

**Goal:** Review code for patterns, anti-patterns, and improvements.

**Step-by-step prompt:**

```
Task: Audit error handling in the API layer

Step 1: Find all error handlers
Use: search_project({
  query: "catch",
  type: "symbol",
  maxResults: 50
})

Step 2: Group by file
Review which files have error handling

Step 3: Read representative samples
For each file:
  Use: read_code({
    filePath: "src/routes/users.ts",
    view: "skeleton"
  })

Step 4: Deeper analysis
Use: read_code({
  filePath: "...",
  view: "fragment",
  lineRange: "..."
})
Focus on error handling patterns

Step 5: Document findings
- Pattern 1: Good practices (exemplar)
- Pattern 2: Inconsistencies (refactor)
- Pattern 3: Missing error handling (add)

Step 6: Plan improvements
Create changes to standardize error handling

Step 7: Preview and apply
Use dryRun first, then apply
```

---

## 3. Multi-Turn Conversation Patterns

### Pattern 1: Progressive Refinement

Perfect for exploring unfamiliar code:

```
Turn 1: Scout
  User: "Find authentication-related code"
  AI: search_project({ query: "authenticate" })
  
Turn 2: Understand structure
  User: "Show me the main auth file structure"
  AI: read_code({ view: "skeleton" })
  
Turn 3: Understand details
  User: "Tell me how login works"
  AI: read_code({ view: "fragment", lineRange: "..." })
  
Turn 4: Plan changes
  User: "How would we add OAuth2 support?"
  AI: Analyzes, proposes structure
  
Turn 5: Execute
  User: "Create the OAuth2 file with basic setup"
  AI: edit_code({ dryRun: true })
  
Turn 6: Verify
  User: "Good, now integrate it with the login function"
  AI: edit_code({ ... })
```

**Why it works:** Each turn builds on previous understanding

---

### Pattern 2: Batch Processing

When handling many similar items:

```
Turn 1: Identify all items
  search_project({ query: "...", maxResults: 100 })
  → Returns: Files A-Z that need fixes

Turn 2: Read summaries
  read_code({ view: "skeleton" })
  for each file
  → Understand patterns

Turn 3: Plan batch 1 (files A-J)
  → Create edits for first 10 files
  → Use dryRun: true

Turn 4: Apply batch 1
  → Edit actual files

Turn 5: Verify batch 1
  → Check that changes worked

Turn 6-10: Repeat for batches 2-5

Turn 11: Final verification
  search_project({ query: "..." })
  → Confirm all items processed
```

**Why it works:**
- Divide large tasks into chunks
- Verify each batch
- Stop if issues appear
- Resume without repeating

---

## 4. Agent-Specific Prompt Variations

### For Claude Haiku (Small Context, Speed-Optimized)

```
Prompting style: Explicit and sequential

USER PROMPT EXAMPLE:
"Rename getUserId to getCurrentUserId:

Step 1: Execute this:
search_project({ query: "getUserId", type: "symbol", maxResults: 10 })

Step 2: For each result, read skeleton view

Step 3: Plan edits with beforeContext/afterContext

Step 4: Preview with dryRun: true

Step 5: Apply"

Why: Haiku needs explicit steps, can't infer as well
```

### For Claude Sonnet 4.5 (Recommended Default)

```
Prompting style: Natural flow with inference

USER PROMPT EXAMPLE:
"Find and refactor the authentication service.
Start with a search to understand the scope.
Show me the structure.
Then propose refactoring approach."

Why: Sonnet 4.5 is the recommended default - best balance of intelligence, speed, and cost
```

### For Claude Opus 4.5 (Maximum Intelligence)

```
Prompting style: Detailed, open-ended

USER PROMPT EXAMPLE:
"Comprehensively analyze the authentication architecture.
Consider security implications, performance, and maintainability.
Identify all edge cases and potential improvements.
Propose comprehensive refactoring strategy with clear priority."

Why: Opus 4.5 provides highest intelligence for complex specialized tasks
```

### For GPT-4o (Explicit Prompting)

```
Prompting style: Numbered steps, detailed

USER PROMPT EXAMPLE:
"Please optimize the database queries:

1. Use search_project to find all database calls
2. Read skeleton view of each file
3. Identify N+1 query patterns
4. For each pattern found, read the full context
5. Plan optimized version with beforeContext/afterContext
6. Execute with dryRun: true first
7. Review and apply"

Why: GPT-4o needs explicit structure
```

### For Gemini 3 Pro (Advanced Reasoning)

```
Prompting style: Deep analysis, open-ended

USER PROMPT EXAMPLE:
"Comprehensively analyze this codebase:
- Identify architectural patterns and anti-patterns
- Assess code quality and maintainability
- Propose improvements with trade-off analysis
- Prioritize refactoring efforts"

Why: Gemini 3 Pro excels at complex reasoning and architectural analysis
```

### For Gemini 2.0 Flash (Bulk Operations)

```
Prompting style: Bulk-first, all at once

USER PROMPT EXAMPLE:
"Across all 10,000 files:
- Find all deprecated API calls
- Categorize by type
- Generate replacement code for each category
- Show statistics and examples"

Why: Gemini 2.0 Flash's 1M context and speed excel at bulk operations
```

### For Codex (OpenAI - Agentic)

```
Prompting style: Agentic with extended thinking

USER PROMPT EXAMPLE:
"Analyze the authentication system comprehensively:
1. Search for auth-related code
2. Understand the architecture
3. Identify security issues
4. Propose refactoring plan

Use extended thinking for deep analysis."

Why: Codex excels at autonomous reasoning and long-horizon agentic tasks
```

---

## 5. Error Recovery Prompts

When tools return errors, specific recovery strategies:

### NO_MATCH Error

**Error:** "Target string not found"

**Common causes:**
1. Whitespace differs (tabs vs spaces)
2. Code changed since last read
3. String not exactly matched

**Recovery prompt:**

```
"NO_MATCH error occurred. Let me recover:

Step 1: Re-read the actual file content:
read_code({ filePath: "...", view: "fragment", lineRange: "..." })

Step 2: Show me the exact line text:
(Copy exact content)

Step 3: Try again with exact string and normalization:
edit_code({
  targetString: "EXACT_COPY_FROM_ABOVE",
  replacementString: "...",
  normalization: "whitespace"
})"
```

---

### AMBIGUOUS_MATCH Error

**Error:** "Found 5 matches for target string"

**Common causes:**
1. Generic string (e.g., "return true;")
2. Need more context to disambiguate

**Recovery prompt:**

```
"AMBIGUOUS_MATCH - multiple matches found. Let me disambiguate:

Step 1: Read context around each match:
read_code({ filePath: "...", view: "fragment", lineRange: "..." })

Step 2: Use beforeContext/afterContext to uniquify:
edit_code({
  targetString: "...",
  beforeContext: "...",  // Add this
  afterContext: "...",   // Add this
  lineRange: { start: X, end: Y }
})"
```

---

### PERMISSION_DENIED Error

**Error:** "Tool not available" or "Path outside root"

**Recovery prompt:**

```
"Permission denied. Let me check configuration:

1. This tool may be restricted in settings
2. Or path is outside the configured root

Check:
- .claude/settings.local.json permissions
- Project root configuration
- Path is relative to root"
```

---

## 6. Token Optimization Techniques

### Technique 1: Skeleton-First Exploration

```
Savings: 95-98%
When: Always for initial exploration

Flow:
1. search_project()         ← 100-500 tokens
2. read_code(skeleton)      ← 250-500 tokens per file
3. read_code(fragment) if needed ← 800 tokens
4. Only then read_code(full) if absolutely needed

Total: 1,050 tokens vs 15,000 (7x savings)
```

---

### Technique 2: Fragment Over Full

```
Savings: 85-90%
When: You know the approximate line range

Instead of:
  read_code({ view: "full" })

Use:
  read_code({ view: "fragment", lineRange: "45-78" })

Benefit: Get specific code without full file overhead
```

---

### Technique 3: Limit Search Results

```
Savings: 50-70%
When: Initial search for exploration

Instead of:
  search_project({ query: "..." })  // Returns 1000 results

Use:
  search_project({ query: "...", maxResults: 20 })  // Returns 20 results

Benefit: Focuses on most relevant matches, reduces output
```

---

### Technique 4: Batch Related Edits

```
Savings: Reduces transaction overhead
When: Multiple files need same change

Instead of:
  5 separate edit_code() calls

Use:
  1 edit_code() with 5 edits in array:
  edit_code({
    edits: [
      { filePath: "file1.ts", ... },
      { filePath: "file2.ts", ... },
      { filePath: "file3.ts", ... },
      { filePath: "file4.ts", ... },
      { filePath: "file5.ts", ... }
    ]
  })

Benefit: Single validation pass, cleaner output
```

---

### Technique 5: Use Normalization for Robust Matching

```
When: Whitespace is uncertain

edit_code({
  targetString: "const x = 5;",
  replacementString: "let x = 5;",
  normalization: "whitespace"  // Ignores spacing
})
```

---

## 7. Quality Checklist

Before calling any tool, ask:

### Pre-Search Checklist
- [ ] Is search the right first step?
- [ ] Have I scoped the query specifically?
- [ ] Is my maxResults reasonable (10-100)?
- [ ] Will results be actionable?

### Pre-Read Checklist
- [ ] Did I search first to find the right file?
- [ ] Am I starting with skeleton view?
- [ ] Do I need the full view, or is fragment enough?
- [ ] Is this code I need to read, or configuration?

### Pre-Edit Checklist
- [ ] Did I read the file first?
- [ ] Is my targetString unique (or have I added context)?
- [ ] Have I specified beforeContext/afterContext?
- [ ] Will I use dryRun: true first to preview?
- [ ] Does this change match my intention?

### Context Budget Checklist
- [ ] Am I within my context window budget?
- [ ] Could I achieve this with fewer tokens?
- [ ] Should I batch operations to stay under budget?
- [ ] Is there a more efficient approach?

---

## 8. Real-World Examples

### Example 1: Fixing a Bug in 30 Seconds

```
User: "The login is broken. Users can't authenticate."

AI's thought process:
1. Search for relevant code (100ms, 200 tokens)
2. Read skeleton (100ms, 250 tokens)
3. Identify issue in fragment view (100ms, 300 tokens)
4. Fix with dryRun (100ms, no token cost)
5. Apply fix (100ms, no token cost)

Total: 400ms, 750 tokens, bug fixed ✅
```

---

### Example 2: Large Refactor in 5 Turns

```
Turn 1: Scout
  "Find all authentication code"
  → search_project() + read_code(skeleton)

Turn 2: Analyze impact
  "What depends on auth module?"
  → analyze_relationship(mode="impact")

Turn 3: Plan refactor
  "Propose refactoring approach"
  → Design based on analysis

Turn 4: Preview changes
  "Create the refactoring edits"
  → edit_code(dryRun=true)

Turn 5: Apply
  "Looking good, apply the changes"
  → edit_code(dryRun=false)
```

---

### Example 3: Performance Optimization

```
Scenario: "Project has N+1 database queries"

1. Find all DB calls
   search_project({ query: "query(", type: "symbol" })

2. Read patterns
   read_code({ view: "skeleton" })

3. Identify N+1 patterns
   Analyze structure

4. Fix each pattern
   edit_code({ edits: [...], dryRun: true })

5. Verify
   search_project() to check coverage
```

---

## 9. Common Pitfalls and How to Avoid Them

| Pitfall | Wrong | Right |
|---------|-------|-------|
| Reading before searching | `read_code(fullPath)` | `search_project()` first |
| Using full view always | `read_code(view="full")` | Start with `skeleton` |
| Generic search strings | `grep "get"` | `search_project(maxResults=20)` |
| No context in edits | `targetString: "x = 1"` | Add `beforeContext`, `afterContext` |
| Not using dryRun | `edit_code(dryRun=false)` | Always preview first with `dryRun=true` |
| Too many results | `maxResults: 1000` | Use `maxResults: 20-50` |
| Manual path conversion | Handle both absolute/relative | Smart Context handles it automatically |

---

## References

- [Agent Optimization Guide](./agent-optimization.md) - Model-specific strategies
- [Tool Conflict Resolution](./tool-conflicts.md) - When to use Bash vs smart-context
- [Permissions Configuration](./permissions.md) - Tool access control
- [Getting Started](./getting-started.md) - Basic setup
- [AGENT_PLAYBOOK.md](../agent/AGENT_PLAYBOOK.md) - Workflow patterns

---

**Version:** 1.0.0  
**Last Updated:** 2025-12-15  
**Maintained by:** Smart Context MCP Team
