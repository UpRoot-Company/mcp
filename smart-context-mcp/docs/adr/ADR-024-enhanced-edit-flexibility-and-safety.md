# ADR-024: Enhanced Edit Flexibility and Safety

**Status:** Proposed
**Date:** 2025-12-13
**Author:** Architecture Team
**Related:** ADR-009 (Editor Engine Matching), ADR-020 (Toolset Consolidation), ADR-023 (Architectural Gaps)

---

## Executive Summary

Based on extensive real-world usage by GEMINI agent, the current `edit_code` tool demonstrates a critical tension: **safety through strictness vs. flexibility through tolerance**. While the tool's atomic transaction safety (ADR-023) and structural understanding capabilities are exemplary, its rigid matching algorithm and dangerous delete operations create significant friction in practical workflows.

This ADR proposes a **confidence-based matching system** with **graduated normalization levels** and **safe delete operations** to address the "개떡같이 말해도 찰떡같이 알아듣는" (understand intent despite imperfect input) principle that GEMINI identified as missing.

**Core Innovation:** Transform matching from binary (success/failure) to graduated (0-1 confidence) with transparent diagnostics, enabling agents to work effectively while maintaining safety guarantees.

---

## Context

### Real-World Agent Feedback (GEMINI's Assessment)

GEMINI agent completed a complex membership management refactoring and provided comprehensive feedback:

#### 👍 **Strengths Identified**
1. **Structural Understanding (read_code)**: Skeleton/fragment views provide excellent code navigation
2. **Transaction Safety**: Atomic rollback prevents partial edits, avoiding "엉거주춤" (half-baked) states

#### 👎 **Critical Pain Points**
1. **"지나친 매칭 강박증" (Excessive Matching Rigidity)**
   - Quote: *"targetString이 파일 내용과 토씨 하나, 공백 하나만 달라도 가차 없이 Target not found를 뱉어냅니다"*
   - Translation: "Even a single character or whitespace difference results in unforgiving 'Target not found' errors"
   - Fuzzy modes exist but still fail on CRLF/LF differences, minor indentation variations
   - Result: Agents enter a costly **read → copy → edit → fail → re-read** loop

2. **"대규모 리팩토링의 피로도" (Large Refactoring Fatigue)**
   - For structural changes, `edit_code` becomes cumbersome
   - Multi-file operations require too many small, tedious edits
   - Quote: *"차라리 write_file로 덮어쓰는 게 속 편할 때가 많았습니다"* ("Often easier to just overwrite with write_file")

3. **"삭제 연산의 위험성" (Delete Operation Danger)**
   - Quote: *"_findTargetMembership 함수를 지우려다 파일 전체가 날아간 사건은 치명적이었습니다"*
   - Translation: "The incident where attempting to delete _findTargetMembership function wiped the entire file was catastrophic"
   - Delete operations bypass EditorEngine safety checks

4. **Insufficient Tolerance**
   - Quote: *"'눈(Read)'은 밝으나 '손(Edit)'은 너무 뻣뻣하다"* ("The 'eye' is bright but the 'hand' is too stiff")
   - Needs more "여유(Tolerance)" - flexibility to understand developer intent

### Technical Root Cause Analysis

#### Issue #1: Binary Matching Logic (`src/engine/Editor.ts:599-698`)

**Current Implementation:**
```typescript
private findMatch(content: string, edit: Edit, lineCounter: LineCounter): Match {
    // ... matching logic ...

    if (filteredMatches.length === 0) {
        throw new MatchNotFoundError(...)  // ❌ Hard failure
    }
    if (filteredMatches.length > 1) {
        throw this.generateAmbiguousMatchError(...)  // ❌ Hard failure
    }

    return filteredMatches[0];  // Only exact single match succeeds
}
```

**Problems:**
- Requires **exactly one match** - no tolerance for uncertainty
- No confidence scoring - can't express "75% confident this is correct"
- No partial match resolution
- Context filtering (`beforeContext`/`afterContext`) is mandatory and exact

**Normalization Tiers (lines 631-649):**
```typescript
const attempts = this.getNormalizationAttempts(edit.normalization);
// Only 3 levels: "exact" → "whitespace" → "structural"
```

**Gap:** Missing intermediate levels like "line-endings", "trailing", "indentation"

#### Issue #2: Dangerous Delete Operations (`src/index.ts:1140-1173`)

**Current Implementation:**
```typescript
private async handleDeleteOperations(...) {
    for (const edit of edits) {
        // Only checks file existence
        if (!await this.pathExists(absPath)) {
            throw new McpError(...)
        }

        if (!dryRun) {
            previousContent = await this.fileSystem.readFile(absPath);
            await this.fileSystem.deleteFile(absPath);  // ⚠️ IMMEDIATE DELETION
            // ... rollback setup ...
        }
    }
}
```

**Critical Gaps:**
- ❌ No hash verification (unlike replace operations which have `expectedHash`)
- ❌ No file size/importance checks
- ❌ No confirmation mechanism
- ❌ Bypasses EditorEngine transaction safety
- ❌ Rollback errors silently swallowed (`src/engine/EditCoordinator.ts:67`)

**Comparison to Replace Operations:**
| Feature | Replace | Delete |
|---------|---------|--------|
| Hash verification | ✅ `expectedHash` | ❌ None |
| EditorEngine validation | ✅ Full AST | ❌ Bypassed |
| Transaction log | ✅ Integrated | ❌ Basic rollback only |
| Dry-run preview | ✅ Full diff | ⚠️ Generic message |

#### Issue #3: Fuzzy Mode Limitations (`src/engine/Editor.ts:260-413`)

**Levenshtein Mode Constraints:**
- 256 character maximum for `targetString`
- 30% tolerance (not configurable)
- Performance bottlenecks (5000ms timeout, 100k operation limit)
- No intelligent candidate ranking

**Whitespace Mode Issues:**
- Only collapses spaces, doesn't normalize tabs vs. spaces
- Context matching doesn't use fuzzy mode (lines 661-681)
- No detection of overly broad matches

### Validation from Existing Code

**Evidence of Existing Infrastructure:**
- ✅ `IndexDatabase` already uses SQLite WAL mode (can be shared for transactions)
- ✅ `TrigramIndex` exists but not integrated with matching (ADR-023 discovery)
- ✅ Hash computation already implemented (`Editor.ts:708-714`)
- ✅ Backup system exists but not used by rollback (`Editor.ts:88-92`)

---

## Decision

### Core Principle: Confidence-Based Matching

**Philosophy Shift:** From "exact match or fail" to "score all candidates and select best with transparency"

### Four-Pillar Enhancement Strategy

#### **Pillar 1: Confidence Scoring System**
- Assign 0-1 confidence scores to all matches
- Enable transparent diagnostics ("Match found with 85% confidence")
- Support future ML-based intent recognition

#### **Pillar 2: Graduated Normalization Levels**
- Expand from 3 to 6 normalization tiers
- Clear semantic progression: exact → line-endings → trailing → indentation → whitespace → structural
- Per-level tolerance configuration

#### **Pillar 3: Safe Delete Operations**
- Mandatory hash verification for files > 10KB or 100 lines
- Dry-run preview with content summary
- Transaction log integration (leveraging IndexDatabase)

#### **Pillar 4: Large Refactoring Workflows**
- Batch operation guidance
- Refactoring pattern suggestions
- Progressive refinement support

---

## Implementation

### Phase 1: Confidence Scoring System

#### New Type Definitions (`src/types.ts`)

```typescript
export interface MatchConfidence {
    /** Confidence score 0.0 (no match) to 1.0 (perfect match) */
    score: number;

    /** Match type that produced this result */
    matchType: 'exact' | 'whitespace' | 'structural' | 'levenshtein';

    /** Normalization level used */
    normalizationLevel: NormalizationLevel;

    /** Boost from context constraints */
    contextBoost: number;

    /** Boost from line range constraints */
    lineRangeBoost: number;

    /** Explanation for debugging */
    reason?: string;
}

export interface Match {
    start: number;
    end: number;
    replacement: string;
    original: string;
    lineNumber: number;
    matchType: 'exact' | 'normalization' | 'whitespace-fuzzy' | 'levenshtein';

    /** NEW: Always present confidence metadata */
    confidence?: MatchConfidence;
}
```

#### Confidence Computation Algorithm (`src/engine/Editor.ts`)

```typescript
private computeMatchConfidence(
    match: Match,
    edit: Edit,
    matchType: Match['matchType'],
    normalizationLevel: NormalizationLevel
): MatchConfidence {
    let baseScore = 0.5;

    // Base score by match type
    switch (matchType) {
        case 'exact':
            baseScore = 1.0;
            break;
        case 'normalization':
            // Graduated by normalization level
            const levelScores: Record<NormalizationLevel, number> = {
                'exact': 1.0,
                'line-endings': 0.95,
                'trailing': 0.90,
                'indentation': 0.85,
                'whitespace': 0.80,
                'structural': 0.70
            };
            baseScore = levelScores[normalizationLevel] || 0.5;
            break;
        case 'whitespace-fuzzy':
            baseScore = 0.75;
            break;
        case 'levenshtein':
            // Distance-based scoring
            const distance = levenshtein.get(edit.targetString, match.original);
            const maxAllowed = Math.floor(edit.targetString.length * 0.3);
            baseScore = 0.5 + (0.5 * (1 - distance / (maxAllowed || 1)));
            break;
    }

    // Context boosts (evidence of correct location)
    let contextBoost = 0;
    if (edit.beforeContext && this.contextMatches(match, edit, 'before')) {
        contextBoost += 0.15;
    }
    if (edit.afterContext && this.contextMatches(match, edit, 'after')) {
        contextBoost += 0.15;
    }

    // Line range boost (narrows search space)
    const lineRangeBoost = edit.lineRange ? 0.10 : 0;

    // Index range boost (most precise)
    const indexRangeBoost = edit.indexRange ? 0.20 : 0;

    const finalScore = Math.min(1.0,
        baseScore + contextBoost + lineRangeBoost + indexRangeBoost
    );

    return {
        score: finalScore,
        matchType,
        normalizationLevel,
        contextBoost,
        lineRangeBoost,
        reason: this.generateConfidenceReason(finalScore, matchType)
    };
}

private generateConfidenceReason(score: number, matchType: string): string {
    if (score >= 0.95) return "Exact match with strong constraints";
    if (score >= 0.85) return "High confidence with context validation";
    if (score >= 0.70) return "Good match with normalization";
    if (score >= 0.50) return "Acceptable fuzzy match";
    return "Low confidence - consider adding context";
}
```

#### Enhanced Error Diagnostics

```typescript
private generateMatchFailureDiagnostics(
    content: string,
    edit: Edit,
    allMatches: Match[],
    filteredMatches: Match[],
    context: { normalizationAttempts: { level: NormalizationLevel; matchCount: number }[] }
): string {
    const lines: string[] = [
        `❌ Match failed for target: "${edit.targetString.substring(0, 50)}..."`,
        ``,
        `📊 Matching Attempt Summary:`,
    ];

    // Show normalization attempt results
    for (const attempt of context.normalizationAttempts) {
        const emoji = attempt.matchCount > 0 ? '✓' : '✗';
        lines.push(`  ${emoji} ${attempt.level}: ${attempt.matchCount} matches`);
    }

    if (allMatches.length > 0) {
        lines.push(``, `🔍 Found ${allMatches.length} potential matches (filtered to 0):`);

        // Score and display top candidates
        const scoredMatches = allMatches.map(m => ({
            match: m,
            confidence: this.computeMatchConfidence(m, edit, m.matchType, 'structural')
        }));

        scoredMatches.sort((a, b) => b.confidence.score - a.confidence.score);

        for (const { match, confidence } of scoredMatches.slice(0, 3)) {
            lines.push(
                `  Line ${match.lineNumber}: ${(confidence.score * 100).toFixed(0)}% confidence`,
                `    Reason: ${confidence.reason}`,
                `    Context: ${match.original.substring(0, 60)}...`
            );
        }

        lines.push(``, `💡 Suggestions:`);
        if (!edit.lineRange && scoredMatches[0].confidence.score > 0.6) {
            lines.push(`  • Add lineRange: { start: ${scoredMatches[0].match.lineNumber}, end: ${scoredMatches[0].match.lineNumber} }`);
        }
        if (!edit.beforeContext && !edit.afterContext) {
            lines.push(`  • Add beforeContext or afterContext to disambiguate`);
        }
        if (edit.normalization === 'exact') {
            lines.push(`  • Try normalization: "whitespace" for flexible matching`);
        }
    } else {
        lines.push(``, `❓ No matches found at any normalization level`);
        lines.push(``, `💡 Suggestions:`);
        lines.push(`  • Verify targetString exists in file`);
        lines.push(`  • Try fuzzyMode: "levenshtein" for typo tolerance`);
        lines.push(`  • Check for invisible characters (tabs, CRLF)`);
    }

    return lines.join('\n');
}
```

---

### Phase 2: Graduated Normalization Levels

#### New Normalization Hierarchy (`src/types.ts`)

```typescript
export type NormalizationLevel =
    | "exact"           // Perfect byte-for-byte match
    | "line-endings"    // Tolerate CRLF ↔ LF only
    | "trailing"        // + Ignore trailing whitespace per line
    | "indentation"     // + Normalize tabs ↔ spaces (configurable width)
    | "whitespace"      // + Collapse internal whitespace sequences
    | "structural";     // + Ignore blank lines, full structural match

export interface NormalizationConfig {
    level: NormalizationLevel;

    /** For "indentation" mode: how many spaces per tab? */
    tabWidth?: number;  // Default: 4

    /** For "whitespace" mode: preserve leading indentation? */
    preserveIndentation?: boolean;  // Default: true
}

// Extend Edit interface
export interface Edit {
    // ... existing fields ...

    /** Enhanced normalization with configuration */
    normalization?: NormalizationLevel;
    normalizationConfig?: NormalizationConfig;
}
```

#### Normalization Implementation (`src/engine/Editor.ts`)

```typescript
private normalizeString(
    str: string,
    config: NormalizationConfig = { level: 'exact' }
): string {
    const { level, tabWidth = 4, preserveIndentation = true } = config;

    switch (level) {
        case "exact":
            return str;

        case "line-endings":
            // CRLF → LF normalization only
            return str.replace(/\r\n/g, '\n');

        case "trailing":
            // + Remove trailing whitespace per line
            return str
                .replace(/\r\n/g, '\n')
                .split('\n')
                .map(line => line.trimEnd())
                .join('\n');

        case "indentation":
            // + Normalize tabs ↔ spaces
            return str
                .replace(/\r\n/g, '\n')
                .split('\n')
                .map(line => {
                    const indent = line.match(/^\s*/)?.[0] || '';
                    const content = line.substring(indent.length);

                    // Convert tabs to spaces
                    const normalizedIndent = indent
                        .replace(/\t/g, ' '.repeat(tabWidth));

                    return normalizedIndent + content.trimEnd();
                })
                .join('\n');

        case "whitespace":
            // + Collapse internal whitespace
            if (preserveIndentation) {
                return str
                    .replace(/\r\n/g, '\n')
                    .split('\n')
                    .map(line => {
                        const match = line.match(/^(\s*)(.*)/);
                        if (!match) return line;
                        const [, indent, content] = match;
                        // Preserve indent, collapse content whitespace
                        return indent + content.replace(/\s+/g, ' ').trim();
                    })
                    .join('\n');
            } else {
                // Full whitespace collapse
                return str
                    .replace(/\r\n/g, '\n')
                    .split('\n')
                    .map(line => line.trim())
                    .join('\n')
                    .replace(/\s+/g, ' ');
            }

        case "structural":
            // + Remove blank lines, full structural match
            return str
                .replace(/\r\n/g, '\n')
                .split('\n')
                .map(line => line.trim())
                .filter(line => line.length > 0)
                .join('\n')
                .replace(/\s+/g, ' ');

        default:
            return str;
    }
}

// Updated normalization attempts
private getNormalizationAttempts(preferred?: NormalizationLevel): NormalizationLevel[] {
    const hierarchy: NormalizationLevel[] = [
        'exact',
        'line-endings',
        'trailing',
        'indentation',
        'whitespace',
        'structural'
    ];

    if (!preferred) return hierarchy;

    // Try from exact up to preferred level
    const maxIndex = hierarchy.indexOf(preferred);
    return hierarchy.slice(0, maxIndex + 1);
}
```

---

### Phase 3: Safe Delete Operations

#### Enhanced Delete Operation Types (`src/types.ts`)

```typescript
export type SafetyLevel = "strict" | "normal" | "force";

export interface EditCodeEdit {
    operation: "create" | "replace" | "delete";
    filePath: string;

    // For create/replace
    content?: string;
    targetString?: string;
    replacementString?: string;
    // ... other edit fields ...

    // NEW: Delete operation safety
    confirmationHash?: string;  // SHA256 hash to confirm deletion intent
    safetyLevel?: SafetyLevel;  // Default: "strict"
}

export interface EditCodeResult {
    success: boolean;
    message?: string;
    results: Array<{
        filePath: string;
        applied: boolean;
        diff?: string;
        error?: string;

        // NEW: Delete-specific metadata
        requiresConfirmation?: boolean;
        fileSize?: number;
        lineCount?: number;
        contentPreview?: string;
        hashMismatch?: boolean;
    }>;
}
```

#### Safe Delete Implementation (`src/index.ts`)

```typescript
private async handleDeleteOperations(
    edits: EditCodeEdit[],
    dryRun: boolean,
    results: EditCodeResult["results"],
    rollback: Array<() => Promise<void>>,
    touchedFiles: Set<string>
): Promise<void> {
    for (const edit of edits) {
        if (edit.operation !== "delete") continue;

        const absPath = this._getAbsPathAndVerify(edit.filePath);

        // Check file exists
        if (!await this.pathExists(absPath)) {
            throw new McpError(
                ErrorCode.InvalidParams,
                `File '${edit.filePath}' does not exist.`
            );
        }

        // Read file for safety checks
        const content = await this.fileSystem.readFile(absPath);
        const stats = await this.fileSystem.stat(absPath);
        const lineCount = content.split('\n').length;

        // Safety level determination
        const safetyLevel = edit.safetyLevel || "strict";
        const isLargeFile = stats.size > 10_000 || lineCount > 100;
        const requiresConfirmation = safetyLevel === "strict" && isLargeFile;

        // Hash verification if provided
        if (edit.confirmationHash) {
            const actualHash = crypto
                .createHash('sha256')
                .update(content)
                .digest('hex');

            if (actualHash !== edit.confirmationHash) {
                results.push({
                    filePath: this.normalizeRelativePath(absPath),
                    applied: false,
                    hashMismatch: true,
                    error: `Hash mismatch: File has been modified since preview.\n` +
                           `  Expected: ${edit.confirmationHash}\n` +
                           `  Actual:   ${actualHash}\n` +
                           `Retrieve latest content and retry.`,
                    diff: undefined
                });
                continue;
            }
        } else if (requiresConfirmation && !dryRun) {
            // Require hash for large files in strict mode
            const hash = crypto
                .createHash('sha256')
                .update(content)
                .digest('hex');

            results.push({
                filePath: this.normalizeRelativePath(absPath),
                applied: false,
                requiresConfirmation: true,
                fileSize: stats.size,
                lineCount,
                contentPreview: content.substring(0, 200) +
                    (content.length > 200 ? '\n...[truncated]' : ''),
                error: `⚠️  Large file deletion requires confirmation.\n` +
                       `File: ${edit.filePath} (${stats.size} bytes, ${lineCount} lines)\n` +
                       `\n` +
                       `To proceed, add confirmationHash to your delete operation:\n` +
                       `  confirmationHash: "${hash}"\n` +
                       `\n` +
                       `Or set safetyLevel: "force" to bypass (not recommended).`
            });
            continue;
        }

        // Dry run preview
        if (dryRun) {
            results.push({
                filePath: this.normalizeRelativePath(absPath),
                applied: false,
                fileSize: stats.size,
                lineCount,
                contentPreview: content.substring(0, 200) +
                    (content.length > 200 ? '\n...[truncated]' : ''),
                diff: `📋 Dry Run: Would delete file\n` +
                      `  Size: ${stats.size} bytes (${lineCount} lines)\n` +
                      `  Hash: ${crypto.createHash('sha256').update(content).digest('hex')}\n` +
                      `\n` +
                      `Preview (first 200 chars):\n${content.substring(0, 200)}` +
                      (content.length > 200 ? '\n...[truncated]' : '')
            });
            continue;
        }

        // Execute deletion with transaction safety
        const contentHash = crypto.createHash('sha256').update(content).digest('hex');

        try {
            // Delete file
            await this.fileSystem.deleteFile(absPath);
            touchedFiles.add(absPath);

            // Setup rollback
            const backup = content;
            rollback.push(async () => {
                const parentDir = path.dirname(absPath);
                if (!await this.pathExists(parentDir)) {
                    await this.fileSystem.createDir(parentDir);
                }
                await this.fileSystem.writeFile(absPath, backup);

                // Verify rollback succeeded
                const restored = await this.fileSystem.readFile(absPath);
                const restoredHash = crypto.createHash('sha256').update(restored).digest('hex');
                if (restoredHash !== contentHash) {
                    throw new Error(`Rollback verification failed for ${absPath}`);
                }
            });

            results.push({
                filePath: this.normalizeRelativePath(absPath),
                applied: true,
                diff: `✓ Deleted file (${stats.size} bytes, ${lineCount} lines, hash: ${contentHash.substring(0, 8)}...)`
            });

        } catch (error) {
            throw new McpError(
                ErrorCode.InternalError,
                `Failed to delete ${edit.filePath}: ${error instanceof Error ? error.message : String(error)}`
            );
        }
    }
}
```

---

### Phase 4: Large Refactoring Support

#### Batch Operation Guidance

**New Tool Parameter:**
```typescript
export interface EditCodeParams {
    edits: EditCodeEdit[];
    dryRun?: boolean;
    ignoreMistakes?: boolean;
    diffMode?: DiffMode;

    // NEW: Batch operation hints
    refactoringContext?: {
        pattern?: "rename-symbol" | "move-function" | "extract-component" | "inline-variable";
        scope?: "file" | "directory" | "project";
        estimatedEdits?: number;
    };
}
```

**Intelligent Suggestions:**
```typescript
// In edit_code handler
if (params.refactoringContext?.estimatedEdits && params.refactoringContext.estimatedEdits > 10) {
    // Suggest alternative approaches
    return {
        success: false,
        message: `⚠️  Large refactoring detected (${params.refactoringContext.estimatedEdits} edits).\n\n` +
                 `💡 Consider these alternatives:\n` +
                 `  1. Use analyze_relationship to find all references\n` +
                 `  2. Break into smaller batches (5-10 edits each)\n` +
                 `  3. For structural changes, use write_file to rewrite entire files\n` +
                 `\n` +
                 `Proceeding with ${params.edits.length} edits in current batch...`
    };
}
```

---

## Consequences

### Positive

1. **Increased Agent Effectiveness**
   - Agents can work with imperfect matches (tolerating whitespace/formatting variations)
   - Confidence scores enable intelligent retry strategies
   - Clear diagnostics reduce debugging loops

2. **Enhanced Safety**
   - Delete operations gain hash verification and confirmation
   - Large file deletions prevented without explicit confirmation
   - Transaction integrity maintained

3. **Better Developer Experience**
   - Graduated normalization provides fine-grained control
   - Transparent confidence scoring explains matching decisions
   - Error messages include actionable suggestions

4. **Maintains Existing Strengths**
   - Atomic transaction safety preserved (ADR-023)
   - Structural understanding capabilities enhanced
   - Backward compatible (new fields optional)

### Negative

1. **Increased Complexity**
   - Confidence scoring adds ~200 LOC to Editor.ts
   - More parameters for users to understand
   - Error messages become longer (though more helpful)

2. **Performance Overhead**
   - Confidence computation for every match (~1-2ms per edit)
   - Hash verification for deletes adds I/O
   - More normalization attempts increase matching time

3. **Backward Compatibility Burden**
   - Must support both old and new delete behavior
   - Legacy code may bypass new safety features
   - Documentation must explain migration path

### Mitigations

1. **Complexity Management**
   - Default behavior remains unchanged (opt-in enhancements)
   - Confidence scoring happens transparently
   - Clear documentation with examples

2. **Performance Optimization**
   - Cache normalization results per file
   - Lazy confidence computation (only on error or ambiguity)
   - Hash verification only for large files (configurable threshold)

3. **Migration Strategy**
   - Phase 1-2: Internal enhancements (no API changes)
   - Phase 3: Add optional safety fields
   - Phase 4: Deprecation warnings for unsafe deletes (6 month grace period)

---

## Migration Strategy

### Phase 1: Foundation (Week 1)
**Target:** Internal refactoring, no API changes

- [ ] Add `MatchConfidence` interface to types.ts
- [ ] Implement `computeMatchConfidence()` in Editor.ts
- [ ] Update `findMatch()` to compute confidence (store but don't expose)
- [ ] Add confidence to error diagnostics

**Testing:**
- Unit tests for confidence scoring algorithm
- Verify backward compatibility (all existing tests pass)

### Phase 2: Normalization Enhancement (Week 2)
**Target:** Expand normalization tiers

- [ ] Add 6-level `NormalizationLevel` enum
- [ ] Implement `normalizeString()` with new levels
- [ ] Update `getNormalizationAttempts()` to use hierarchy
- [ ] Add `NormalizationConfig` support

**Testing:**
- Test each normalization level independently
- Test edge cases (mixed tabs/spaces, CRLF files, empty lines)

### Phase 3: Safe Delete (Week 3)
**Target:** Add delete operation safety

- [ ] Add `confirmationHash`, `safetyLevel` to `EditCodeEdit`
- [ ] Rewrite `handleDeleteOperations()` with safety checks
- [ ] Add dry-run preview with content summary
- [ ] Integrate hash verification

**Testing:**
- Test large file deletion (requires hash)
- Test hash mismatch scenarios
- Test rollback verification
- Test dry-run mode

### Phase 4: Large Refactoring (Week 4)
**Target:** Batch operation guidance

- [ ] Add `refactoringContext` to `EditCodeParams`
- [ ] Implement batch size warnings
- [ ] Document refactoring patterns
- [ ] Create migration guide

**Testing:**
- Integration test with 20+ file edits
- Test refactoring context suggestions
- Performance benchmarking

---

## Testing Strategy

### Unit Tests

**Confidence Scoring (`Editor.test.ts`):**
```typescript
describe('computeMatchConfidence', () => {
    it('should score exact matches as 1.0', () => {
        const confidence = editor.computeMatchConfidence(
            exactMatch, edit, 'exact', 'exact'
        );
        expect(confidence.score).toBe(1.0);
    });

    it('should boost confidence with context constraints', () => {
        const withContext = editor.computeMatchConfidence(
            match, { ...edit, beforeContext: 'function', afterContext: '{' },
            'normalization', 'whitespace'
        );
        expect(withContext.score).toBeGreaterThan(0.80);
        expect(withContext.contextBoost).toBe(0.30);
    });

    it('should score levenshtein by distance', () => {
        const closeMatch = { original: 'authenticate', /* ... */ };
        const confidence = editor.computeMatchConfidence(
            closeMatch, { targetString: 'authentcate' },
            'levenshtein', 'exact'
        );
        expect(confidence.score).toBeGreaterThan(0.7);
    });
});
```

**Normalization Levels (`Editor.test.ts`):**
```typescript
describe('normalizeString', () => {
    it('should normalize line endings only at "line-endings" level', () => {
        const input = 'line1\r\nline2\r\n';
        const output = editor.normalizeString(input, { level: 'line-endings' });
        expect(output).toBe('line1\nline2\n');
    });

    it('should preserve indentation at "whitespace" level with preserveIndentation', () => {
        const input = '    function  test()  {  }';
        const output = editor.normalizeString(input, {
            level: 'whitespace',
            preserveIndentation: true
        });
        expect(output).toBe('    function test() { }');
    });

    it('should normalize tabs to spaces at "indentation" level', () => {
        const input = '\tfunction test() {\n\t\treturn true;\n\t}';
        const output = editor.normalizeString(input, {
            level: 'indentation',
            tabWidth: 2
        });
        expect(output).toBe('  function test() {\n    return true;\n  }');
    });
});
```

**Safe Delete Operations (`SmartContextMcp.test.ts`):**
```typescript
describe('handleDeleteOperations safety', () => {
    it('should require confirmation hash for large files', async () => {
        const largeFile = 'a'.repeat(15000);
        await fs.writeFile('large.ts', largeFile);

        const result = await mcp.editCode({
            edits: [{ operation: 'delete', filePath: 'large.ts' }],
            dryRun: false
        });

        expect(result.results[0].applied).toBe(false);
        expect(result.results[0].requiresConfirmation).toBe(true);
        expect(result.results[0].error).toContain('confirmationHash');
    });

    it('should validate hash before deletion', async () => {
        await fs.writeFile('test.ts', 'original');
        const hash = crypto.createHash('sha256').update('original').digest('hex');

        // Modify file before deletion
        await fs.writeFile('test.ts', 'modified');

        const result = await mcp.editCode({
            edits: [{
                operation: 'delete',
                filePath: 'test.ts',
                confirmationHash: hash
            }]
        });

        expect(result.results[0].applied).toBe(false);
        expect(result.results[0].hashMismatch).toBe(true);
    });

    it('should allow force delete without hash', async () => {
        await fs.writeFile('temp.ts', 'x'.repeat(20000));

        const result = await mcp.editCode({
            edits: [{
                operation: 'delete',
                filePath: 'temp.ts',
                safetyLevel: 'force'
            }]
        });

        expect(result.results[0].applied).toBe(true);
    });
});
```

### Integration Tests

**End-to-End Refactoring Workflow:**
```typescript
describe('Large refactoring workflow', () => {
    it('should handle multi-file symbol rename with confidence', async () => {
        // Setup: 10 files referencing "oldName"
        const files = Array.from({ length: 10 }, (_, i) =>
            `file${i}.ts`
        );

        for (const file of files) {
            await fs.writeFile(file, `
                import { oldName } from './shared';
                export function use() { return oldName(); }
            `);
        }

        // Execute: Rename symbol across all files
        const edits = files.map(file => ({
            operation: 'replace',
            filePath: file,
            targetString: 'oldName',
            replacementString: 'newName',
            normalization: 'whitespace'  // Tolerate formatting variations
        }));

        const result = await mcp.editCode({ edits, dryRun: false });

        // Verify: All files updated
        expect(result.success).toBe(true);
        expect(result.results.filter(r => r.applied)).toHaveLength(20); // 2 replacements per file

        // Verify: Content correct
        for (const file of files) {
            const content = await fs.readFile(file, 'utf-8');
            expect(content).toContain('newName');
            expect(content).not.toContain('oldName');
        }
    });
});
```

---

## Monitoring & Success Metrics

### Metrics to Track

```typescript
interface EditMetrics {
    // Confidence distribution
    confidenceScores: {
        high: number;      // 0.9-1.0
        medium: number;    // 0.7-0.89
        low: number;       // 0.5-0.69
        veryLow: number;   // <0.5
    };

    // Normalization usage
    normalizationLevels: Record<NormalizationLevel, number>;

    // Delete safety
    deletePrevented: number;         // Deletions stopped by hash mismatch
    largeFileDeletes: number;        // Deletions requiring confirmation
    forceDeletes: number;            // Bypassed safety with force mode

    // Matching success rates
    matchSuccessRate: number;        // % of edits that find a match
    ambiguousMatches: number;        // Ambiguous match errors
    noMatches: number;               // No match errors

    // Performance
    averageMatchTimeMs: number;
    averageHashComputeMs: number;
}
```

### Success Criteria

**Phase 1-2 (Confidence & Normalization):**
- ✅ Match success rate improves by 15%+ (baseline: measure current failure rate)
- ✅ Ambiguous match errors reduced by 25%+
- ✅ Average match time < 10ms per edit
- ✅ All existing tests pass (backward compatibility)

**Phase 3 (Safe Delete):**
- ✅ Zero accidental large file deletions in production
- ✅ Hash mismatch detection rate > 95% (simulated concurrent modification)
- ✅ Rollback success rate > 99.9%

**Phase 4 (Refactoring):**
- ✅ Agent refactoring success rate > 85% (multi-file operations)
- ✅ Average edits per refactoring task reduced by 30%+

---

## References

### Related ADRs
- **ADR-009**: Editor Engine Matching Improvements (original matching algorithm)
- **ADR-020**: Toolset Consolidation (edit_code tool design)
- **ADR-023**: Enhanced Architectural Gap Remediation (transaction safety foundation)

### External Resources
- [Levenshtein Distance Algorithm](https://en.wikipedia.org/wiki/Levenshtein_distance)
- [Myers Diff Algorithm](http://www.xmailserver.org/diff2.pdf) (used in semantic diff)
- [xxHash](https://github.com/Cyan4973/xxHash) (fast hash computation)
- [Tree-sitter](https://tree-sitter.github.io/) (AST parsing for structural normalization)

### GEMINI Agent Feedback
- Original assessment date: 2025-12-13
- Context: Membership management system refactoring
- Key insight: "개떡같이 말해도 찰떡같이 알아듣는" (understand imperfect input) principle

---

## Appendix: Example Usage

### Example 1: Flexible Matching with Confidence

```typescript
// Before (rigid): Fails on whitespace differences
await editCode({
    edits: [{
        operation: 'replace',
        filePath: 'src/auth.ts',
        targetString: 'function authenticate(username,password) {',
        replacementString: 'async function authenticate(username, password) {'
    }]
});
// ❌ Error: Match not found (spacing differences)

// After (flexible): Succeeds with normalization
await editCode({
    edits: [{
        operation: 'replace',
        filePath: 'src/auth.ts',
        targetString: 'function authenticate(username,password) {',
        replacementString: 'async function authenticate(username, password) {',
        normalization: 'whitespace'  // NEW: Tolerate whitespace variations
    }]
});
// ✅ Success: Match found with 85% confidence (whitespace normalized)
```

### Example 2: Safe Large File Deletion

```typescript
// Phase 1: Dry run to preview
const preview = await editCode({
    edits: [{
        operation: 'delete',
        filePath: 'legacy/old-api.ts'
    }],
    dryRun: true
});

console.log(preview.results[0]);
// {
//   filePath: 'legacy/old-api.ts',
//   applied: false,
//   fileSize: 15234,
//   lineCount: 456,
//   contentPreview: 'import express from "express";\n\nexport class OldAPI {...',
//   diff: '📋 Dry Run: Would delete file\n  Size: 15234 bytes (456 lines)\n  Hash: a3f5e9...'
// }

// Phase 2: Confirm with hash
await editCode({
    edits: [{
        operation: 'delete',
        filePath: 'legacy/old-api.ts',
        confirmationHash: 'a3f5e9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0'
    }]
});
// ✅ Deleted file (15234 bytes, 456 lines, hash: a3f5e9...)
```

### Example 3: Multi-Level Normalization

```typescript
// Level 1: line-endings (CRLF ↔ LF only)
await editCode({
    edits: [{
        operation: 'replace',
        filePath: 'windows-file.ts',
        targetString: 'const x = 1;\r\nconst y = 2;',
        replacementString: 'const x = 1;\nconst y = 2;',
        normalization: 'line-endings'
    }]
});

// Level 2: indentation (tabs ↔ spaces)
await editCode({
    edits: [{
        operation: 'replace',
        filePath: 'mixed-indent.ts',
        targetString: '\tfunction test() {\n\t\treturn true;\n\t}',
        replacementString: '  function test() {\n    return true;\n  }',
        normalization: 'indentation',
        normalizationConfig: { tabWidth: 2 }
    }]
});

// Level 3: structural (full normalization)
await editCode({
    edits: [{
        operation: 'replace',
        filePath: 'formatted.ts',
        targetString: `
            class  User   {

                getName()   {   return   this.name;   }
            }
        `,
        replacementString: 'class User { getName() { return this.name; } }',
        normalization: 'structural'
    }]
});
```

---

**End of ADR-024**
