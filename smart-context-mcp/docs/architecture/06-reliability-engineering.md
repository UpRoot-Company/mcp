# Reliability Engineering

**Transactional safety, crash recovery, error handling, and architectural safety guarantees.**

---

## 1. ACID Transactions Explained

### Problem Statement

Agent requests to modify 5 files:
```
edit_code({
  edits: [
    { filePath: "src/a.ts", targetString: "...", ... },
    { filePath: "src/b.ts", targetString: "...", ... },
    { filePath: "src/c.ts", targetString: "...", ... },
    { filePath: "src/d.ts", targetString: "...", ... },
    { filePath: "src/e.ts", targetString: "...", ... }
  ]
})
```

What if server crashes after modifying file 3?
- Files a, b, c are modified ✓
- Files d, e are NOT modified ✗
- **Result: Broken state!**

### ACID Guarantees

**Atomicity:** All edits succeed or ALL fail (no partial state)
**Consistency:** Database remains valid after transaction
**Isolation:** Concurrent transactions don't interfere
**Durability:** Committed changes survive server crash

### Transaction Lifecycle

```
STATE 1: SNAPSHOT
├─ Agent calls: edit_code([5 edits])
├─ Server captures:
│  - Original file content
│  - Hash of each file (xxHash64)
│  - Timestamp
└─ Assign transaction ID (UUID)

STATE 2: VALIDATE
├─ For each edit:
│  ├─ Search for target string
│  ├─ Score match confidence (0.0-1.0)
│  ├─ Check: Is confidence > threshold?
│  └─ If NO: Abort entire transaction
└─ If all pass: Proceed

STATE 3: APPLY
├─ For each edit (in-memory only):
│  ├─ Create copy of file
│  ├─ Apply replacement
│  ├─ Parse to check syntax
│  └─ If syntax error: Abort
└─ All modifications in RAM (NOT on disk)

STATE 4: VERIFY
├─ Hash new content
├─ If expectedHash provided: Compare
│  └─ If mismatch: Abort (corruption detected)
└─ All safety checks passed

STATE 5: COMMIT
├─ Write all files to disk
├─ Append to transaction log: "COMMITTED"
├─ Update indexes
└─ Return transaction ID to agent

ROLLBACK (if any stage fails)
├─ Keep original files on disk (unchanged)
├─ Append to transaction log: "ROLLED_BACK"
└─ Return error with reason
```

### Visual State Diagram

```
                    SNAPSHOT
                       ↓
         ┌─────────────────────────┐
         │   VALIDATE all edits    │
         │  match & confidence OK? │
         └──────────┬──────────────┘
                    ↓
         ┌─────────────────────────┐
         │  APPLY in memory only   │
         │ (check syntax parsing)  │
         └──────────┬──────────────┘
                    ↓
         ┌─────────────────────────┐
         │  VERIFY hash & safety   │
         │  (if expectedHash set)  │
         └──────────┬──────────────┘
                    ↓
         ┌─────────────────────────┐
         │   COMMIT to disk        │
         │  Write all files        │
         │  Update transaction log │
         │  Return success         │
         └─────────────────────────┘
         
         ERROR at any stage:
         ├─ Discard RAM changes
         ├─ Leave files untouched
         ├─ Log transaction as ROLLED_BACK
         └─ Return error message
```

### Implementation

**From src/engine/EditCoordinator.ts (lines 100-250):**

```typescript
async executeTransaction(edits: Edit[], dryRun: boolean): Promise<TransactionResult> {
  const txnId = generateUUID();
  
  // STATE 1: SNAPSHOT
  const snapshots = await Promise.all(
    edits.map(edit => this.captureSnapshot(edit.filePath))
  );
  
  // STATE 2: VALIDATE
  const validation = await Promise.all(
    edits.map((edit, i) => this.validateEdit(edit, snapshots[i]))
  );
  
  if (validation.some(v => !v.valid)) {
    return {
      success: false,
      error: "Validation failed",
      details: validation.map(v => v.reason)
    };
  }
  
  // STATE 3: APPLY (in memory)
  const results = [];
  const appliedContent = new Map<string, string>();
  
  for (const edit of edits) {
    try {
      const original = snapshots.find(s => s.path === edit.filePath)!.content;
      const modified = this.applyEdit(original, edit);
      
      // Syntax check
      this.parser.parse(modified);  // Throws on syntax error
      appliedContent.set(edit.filePath, modified);
      results.push({ filePath: edit.filePath, success: true });
    } catch (e) {
      return {
        success: false,
        error: "Syntax error after edit",
        failedFile: edit.filePath,
        originalError: e.message
      };
    }
  }
  
  // STATE 4: VERIFY
  for (const [filePath, content] of appliedContent) {
    const edit = edits.find(e => e.filePath === filePath)!;
    if (edit.expectedHash) {
      const hash = xxHash64(content);
      if (hash !== edit.expectedHash.value) {
        return {
          success: false,
          error: "Hash verification failed",
          filePath: filePath
        };
      }
    }
  }
  
  // STATE 5: COMMIT
  if (!dryRun) {
    // Write to disk
    for (const [filePath, content] of appliedContent) {
      await fs.writeFile(filePath, content);
    }
    
    // Update transaction log
    await this.transactionLog.append({
      id: txnId,
      status: 'committed',
      timestamp: Date.now(),
      snapshots: snapshots
    });
  }
  
  return {
    success: true,
    transactionId: txnId,
    filesModified: appliedContent.size,
    dryRun: dryRun
  };
}
```

---

## 2. Crash Recovery Mechanism

### Problem Statement

Server crashes during STATE 4 (after writing file 3 of 5):
- Disk contains: files a, b, c (modified), d, e (original)
- Transaction log: pending (not committed)
- **On restart: How do we know what to fix?**

### Solution: Write-Ahead Logging (WAL)

**Before writing ANY file, log the operation:**

```
Transaction Log (in SQLite):
┌─────────────────────────────────────────┐
│ id: "txn-abc123"                        │
│ status: "pending"                       │
│ snapshots: [                            │
│   { path: "a.ts", originalContent: "..." },
│   { path: "b.ts", originalContent: "..." },
│   { path: "c.ts", originalContent: "..." },
│   { path: "d.ts", originalContent: "..." },
│   { path: "e.ts", originalContent: "..." }
│ ]                                       │
└─────────────────────────────────────────┘
```

### Recovery Procedure

**On server startup:**

```typescript
async function recoverPendingTransactions() {
  const pending = await transactionLog.getPending();
  
  for (const txn of pending) {
    // Check: Are files in partially modified state?
    const currentHashes = await Promise.all(
      txn.snapshots.map(s => hashFile(s.path))
    );
    
    const originalHashes = txn.snapshots.map(s => hashContent(s.originalContent));
    
    if (currentHashes === originalHashes) {
      // Case 1: Crash BEFORE any writes
      // → Nothing to do, transaction already rolled back
      await transactionLog.markAs(txn.id, 'rolled_back');
    } else {
      // Case 2: Crash AFTER some writes but BEFORE commit
      // → Restore original content
      for (const snapshot of txn.snapshots) {
        await fs.writeFile(snapshot.path, snapshot.originalContent);
      }
      await transactionLog.markAs(txn.id, 'rolled_back');
      console.log(`Recovered transaction ${txn.id}: Rolled back all changes`);
    }
  }
}
```

### Timeline Example

```
Normal Execution:
  0ms  ├─ Editor: edit_code([5 edits])
  1ms  ├─ Server: SNAPSHOT captured
  5ms  ├─ Server: VALIDATE checks pass
 10ms  ├─ Server: APPLY in memory
 15ms  ├─ Server: VERIFY hashes
 20ms  ├─ Server: Write file a.ts ✓
 21ms  ├─ Server: Write file b.ts ✓
 22ms  ├─ Server: Write file c.ts ✓
 23ms  ├─ Server: Write file d.ts ✓
 24ms  ├─ Server: Write file e.ts ✓
 25ms  ├─ Server: Append to transaction log "COMMITTED"
 26ms  └─ Server: Return success

Crash Scenario:
  0ms  ├─ Editor: edit_code([5 edits])
  1ms  ├─ Server: SNAPSHOT captured
  5ms  ├─ Server: VALIDATE checks pass
 10ms  ├─ Server: APPLY in memory
 15ms  ├─ Server: VERIFY hashes
 20ms  ├─ Server: Write file a.ts ✓
 21ms  ├─ Server: Write file b.ts ✓
 22ms  ├─ Server: Write file c.ts ✓
 23ms  ├─ 💥 CRASH 💥 (before committing)
       │
       ├─ Server restarts
       ├─ Find pending transaction in log
       ├─ Check file hashes: a/b/c modified, d/e original
       ├─ RESTORE a/b/c from snapshots
       └─ Mark transaction as "rolled_back"
```

---

## 3. Error Enhancement System

### Problem Statement

Agent runs:
```
edit_code({
  filePath: "src/auth.ts",
  targetString: "validatePassword(user.password)",
  replacementString: "validatePassword(user.pwd)"
})
```

Server returns:
```
{ success: false, error: "NO_MATCH" }
```

**Not helpful!** Agent doesn't know:
- Was the function name wrong?
- Was the variable name wrong?
- Does the function exist?

### Solution: Error Enhancement

**Return helpful context:**

```typescript
interface EnhancedError {
  code: "NO_MATCH" | "AMBIGUOUS_MATCH" | "SYNTAX_ERROR";
  message: string;
  
  // Helpful suggestions
  similarSymbols?: string[];    // "Did you mean: validateEmail?"
  similarFiles?: string[];      // "Found in: src/validators.ts"
  nextActionHint?: string;      // "Try search_project first"
  toolSuggestions?: ToolSuggestion[];  // "Use analyze_relationship"
}
```

### Implementation

**From src/errors/ErrorEnhancer.ts (lines 50-200):**

```typescript
class ErrorEnhancer {
  enhanceNoMatchError(
    targetString: string,
    filePath: string,
    context: EditContext
  ): EnhancedError {
    // Try to find similar symbols
    const similarSymbols = this.findSimilarSymbols(targetString, 5);
    
    // Try to find the function in other files
    const similarFiles = this.findFilesContaining(targetString);
    
    // Determine next step
    let nextAction = "Verify the exact text you're searching for";
    if (similarSymbols.length > 0) {
      nextAction = `Did you mean: ${similarSymbols[0]}?`;
    } else if (similarFiles.length > 0) {
      nextAction = `This code exists in: ${similarFiles.join(", ")}`;
    }
    
    return {
      code: "NO_MATCH",
      message: `Could not find "${targetString}" in ${filePath}`,
      similarSymbols: similarSymbols,
      similarFiles: similarFiles,
      nextActionHint: nextAction,
      toolSuggestions: [
        {
          toolName: "search_project",
          rationale: "Find the exact code you want to modify",
          exampleArgs: { query: targetString }
        },
        {
          toolName: "read_code",
          rationale: "Inspect the file to see actual content",
          exampleArgs: { filePath: filePath, view: "skeleton" }
        }
      ]
    };
  }
  
  enhanceAmbiguousMatchError(
    matches: Match[],
    targetString: string
  ): EnhancedError {
    return {
      code: "AMBIGUOUS_MATCH",
      message: `Found ${matches.length} matches for "${targetString}"`,
      nextActionHint: `Provide beforeContext or afterContext to disambiguate`,
      toolSuggestions: [
        {
          toolName: "read_code",
          rationale: "View surrounding context",
          exampleArgs: { filePath: matches[0].filePath, view: "fragment" }
        }
      ]
    };
  }
  
  private findSimilarSymbols(query: string, limit: number): string[] {
    // Use Levenshtein distance to find similar symbol names
    const allSymbols = this.symbolIndex.getAllSymbols();
    const distances = allSymbols.map(sym => ({
      name: sym.name,
      distance: levenshteinDistance(query, sym.name)
    }));
    
    return distances
      .filter(d => d.distance < 3)  // Typos only
      .sort((a, b) => a.distance - b.distance)
      .slice(0, limit)
      .map(d => d.name);
  }
}
```

---

## 4. Safety Mechanisms

### Hash Verification (TOCTOU Prevention)

**Time-of-check-time-of-use attack:**
```
1. Agent reads file: "const x = 1;"
2. Other process modifies file: "const x = 2;"
3. Agent applies edit based on old content → WRONG!
```

**Solution: Hash verification**
```typescript
// 1. Agent reads and hashes
read_code({ filePath: "config.ts" })
→ Content: "const x = 1;"
→ Hash: xxHash64(...) = "abc123"

// 2. Agent tries to edit
edit_code({
  filePath: "config.ts",
  targetString: "1",
  replacementString: "2",
  expectedHash: { algorithm: "xxhash", value: "abc123" }
})

// 3. Server verifies
if (currentHash !== expectedHash) {
  throw Error("File changed since read!");
}
```

### Path Sandboxing (Directory Traversal Prevention)

**Malicious agent tries:**
```javascript
edit_code({
  filePath: "../../../../etc/passwd",
  ...
})
```

**Prevention:**
```typescript
function validateFilePath(filePath: string, projectRoot: string): boolean {
  const normalized = path.normalize(path.join(projectRoot, filePath));
  const realPath = fs.realpathSync(normalized);
  
  if (!realPath.startsWith(projectRoot)) {
    throw Error("Path outside project root!");
  }
  
  return true;
}
```

### Confidence Scoring

Never silently apply risky edits. Always score confidence:

```typescript
interface MatchResult {
  found: boolean;
  confidence: number;  // 0.0 (no match) to 1.0 (perfect match)
  matchType: 'exact' | 'normalization' | 'fuzzy';
  
  shouldApply(): boolean {
    // Only apply if high confidence
    return this.confidence > 0.95;  // Configurable threshold
  }
}
```

---

## 5. Testing Strategy

### Unit Test Patterns

**Using MemoryFileSystem for isolation:**

```typescript
describe("Transaction Safety", () => {
  let fs: MemoryFileSystem;
  let coordinator: EditCoordinator;
  
  beforeEach(() => {
    fs = new MemoryFileSystem();
    coordinator = new EditCoordinator(fs);
  });
  
  it("should rollback all changes on failure", async () => {
    fs.writeFile("a.ts", "content a");
    fs.writeFile("b.ts", "content b");
    
    const result = await coordinator.executeTransaction([
      { filePath: "a.ts", targetString: "a", replacementString: "A" },
      { filePath: "b.ts", targetString: "WRONG", replacementString: "B" }  // Will fail
    ]);
    
    expect(result.success).toBe(false);
    expect(fs.readFile("a.ts")).toBe("content a");  // Unchanged
    expect(fs.readFile("b.ts")).toBe("content b");  // Unchanged
  });
  
  it("should commit all changes on success", async () => {
    fs.writeFile("a.ts", "content a");
    fs.writeFile("b.ts", "content b");
    
    const result = await coordinator.executeTransaction([
      { filePath: "a.ts", targetString: "a", replacementString: "A" },
      { filePath: "b.ts", targetString: "b", replacementString: "B" }
    ]);
    
    expect(result.success).toBe(true);
    expect(fs.readFile("a.ts")).toBe("content A");
    expect(fs.readFile("b.ts")).toBe("content B");
  });
});
```

### Integration Test Scenarios

1. **Normal execution** - All edits apply
2. **Partial failure** - One edit fails, all rolled back
3. **Crash recovery** - Simulate crash, verify recovery
4. **Concurrent edits** - Multiple transactions in parallel
5. **Large batch** - 100+ edits in one transaction

---

## 6. Performance-Safety Tradeoff

| Setting | Safety | Speed | When to Use |
|---------|--------|-------|-------------|
| **strict** | ⭐⭐⭐⭐⭐ Highest | 🐌 Slowest | Production code |
| **normal** | ⭐⭐⭐⭐ High | ⚡ Fast | Default |
| **force** | ⭐⭐ Low | ⚡⚡⚡ Fastest | Quick changes |

**Configuration:**
```bash
SMART_CONTEXT_SAFETY_LEVEL=normal  # strict | normal | force
```

---

## See Also

- [02-core-engine.md](./02-core-engine.md) - Database architecture
- [03-tools-and-workflows.md](./03-tools-and-workflows.md) - Workflow examples
- [../guides/FAQ.md](../guides/FAQ.md) - Common questions about safety
- [../guides/CONTRIBUTING.md](../guides/CONTRIBUTING.md) - Testing guidelines
