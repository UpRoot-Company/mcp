# ADR-043: Adaptive Context Architecture (Adaptive Flow)

## Status
Proposed

## Date
2026-01-03

## Context
The current `smart-context-mcp` architecture has successfully established the "Five Pillars" (Explore, Understand, Change, Write, Manage) as the primary interface for interaction. However, the internal orchestration between these pillars and the underlying `AstManager` suffers from **granularity rigidity**.

### Current Limitations:
1.  **Binary Analysis State:** A file is effectively either "unknown" (raw text) or "fully parsed" (Full AST). There is no intermediate state for lightweight analysis.
2.  **Disconnected Context:** `ExplorePillar` performs broad searches, but the structural insights gained (e.g., "File A imports File B") are not efficiently passed to `UnderstandPillar`, which often re-analyzes context from scratch.
3.  **Performance vs. Depth Trade-off:** To ensure responsiveness, `Explore` often defaults to text-based search, missing structural relationships. Conversely, `Understand` may over-analyze files irrelevant to the immediate task, wasting cycles and tokens.

## Decision
We will transition from a "stateless tool chain" to an **Adaptive Context Architecture**, codenamed **"Adaptive Flow"**. This architecture introduces the concept of **Level of Detail (LOD)** to file analysis and centralizes state in a **Unified Context Graph (UCG)**.

### 1. The LOD (Level of Detail) Pyramid
We define four distinct levels of analysis state for any given file in the project. The system effectively manages the "promotion" of files between these levels based on user intent.

| Level | Name | Description | Cost | Component |
| :--- | :--- | :--- | :--- | :--- |
| **LOD 0** | **Registry** | Metadata only (Path, Size, Mtime, Git Status). | $\approx 0$ | `FileRegistry` |
| **LOD 1** | **Topology** | Surface-level dependency scan. Identifies `imports`, `exports`, and top-level symbols (Classes, Functions). No AST body parsing. | Low | `TopologyScanner` (Regex/Lexer) |
| **LOD 2** | **Structure** | Syntactic structure. Full parse tree but bodies are opaque (skeletons). Used for outlining and signature matching. | Medium | `TreeSitter` (Partial) |
| **LOD 3** | **Semantic** | Full resolution. Symbol references resolved, types inferred, data flow mapped. | High | `AstManager` + `Resolver` |

### 2. Unified Context Graph (UCG)
Instead of disparate caches (`SkeletonCache`, `SymbolIndex`), we will introduce a `UnifiedContextGraph` that serves as the single source of truth for the session's context.

*   **Nodes:** Files (and effectively Symbols at LOD 2+).
*   **Edges:** Dependencies (`imports`, `inherits`, `calls`).
*   **State:** Each node tracks its current `LOD`.
*   **Behavior:** Pillars query the graph. If the required information is at a higher LOD than the current node state, the graph automatically triggers an analysis "promotion" (Lazy Evaluation).

**Current Architecture Problems:**
*   **Circular Dependencies:** `SymbolIndex` ↔ `DependencyGraph` create coupling issues (src/indexing/search/SymbolIndex.ts ↔ src/indexing/dependency-graph/DependencyGraph.ts)
*   **Duplicate Instantiation:** `ChangePillar` creates temporary `SymbolIndex` instances (L1492-1498 in src/orchestration/pillars/ChangePillar.ts)
*   **Inconsistent State:** File changes must manually invalidate 3+ separate caches (SkeletonCache, SymbolIndex, DependencyGraph)

**UCG Solution:**
*   Consolidate state into single graph with LOD tracking per node
*   Cascade invalidation: File change → automatic downgrade of dependent nodes
*   Shared across pillars via `OrchestrationContext.sharedState`

### 3. Pillar Refactoring Strategy

#### Explore Pillar (The Scout)
*   **Old Way:** Text search -> `read_code` (skeleton).
*   **New Way:**
    1.  **Scout:** Fast scan at **LOD 1** to build a topology graph around the query terms.
    2.  **Cluster:** Identify relevant "clusters" of files based on connectivity, not just text matching.
    3.  **Report:** Return results enriched with topological context (e.g., "Found `Auth` in `User.ts`, which is heavily used by `Login.tsx`").

#### Understand Pillar (The Analyst)
*   **Old Way:** Re-parse targets -> Generate Report.
*   **New Way:**
    1.  **Ingest:** Accept a set of nodes from the UCG (provided by Explore).
    2.  **Promote:** Promote the core nodes to **LOD 3** (Semantic) and immediate neighbors to **LOD 2** (Structure).
    3.  **Synthesize:** Generate insights using the mixed-LOD graph, saving tokens by keeping peripheral files at LOD 1/2.

#### Change Pillar (The Surgeon)
*   **Old Way:** `search_project` for impact -> Apply Edit.
*   **New Way:**
    1.  **Target:** Promote target files to **LOD 3**.
    2.  **Impact:** Traverse reverse edges in UCG to find dependents. Promote impacted files to **LOD 2** to verify signatures.
    3.  **Verify:** Apply changes and re-verify consistency only within the promoted subgraph.

## Technical Rationale

### Performance Analysis
Based on empirical data from `benchmarks/reports/full-report-1767430513134.md`:

**Current AST Parsing Breakdown (per file):**
*   Total skeleton generation: **8.959ms** (p50)
*   Tree-sitter parsing: ~5-6ms (60-70% of time)
*   Query execution & traversal: ~2-3ms (20-30%)
*   Body folding/replacement: ~0.5-1ms (5-10%)

**Problem:** Import/export statements typically occupy only 5-10% of file lines (top of file), yet we parse 100% of the AST.

**LOD 1 Opportunity:**
*   Regex-based extraction: **~1-2ms** per file (single-pass read)
*   Speedup: **4-8x faster** than full AST parsing
*   Memory: **10-25x smaller** cache footprint (imports/exports only)

**Real-World Scenario (1000 files):**
| Metric | Current (Full AST) | With LOD 1 | Improvement |
|--------|-------------------|------------|-------------|
| Initial scan | 1000 × 9ms = 9s | 1000 × 1.5ms = 1.5s | **6x** |
| Cache hit (70%) | 700 × 0.5ms = 350ms | 700 × 0.1ms = 70ms | **5x** |
| Memory usage | ~30MB (skeletons) | ~2MB (topology) | **15x** |

### Existing Infrastructure Alignment

**Compatible Patterns (Reusable):**
1.  **CachingStrategy** (src/orchestration/caching/CachingStrategy.ts): Already supports pluggable cache backends → extend with LOD-aware caching
2.  **EditCoordinator** (src/orchestration/edit/coordinator/EditCoordinator.ts): Uses Options pattern for dependency injection → inject UCG similarly
3.  **OrchestrationContext** (src/orchestration/context/OrchestrationContext.ts): `sharedState` Map → perfect for UCG storage

**Components Requiring Refactoring:**
1.  **SymbolIndex** (src/indexing/search/SymbolIndex.ts): Tightly coupled with DependencyGraph → transition to UCG consumer
2.  **ImportExtractor** (src/ast/extractors/ImportExtractor.ts): Full AST parsing → wrap with TopologyScanner fallback
3.  **Pillar State Management**: Currently stateless → add UCG access via OrchestrationContext

### Migration Precedents in Codebase

**ADR-021 (FileSystem Abstraction):**
*   Strategy: Constructor injection with fallback to default
*   Lesson: Gradual migration via optional parameters maintains compatibility

**ADR-033 (Six Pillars):**
*   Strategy: 3-phase deprecation (warn → convert → remove)
*   Lesson: Incremental transitions with monitoring prevent breakage

**Applied to ADR-043:**
*   Feature flag gating (`SMART_CONTEXT_ADAPTIVE_FLOW_ENABLED`)
*   Dual-write validation period (UCG + legacy caches)
*   Fallback paths (TopologyScanner → ImportExtractor)

### Risk Mitigation

**High Risk: Circular Dependencies**
*   **Problem:** SymbolIndex ↔ DependencyGraph circular dependency
*   **Mitigation:** UCG acts as mediator, breaking the cycle via unified interface

**High Risk: Cache Invalidation Bugs**
*   **Problem:** File change must invalidate 3+ caches consistently
*   **Mitigation:** UCG cascade invalidation with automatic downgrade propagation

**Medium Risk: TopologyScanner Accuracy**
*   **Problem:** Regex may miss complex import patterns (dynamic imports, re-exports)
*   **Mitigation:** 
    *   Automatic fallback to ImportExtractor when confidence <0.95
    *   Comprehensive test suite comparing regex vs AST results (target: 95%+ match)
    *   Log fallback events for pattern improvement

**Medium Risk: Memory Overhead**
*   **Problem:** Project-wide graph could consume excessive memory
*   **Mitigation:**
    *   LRU eviction policy (max 5000 nodes by default)
    *   Target: <500MB for 10,000 files
    *   Configurable limits via environment variables

## Detailed Design

### Interface: `AdaptiveAstManager`
The `AstManager` will be refactored to support granular requests.

```typescript
type LOD_LEVEL = 0 | 1 | 2 | 3;

interface AnalysisRequest {
    path: string;
    minLOD: LOD_LEVEL;
}

interface LODResult {
    path: string;
    currentLOD: LOD_LEVEL;
    requestedLOD: LOD_LEVEL;
    promoted: boolean;
    durationMs: number;
    fallbackUsed: boolean; // TopologyScanner failed, used AST fallback
    confidence?: number;    // Regex extraction confidence (0.0-1.0)
}

interface AdaptiveAstManager {
    // Ensures the file is analyzed at least to the requested LOD
    ensureLOD(request: AnalysisRequest): Promise<LODResult>;
    
    // Returns the graph node, doing work only if needed
    getFileNode(path: string): ContextNode;
    
    // Query current LOD state without triggering promotion
    getCurrentLOD(path: string): LOD_LEVEL;
    
    // Monitoring: Track promotion patterns
    promotionStats(): {
        l0_to_l1: number;
        l1_to_l2: number;
        l2_to_l3: number;
        fallback_rate: number; // TopologyScanner failure rate
    };
    
    // Safety: Force fallback to full AST parsing
    fallbackToFullAST(path: string): Promise<void>;
}
```

### Component: `TopologyScanner`
To achieve high performance for LOD 1, we will implement a lightweight scanner that bypasses full Tree-sitter parsing for simple dependency extraction.

**Implementation Strategy:**
*   **Primary Method:** Regex/Lexer-based extraction for `import`/`export` statements
    *   Target performance: <2ms per file (vs 8.959ms for full AST)
    *   Optimized V8 regex engine for pattern matching
    *   Single-pass file read (vs Tree-sitter's 2-3 traversals)
*   **Fallback Method:** If regex confidence <0.95 or parsing errors occur:
    *   Automatically delegate to existing `ImportExtractor`/`ExportExtractor` (full AST)
    *   Log fallback events for pattern improvement
    *   Target fallback rate: <5% of files
*   **Limitations:**
    *   No type information (cannot distinguish `type` vs `const` exports)
    *   Complex re-export chains may require AST fallback
    *   Comments containing code-like text need special handling

**Performance Validation:**
*   Benchmark against existing `ImportExtractor` using `benchmarks/main.ts` infrastructure
*   Measure accuracy: Compare results with full AST extraction (target: 95%+ match)
*   Test coverage: 90%+ including edge cases (nested comments, dynamic imports)

## Consequences

### Positive
*   **Performance:** Based on benchmark data from `benchmarks/reports/full-report-1767430513134.md`:
    *   **Explore initial scan:** 6x improvement (9s → 1.5s for 1000 files)
    *   **LOD 1 extraction:** <2ms per file vs 8.959ms for full skeleton generation
    *   **Memory efficiency:** 15x reduction (30MB → 2MB for topology cache)
    *   **Cache effectiveness:** LOD 1 achieves 5-10x smaller footprint (0.5-2KB vs 10-50KB per file)
*   **Token Efficiency:** Context sent to the LLM is optimized. We don't send full code when a skeleton (LOD 2) or a signature (LOD 1) suffices. Estimated 80-90% of files in Explore phase only need LOD 1.
*   **Cohesion:** Pillars share a common understanding of the codebase via UCG. `Understand` builds directly upon `Explore`'s findings without re-parsing.

### Negative
*   **Complexity:** State management becomes more complex. We must handle cache invalidation (downgrading LOD on file change) carefully. UCG introduces stateful coordination that requires cascade invalidation logic.
*   **Memory Overhead:** Maintaining a project-wide topology graph consumes memory:
    *   **Target:** <500MB for 10,000 files (LOD 1)
    *   **Mitigation:** LRU eviction policy with configurable node limit (default: 5000 nodes)
    *   **Trade-off:** Still 60-70% less memory than maintaining full ASTs for all files

## Rollback Strategy

### Trigger Conditions
Automatic or manual rollback should be initiated if any of the following conditions are met:

1.  **TopologyScanner Accuracy Issues**
    *   LOD 1 extraction accuracy < 95% (compared to full AST extraction)
    *   Fallback rate > 10% (indicates regex patterns are insufficient)
    *   False positives/negatives causing incorrect dependency graphs

2.  **Performance Degradation**
    *   LOD promotion latency > 500ms (p95)
    *   Overall Explore/Understand pillar response time > 120% of baseline
    *   TopologyScanner slower than full AST (indicates optimization failure)

3.  **Memory Constraints**
    *   UCG memory usage > 2GB (exceeds acceptable overhead)
    *   Out-of-memory errors due to unbounded graph growth
    *   Eviction rate > 30% (thrashing, indicates LRU policy failure)

4.  **Consistency Errors**
    *   Dual-write validation: >1% inconsistency between UCG and legacy caches
    *   Cache invalidation bugs: Stale data causing incorrect analysis results
    *   LOD promotion failures: Files stuck at wrong LOD level

### Rollback Procedures

#### Full Rollback (All LOD Features)
```bash
# 1. Disable adaptive flow via environment variable
export SMART_CONTEXT_ADAPTIVE_FLOW_ENABLED=false

# 2. Restart server to load legacy code paths
npm run restart

# 3. Clear UCG cache to prevent stale data
rm -rf .smart-context/ucg/

# 4. Verify baseline performance
npm run benchmark -- --scenario baseline

# 5. Monitor metrics for 24 hours
# - Confirm latency returns to baseline
# - Check memory usage stabilizes
# - Validate no consistency errors
```

#### Partial Rollback Options

**Option 1: Disable LOD 1 Only (Keep UCG)**
*   Use case: TopologyScanner accuracy issues, but UCG state management works
*   Action: Set `TOPOLOGY_SCANNER_ENABLED=false`
*   Effect: All files analyzed with full AST (LOD 2/3), but graph coordination remains
*   Performance impact: Lose 6x speed improvement, but maintain pillar cohesion

**Option 2: Disable UCG Only (Keep TopologyScanner)**
*   Use case: Memory/invalidation issues with UCG, but TopologyScanner is fast
*   Action: Set `UNIFIED_CONTEXT_GRAPH_ENABLED=false`
*   Effect: Use TopologyScanner for fast extraction, but store in legacy `SkeletonCache`
*   Performance impact: Faster extraction, but lose cross-pillar state sharing

**Option 3: Fallback to Dual-Write Mode**
*   Use case: Suspected consistency bugs, need validation
*   Action: Re-enable `DUAL_WRITE_VALIDATION=true`
*   Effect: Write to both UCG and legacy caches, log discrepancies
*   Performance impact: 20-30% slower writes, but ensures data integrity

### Recovery Path After Rollback

1.  **Root Cause Analysis**
    *   Analyze logs: Identify pattern in failures (file types, project sizes, edge cases)
    *   Reproduce locally: Create minimal test case triggering the issue
    *   Fix identified bugs: Patch TopologyScanner regex, UCG invalidation logic, etc.

2.  **Validation**
    *   Add regression tests: Ensure fix prevents recurrence
    *   Benchmark improvements: Confirm fix doesn't degrade performance
    *   Code review: Get approval on architectural changes

3.  **Gradual Re-Enable**
    *   Start with canary deployment (1-2 developers)
    *   Monitor for 48 hours with metrics dashboard
    *   Expand to 10% users → 50% → 100% over 2-3 weeks

### Rollback Success Criteria

*   Latency returns to within 5% of pre-adaptive-flow baseline
*   Memory usage stabilizes below 1.5x baseline
*   Zero consistency errors for 7 consecutive days
*   User-reported issues drop to baseline levels

## Implementation Plan

### Phase 1: Foundation (Week 1-2)
**Goal:** Establish LOD infrastructure without breaking existing functionality.

---

#### 1.1 LOD Types & Metadata

**File: `src/types.ts`** (Add after line 50)
```typescript
// ============================================================
// LOD (Level of Detail) System Types
// ============================================================

/** 
 * Level of Detail for file analysis.
 * 0 = Registry (metadata only)
 * 1 = Topology (imports/exports, lightweight)
 * 2 = Structure (full AST skeleton)
 * 3 = Semantic (full resolution with types)
 */
export type LOD_LEVEL = 0 | 1 | 2 | 3;

/**
 * Request to ensure a file is analyzed to at least the specified LOD.
 */
export interface AnalysisRequest {
    /** Absolute file path */
    path: string;
    /** Minimum LOD level required */
    minLOD: LOD_LEVEL;
    /** Optional: Force re-analysis even if already at requested LOD */
    force?: boolean;
}

/**
 * Result of an LOD analysis/promotion operation.
 */
export interface LODResult {
    /** File path that was analyzed */
    path: string;
    /** LOD level before the operation */
    previousLOD: LOD_LEVEL;
    /** Current LOD level after the operation */
    currentLOD: LOD_LEVEL;
    /** LOD level that was requested */
    requestedLOD: LOD_LEVEL;
    /** Whether the file was promoted to a higher LOD */
    promoted: boolean;
    /** Time taken for the operation in milliseconds */
    durationMs: number;
    /** Whether TopologyScanner failed and fell back to full AST */
    fallbackUsed: boolean;
    /** Confidence score for regex-based extraction (0.0-1.0) */
    confidence?: number;
    /** Error if analysis failed */
    error?: string;
}

/**
 * Topology information extracted at LOD 1.
 */
export interface TopologyInfo {
    /** File path */
    path: string;
    /** Import statements */
    imports: Array<{
        source: string;          // Module path
        isDefault: boolean;      // true if default import
        namedImports: string[];  // Named imports
        isTypeOnly: boolean;     // true if import type
        isDynamic: boolean;      // true if import()
    }>;
    /** Export statements */
    exports: Array<{
        name: string;            // Export name
        isDefault: boolean;      // true if export default
        isTypeOnly: boolean;     // true if export type
        reExportFrom?: string;   // Source if re-export
    }>;
    /** Top-level symbols (classes, functions, interfaces) */
    topLevelSymbols: Array<{
        name: string;
        kind: 'class' | 'function' | 'interface' | 'type' | 'const' | 'let' | 'var';
        exported: boolean;
        lineNumber: number;
    }>;
    /** Extraction confidence (0.0-1.0) */
    confidence: number;
    /** Whether AST fallback was used */
    fallbackUsed: boolean;
    /** Extraction duration in ms */
    extractionTimeMs: number;
}

/**
 * Statistics about LOD promotions.
 */
export interface LODPromotionStats {
    /** Number of LOD 0 → 1 promotions */
    l0_to_l1: number;
    /** Number of LOD 1 → 2 promotions */
    l1_to_l2: number;
    /** Number of LOD 2 → 3 promotions */
    l2_to_l3: number;
    /** TopologyScanner fallback rate (0.0-1.0) */
    fallback_rate: number;
    /** Average promotion time per level */
    avg_promotion_time_ms: {
        l0_to_l1: number;
        l1_to_l2: number;
        l2_to_l3: number;
    };
    /** Total files tracked in UCG */
    total_files: number;
}
```

**File: `src/indexing/records/FileRecord.ts`** (Extend existing interface)
```typescript
// CRITICAL: Add this import at the top
import { LOD_LEVEL } from '../../types.js';

// CRITICAL: Find the FileRecord interface and add these fields:
export interface FileRecord {
    // ... existing fields ...
    
    /** Current LOD level (0-3). Defaults to 0 (Registry) */
    currentLOD?: LOD_LEVEL;
    
    /** Timestamp of last LOD promotion */
    lodUpdatedAt?: number;
    
    /** Topology data if at LOD 1+ */
    topology?: {
        imports: string[];      // Simplified: just module paths
        exports: string[];      // Simplified: just exported names
        dependencies: string[]; // Resolved file paths
    };
}
```

**Checklist for 1.1:**
- [ ] Add LOD types to `src/types.ts` (exact location: after `ScoreDetails` interface)
- [ ] Import `LOD_LEVEL` in `src/indexing/records/FileRecord.ts`
- [ ] Add `currentLOD`, `lodUpdatedAt`, `topology` fields to `FileRecord` interface
- [ ] Run `npm run build` to verify TypeScript compilation
- [ ] Run `npm test` to ensure no existing tests break
- [ ] Commit with message: "feat(lod): Add LOD type definitions and FileRecord extensions"

---

#### 1.2 Interface Definition

**File: `src/ast/AdaptiveAstManager.ts`** (NEW FILE)
```typescript
import { LOD_LEVEL, AnalysisRequest, LODResult, LODPromotionStats } from '../types.js';
import { ContextNode } from '../orchestration/context/ContextNode.js'; // Will create in Phase 2

/**
 * Adaptive AST Manager interface supporting granular LOD-based analysis.
 * Extends traditional AstManager with lazy evaluation and LOD promotion.
 */
export interface AdaptiveAstManager {
    /**
     * Ensures a file is analyzed to at least the requested LOD level.
     * Performs lazy evaluation: only promotes if current LOD < requested LOD.
     * 
     * @param request - Analysis request with path and minimum LOD
     * @returns LODResult with promotion details
     * @throws Error if file doesn't exist or analysis fails
     */
    ensureLOD(request: AnalysisRequest): Promise<LODResult>;
    
    /**
     * Retrieves the UCG node for a file.
     * Does NOT trigger analysis. Returns undefined if file not in graph.
     * 
     * @param path - Absolute file path
     * @returns ContextNode or undefined
     */
    getFileNode(path: string): ContextNode | undefined;
    
    /**
     * Gets current LOD level for a file without triggering promotion.
     * 
     * @param path - Absolute file path
     * @returns Current LOD level (0-3), or 0 if file not tracked
     */
    getCurrentLOD(path: string): LOD_LEVEL;
    
    /**
     * Returns statistics about LOD promotions since server start.
     * Useful for monitoring and optimization.
     * 
     * @returns LODPromotionStats object
     */
    promotionStats(): LODPromotionStats;
    
    /**
     * Forces a file to be analyzed with full AST parsing (LOD 3).
     * Bypasses TopologyScanner even for LOD 1.
     * Use when regex extraction is known to be unreliable for a file.
     * 
     * @param path - Absolute file path
     * @returns LODResult with fallbackUsed: true
     */
    fallbackToFullAST(path: string): Promise<LODResult>;
    
    /**
     * Invalidates a file's LOD state, downgrading it to LOD 0.
     * Optionally cascades to dependent files.
     * 
     * @param path - Absolute file path
     * @param cascade - If true, downgrades dependent files to LOD 1
     */
    invalidate(path: string, cascade?: boolean): void;
}
```

**File: `src/config/FeatureFlags.ts`** (NEW FILE)
```typescript
/**
 * Feature flags for gradual rollout and A/B testing.
 * Flags can be controlled via environment variables or runtime config.
 */
export class FeatureFlags {
    private static flags: Map<string, boolean> = new Map();
    
    /**
     * Enables the Adaptive Flow architecture (LOD + UCG).
     * Default: false (disabled)
     * Env var: SMART_CONTEXT_ADAPTIVE_FLOW_ENABLED
     */
    static ADAPTIVE_FLOW_ENABLED = 'adaptive_flow_enabled';
    
    /**
     * Enables TopologyScanner for LOD 1 extraction.
     * Default: false (uses full AST fallback)
     * Env var: SMART_CONTEXT_TOPOLOGY_SCANNER_ENABLED
     */
    static TOPOLOGY_SCANNER_ENABLED = 'topology_scanner_enabled';
    
    /**
     * Enables Unified Context Graph state management.
     * Default: false (uses legacy caches)
     * Env var: SMART_CONTEXT_UCG_ENABLED
     */
    static UCG_ENABLED = 'ucg_enabled';
    
    /**
     * Enables dual-write validation (writes to both UCG and legacy caches).
     * Default: false
     * Env var: SMART_CONTEXT_DUAL_WRITE_VALIDATION
     */
    static DUAL_WRITE_VALIDATION = 'dual_write_validation';
    
    static initialize(): void {
        // Read from environment variables
        this.set(this.ADAPTIVE_FLOW_ENABLED, process.env.SMART_CONTEXT_ADAPTIVE_FLOW_ENABLED === 'true');
        this.set(this.TOPOLOGY_SCANNER_ENABLED, process.env.SMART_CONTEXT_TOPOLOGY_SCANNER_ENABLED === 'true');
        this.set(this.UCG_ENABLED, process.env.SMART_CONTEXT_UCG_ENABLED === 'true');
        this.set(this.DUAL_WRITE_VALIDATION, process.env.SMART_CONTEXT_DUAL_WRITE_VALIDATION === 'true');
        
        console.log('[FeatureFlags] Initialized:', Object.fromEntries(this.flags));
    }
    
    static isEnabled(flag: string): boolean {
        return this.flags.get(flag) ?? false;
    }
    
    static set(flag: string, enabled: boolean): void {
        this.flags.set(flag, enabled);
    }
    
    static getAll(): Record<string, boolean> {
        return Object.fromEntries(this.flags);
    }
}

// Auto-initialize on module load
FeatureFlags.initialize();
```

**File: `src/ast/AstManager.ts`** (Modify existing)
```typescript
// CRITICAL: Add this import at the top
import { AdaptiveAstManager } from './AdaptiveAstManager.js';
import { LOD_LEVEL, AnalysisRequest, LODResult, LODPromotionStats } from '../types.js';
import { FeatureFlags } from '../config/FeatureFlags.js';

// CRITICAL: Make AstManager implement AdaptiveAstManager
export class AstManager implements AdaptiveAstManager {
    // ... existing fields ...
    
    // NEW: LOD promotion statistics
    private lodStats: LODPromotionStats = {
        l0_to_l1: 0,
        l1_to_l2: 0,
        l2_to_l3: 0,
        fallback_rate: 0,
        avg_promotion_time_ms: { l0_to_l1: 0, l1_to_l2: 0, l2_to_l3: 0 },
        total_files: 0
    };
    
    // NEW: Implement AdaptiveAstManager interface
    async ensureLOD(request: AnalysisRequest): Promise<LODResult> {
        if (!FeatureFlags.isEnabled(FeatureFlags.ADAPTIVE_FLOW_ENABLED)) {
            // Fallback: treat all requests as LOD 3 (full AST)
            const startTime = performance.now();
            await this.parseFile(request.path, ''); // Placeholder
            const durationMs = performance.now() - startTime;
            
            return {
                path: request.path,
                previousLOD: 0,
                currentLOD: 3,
                requestedLOD: request.minLOD,
                promoted: true,
                durationMs,
                fallbackUsed: true,
                confidence: 1.0
            };
        }
        
        // TODO: Phase 2 - Implement actual LOD promotion logic
        throw new Error('ensureLOD not implemented yet (Phase 2)');
    }
    
    getFileNode(path: string) {
        if (!FeatureFlags.isEnabled(FeatureFlags.UCG_ENABLED)) {
            return undefined;
        }
        // TODO: Phase 2 - Return UCG node
        return undefined;
    }
    
    getCurrentLOD(path: string): LOD_LEVEL {
        // TODO: Phase 2 - Query UCG or FileRecord
        return 0;
    }
    
    promotionStats(): LODPromotionStats {
        return { ...this.lodStats };
    }
    
    async fallbackToFullAST(path: string): Promise<LODResult> {
        const startTime = performance.now();
        // Force full AST parsing
        await this.parseFile(path, '');
        const durationMs = performance.now() - startTime;
        
        return {
            path,
            previousLOD: 0,
            currentLOD: 3,
            requestedLOD: 3,
            promoted: true,
            durationMs,
            fallbackUsed: true,
            confidence: 1.0
        };
    }
    
    invalidate(path: string, cascade: boolean = false): void {
        // TODO: Phase 2 - Implement UCG invalidation
        console.log(`[AstManager] Invalidate ${path}, cascade: ${cascade}`);
    }
    
    // ... rest of existing methods ...
}
```

**Checklist for 1.2:**
- [ ] Create `src/ast/AdaptiveAstManager.ts` with complete interface
- [ ] Create `src/config/FeatureFlags.ts` with all 4 flags
- [ ] Modify `src/ast/AstManager.ts` to implement `AdaptiveAstManager`
- [ ] Add stub implementations for all interface methods (throwing "not implemented" errors)
- [ ] Ensure `FeatureFlags.initialize()` is called (auto-called on module load)
- [ ] Run `npm run build` - should compile without errors
- [ ] Run `npm test` - all existing tests should pass
- [ ] Test feature flag reading: `SMART_CONTEXT_ADAPTIVE_FLOW_ENABLED=true npm start`
- [ ] Commit: "feat(lod): Add AdaptiveAstManager interface and feature flags"

---

#### 1.3 Test Infrastructure

**File: `src/tests/AdaptiveAstManager.test.ts`** (NEW FILE)
```typescript
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { AstManager } from '../ast/AstManager.js';
import { FeatureFlags } from '../config/FeatureFlags.js';
import { AnalysisRequest, LOD_LEVEL } from '../types.js';

describe('AdaptiveAstManager', () => {
    let manager: AstManager;
    
    beforeEach(async () => {
        AstManager.resetForTesting();
        manager = AstManager.getInstance();
        await manager.init({ mode: 'test', rootPath: process.cwd() });
    });
    
    afterEach(() => {
        AstManager.resetForTesting();
        FeatureFlags.set(FeatureFlags.ADAPTIVE_FLOW_ENABLED, false);
    });
    
    describe('Feature Flag Disabled', () => {
        it('should fall back to full AST when adaptive flow is disabled', async () => {
            FeatureFlags.set(FeatureFlags.ADAPTIVE_FLOW_ENABLED, false);
            
            const request: AnalysisRequest = {
                path: '/test/file.ts',
                minLOD: 1
            };
            
            const result = await manager.ensureLOD(request);
            
            expect(result.fallbackUsed).toBe(true);
            expect(result.currentLOD).toBe(3); // Always promotes to LOD 3
        });
        
        it('should return LOD 0 for getCurrentLOD when disabled', () => {
            FeatureFlags.set(FeatureFlags.ADAPTIVE_FLOW_ENABLED, false);
            
            const lod = manager.getCurrentLOD('/test/file.ts');
            
            expect(lod).toBe(0);
        });
    });
    
    describe('Promotion Stats', () => {
        it('should return initial stats with zero counts', () => {
            const stats = manager.promotionStats();
            
            expect(stats.l0_to_l1).toBe(0);
            expect(stats.l1_to_l2).toBe(0);
            expect(stats.l2_to_l3).toBe(0);
            expect(stats.fallback_rate).toBe(0);
            expect(stats.total_files).toBe(0);
        });
    });
    
    describe('Backward Compatibility', () => {
        it('should not break existing parseFile() calls', async () => {
            const content = 'const x = 1;';
            const doc = await manager.parseFile('/test/file.ts', content);
            
            expect(doc).toBeDefined();
            expect(doc.tree).toBeDefined();
        });
        
        it('should maintain existing cache behavior', async () => {
            // Test that SkeletonCache still works
            const content = 'export const foo = () => {};';
            const doc1 = await manager.parseFile('/test/same.ts', content);
            const doc2 = await manager.parseFile('/test/same.ts', content);
            
            // Should use cached result (timing would be similar)
            expect(doc1.tree.rootNode.toString()).toBe(doc2.tree.rootNode.toString());
        });
    });
    
    describe('Error Handling', () => {
        it('should throw error for ensureLOD when not implemented (Phase 1)', async () => {
            FeatureFlags.set(FeatureFlags.ADAPTIVE_FLOW_ENABLED, true);
            
            const request: AnalysisRequest = {
                path: '/test/file.ts',
                minLOD: 1
            };
            
            await expect(manager.ensureLOD(request)).rejects.toThrow('not implemented');
        });
    });
});
```

**File: `benchmarks/lod-comparison.ts`** (NEW FILE)
```typescript
#!/usr/bin/env node
import * as fs from 'fs';
import * as path from 'path';
import { performance } from 'perf_hooks';
import { AstManager } from '../src/ast/AstManager.js';
import { FeatureFlags } from '../src/config/FeatureFlags.js';

interface BenchmarkResult {
    scenario: string;
    files: number;
    totalTimeMs: number;
    avgTimePerFileMs: number;
    memoryUsedMB: number;
}

/**
 * Benchmark: Compare LOD 1 extraction vs Full AST parsing
 * Run: npm run benchmark:lod
 */
async function main() {
    console.log('='.repeat(60));
    console.log('LOD Performance Comparison Benchmark');
    console.log('='.repeat(60));
    
    const testFiles = findTestFiles(process.cwd(), 50); // Sample 50 files
    console.log(`\nFound ${testFiles.length} test files\n`);
    
    const results: BenchmarkResult[] = [];
    
    // Scenario 1: Full AST (current behavior)
    console.log('Scenario 1: Full AST Parsing (baseline)...');
    FeatureFlags.set(FeatureFlags.ADAPTIVE_FLOW_ENABLED, false);
    results.push(await benchmarkFullAST(testFiles));
    
    // Scenario 2: LOD 1 with TopologyScanner (Phase 2 - placeholder)
    console.log('\nScenario 2: LOD 1 Topology Scan (not yet implemented)...');
    console.log('  → Will be implemented in Phase 2');
    
    // Print results
    console.log('\n' + '='.repeat(60));
    console.log('RESULTS');
    console.log('='.repeat(60));
    
    results.forEach(r => {
        console.log(`\n${r.scenario}:`);
        console.log(`  Files:            ${r.files}`);
        console.log(`  Total Time:       ${r.totalTimeMs.toFixed(2)}ms`);
        console.log(`  Avg Time/File:    ${r.avgTimePerFileMs.toFixed(2)}ms`);
        console.log(`  Memory Used:      ${r.memoryUsedMB.toFixed(2)}MB`);
    });
    
    console.log('\n' + '='.repeat(60));
}

async function benchmarkFullAST(files: string[]): Promise<BenchmarkResult> {
    const manager = AstManager.getInstance();
    await manager.init({ mode: 'prod', rootPath: process.cwd() });
    
    const memBefore = process.memoryUsage().heapUsed;
    const startTime = performance.now();
    
    for (const file of files) {
        const content = fs.readFileSync(file, 'utf-8');
        await manager.parseFile(file, content);
    }
    
    const totalTimeMs = performance.now() - startTime;
    const memAfter = process.memoryUsage().heapUsed;
    const memoryUsedMB = (memAfter - memBefore) / 1024 / 1024;
    
    return {
        scenario: 'Full AST Parsing',
        files: files.length,
        totalTimeMs,
        avgTimePerFileMs: totalTimeMs / files.length,
        memoryUsedMB
    };
}

function findTestFiles(dir: string, maxFiles: number): string[] {
    const files: string[] = [];
    const srcDir = path.join(dir, 'src');
    
    function walk(currentDir: string) {
        if (files.length >= maxFiles) return;
        
        const entries = fs.readdirSync(currentDir, { withFileTypes: true });
        
        for (const entry of entries) {
            if (files.length >= maxFiles) break;
            
            const fullPath = path.join(currentDir, entry.name);
            
            if (entry.isDirectory()) {
                walk(fullPath);
            } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
                files.push(fullPath);
            }
        }
    }
    
    walk(srcDir);
    return files.slice(0, maxFiles);
}

main().catch(console.error);
```

**File: `package.json`** (Add script)
```json
{
  "scripts": {
    "benchmark:lod": "node --loader ts-node/esm benchmarks/lod-comparison.ts"
  }
}
```

**Checklist for 1.3:**
- [ ] Create `src/tests/AdaptiveAstManager.test.ts` with all 5 test suites
- [ ] Run `npm test -- AdaptiveAstManager` - should pass (backward compat tests)
- [ ] Create `benchmarks/lod-comparison.ts` with full AST benchmark
- [ ] Add `benchmark:lod` script to `package.json`
- [ ] Run `npm run benchmark:lod` - should complete without errors
- [ ] Verify baseline metrics are captured (e.g., ~9ms per file for full AST)
- [ ] Document baseline in `benchmarks/reports/lod-baseline-$(date +%s).md`
- [ ] Commit: "feat(lod): Add test infrastructure and LOD benchmark"

**Phase 1 Completion Checklist:**
- [ ] All TypeScript compiles (`npm run build`)
- [ ] All tests pass (`npm test`)
- [ ] Feature flags work (`SMART_CONTEXT_ADAPTIVE_FLOW_ENABLED=true npm start`)
- [ ] Benchmark runs (`npm run benchmark:lod`)
- [ ] No regressions in existing functionality
- [ ] Code review completed
- [ ] Documentation updated in README (optional)
- [ ] Git tag: `v0.1.0-lod-phase1`

---

### Phase 2: TopologyScanner & UCG Core (Week 3-5)
**Goal:** Implement LOD 1 extraction and centralized graph state.

---

#### 2.1 TopologyScanner Implementation

**File: `src/ast/topology/TopologyScanner.ts`** (NEW FILE - COMPLETE IMPLEMENTATION)
```typescript
import * as fs from 'fs';
import { TopologyInfo } from '../../types.js';
import { ImportExtractor } from '../extractors/ImportExtractor.js';
import { ExportExtractor } from '../extractors/ExportExtractor.js';
import { AstManager } from '../AstManager.js';

/**
 * TopologyScanner: Fast LOD 1 extraction using regex patterns.
 * Falls back to full AST parsing if regex confidence is low.
 * 
 * CRITICAL PATTERNS TO MATCH:
 * - import { foo } from 'bar'
 * - import foo from 'bar'
 * - export const foo = ...
 * - export function foo() {}
 * - export default ...
 * - export * from 'bar'
 * - import type { Foo } from 'bar' (TypeScript)
 * - export type Foo = ...
 * - Dynamic imports: import('foo')
 */
export class TopologyScanner {
    private importExtractor: ImportExtractor;
    private exportExtractor: ExportExtractor;
    private astManager: AstManager;
    
    // Regex patterns for fast extraction
    private readonly IMPORT_PATTERN = /import\s+(?:(?:type|typeof)\s+)?(?:{[^}]*}|[\w*]+|\*\s+as\s+\w+)(?:\s*,\s*(?:{[^}]*}|[\w*]+))?\s+from\s+['"]([^'"]+)['"]/g;
    private readonly IMPORT_DEFAULT_PATTERN = /import\s+(?:(?:type|typeof)\s+)?([\w$]+)\s+from\s+['"]([^'"]+)['"]/g;
    private readonly IMPORT_STAR_PATTERN = /import\s+\*\s+as\s+([\w$]+)\s+from\s+['"]([^'"]+)['"]/g;
    private readonly DYNAMIC_IMPORT_PATTERN = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    
    private readonly EXPORT_NAMED_PATTERN = /export\s+(?:const|let|var|function|class|interface|type|enum)\s+([\w$]+)/g;
    private readonly EXPORT_DEFAULT_PATTERN = /export\s+default\s+/g;
    private readonly EXPORT_FROM_PATTERN = /export\s+(?:{[^}]*}|\*)\s+from\s+['"]([^'"]+)['"]/g;
    
    private readonly TOP_LEVEL_FUNCTION_PATTERN = /(?:^|\n)\s*(?:export\s+)?function\s+([\w$]+)\s*\(/gm;
    private readonly TOP_LEVEL_CLASS_PATTERN = /(?:^|\n)\s*(?:export\s+)?class\s+([\w$]+)/gm;
    private readonly TOP_LEVEL_INTERFACE_PATTERN = /(?:^|\n)\s*(?:export\s+)?interface\s+([\w$]+)/gm;
    private readonly TOP_LEVEL_TYPE_PATTERN = /(?:^|\n)\s*(?:export\s+)?type\s+([\w$]+)\s*=/gm;
    private readonly TOP_LEVEL_CONST_PATTERN = /(?:^|\n)\s*(?:export\s+)?const\s+([\w$]+)\s*=/gm;
    
    constructor() {
        this.importExtractor = new ImportExtractor();
        this.exportExtractor = new ExportExtractor();
        this.astManager = AstManager.getInstance();
    }
    
    /**
     * Extract topology information from a file.
     * Tries regex first, falls back to AST if confidence is low.
     */
    async extract(filePath: string): Promise<TopologyInfo> {
        const startTime = performance.now();
        
        try {
            // Read file content
            const content = fs.readFileSync(filePath, 'utf-8');
            
            // Try regex extraction first
            const regexResult = this.extractViaRegex(filePath, content);
            
            // Check confidence threshold
            if (regexResult.confidence >= 0.95) {
                const extractionTimeMs = performance.now() - startTime;
                console.log(`[TopologyScanner] Regex success for ${filePath} (${extractionTimeMs.toFixed(2)}ms, confidence: ${regexResult.confidence})`);
                return {
                    ...regexResult,
                    extractionTimeMs,
                    fallbackUsed: false
                };
            }
            
            // Low confidence, use AST fallback
            console.warn(`[TopologyScanner] Low confidence (${regexResult.confidence}) for ${filePath}, using AST fallback`);
            return await this.fallbackToAST(filePath, content, startTime);
            
        } catch (error) {
            console.error(`[TopologyScanner] Regex extraction failed for ${filePath}:`, error);
            const content = fs.readFileSync(filePath, 'utf-8');
            return await this.fallbackToAST(filePath, content, startTime);
        }
    }
    
    /**
     * Extract via regex patterns.
     * Returns confidence score based on heuristics.
     */
    private extractViaRegex(filePath: string, content: string): TopologyInfo {
        const imports: TopologyInfo['imports'] = [];
        const exports: TopologyInfo['exports'] = [];
        const topLevelSymbols: TopologyInfo['topLevelSymbols'] = [];
        
        // Remove comments to avoid false positives
        const cleanContent = this.removeComments(content);
        
        // Extract imports
        let match;
        
        // Named imports: import { foo, bar } from 'module'
        this.IMPORT_PATTERN.lastIndex = 0;
        while ((match = this.IMPORT_PATTERN.exec(cleanContent)) !== null) {
            const source = match[1];
            const importStatement = match[0];
            
            // Extract named imports from braces
            const namedMatch = importStatement.match(/{([^}]+)}/);
            const namedImports = namedMatch 
                ? namedMatch[1].split(',').map(s => s.trim().replace(/\s+as\s+.+$/, ''))
                : [];
            
            const isTypeOnly = /import\s+type\s+/.test(importStatement);
            
            imports.push({
                source,
                isDefault: false,
                namedImports,
                isTypeOnly,
                isDynamic: false
            });
        }
        
        // Default imports: import Foo from 'module'
        this.IMPORT_DEFAULT_PATTERN.lastIndex = 0;
        while ((match = this.IMPORT_DEFAULT_PATTERN.exec(cleanContent)) !== null) {
            const name = match[1];
            const source = match[2];
            const isTypeOnly = /import\s+type\s+/.test(match[0]);
            
            imports.push({
                source,
                isDefault: true,
                namedImports: [name],
                isTypeOnly,
                isDynamic: false
            });
        }
        
        // Dynamic imports: import('module')
        this.DYNAMIC_IMPORT_PATTERN.lastIndex = 0;
        while ((match = this.DYNAMIC_IMPORT_PATTERN.exec(cleanContent)) !== null) {
            imports.push({
                source: match[1],
                isDefault: false,
                namedImports: [],
                isTypeOnly: false,
                isDynamic: true
            });
        }
        
        // Extract exports
        this.EXPORT_NAMED_PATTERN.lastIndex = 0;
        while ((match = this.EXPORT_NAMED_PATTERN.exec(cleanContent)) !== null) {
            exports.push({
                name: match[1],
                isDefault: false,
                isTypeOnly: /export\s+(?:interface|type)/.test(match[0])
            });
        }
        
        // Default export
        if (this.EXPORT_DEFAULT_PATTERN.test(cleanContent)) {
            exports.push({
                name: 'default',
                isDefault: true,
                isTypeOnly: false
            });
        }
        
        // Re-exports: export * from 'module'
        this.EXPORT_FROM_PATTERN.lastIndex = 0;
        while ((match = this.EXPORT_FROM_PATTERN.exec(cleanContent)) !== null) {
            exports.push({
                name: '*',
                isDefault: false,
                isTypeOnly: false,
                reExportFrom: match[1]
            });
        }
        
        // Extract top-level symbols
        const symbolsFound = new Set<string>();
        
        // Functions
        this.TOP_LEVEL_FUNCTION_PATTERN.lastIndex = 0;
        while ((match = this.TOP_LEVEL_FUNCTION_PATTERN.exec(cleanContent)) !== null) {
            const name = match[1];
            if (!symbolsFound.has(name)) {
                symbolsFound.add(name);
                topLevelSymbols.push({
                    name,
                    kind: 'function',
                    exported: /export\s+function/.test(match[0]),
                    lineNumber: this.getLineNumber(content, match.index)
                });
            }
        }
        
        // Classes
        this.TOP_LEVEL_CLASS_PATTERN.lastIndex = 0;
        while ((match = this.TOP_LEVEL_CLASS_PATTERN.exec(cleanContent)) !== null) {
            const name = match[1];
            if (!symbolsFound.has(name)) {
                symbolsFound.add(name);
                topLevelSymbols.push({
                    name,
                    kind: 'class',
                    exported: /export\s+class/.test(match[0]),
                    lineNumber: this.getLineNumber(content, match.index)
                });
            }
        }
        
        // Interfaces
        this.TOP_LEVEL_INTERFACE_PATTERN.lastIndex = 0;
        while ((match = this.TOP_LEVEL_INTERFACE_PATTERN.exec(cleanContent)) !== null) {
            const name = match[1];
            if (!symbolsFound.has(name)) {
                symbolsFound.add(name);
                topLevelSymbols.push({
                    name,
                    kind: 'interface',
                    exported: /export\s+interface/.test(match[0]),
                    lineNumber: this.getLineNumber(content, match.index)
                });
            }
        }
        
        // Types
        this.TOP_LEVEL_TYPE_PATTERN.lastIndex = 0;
        while ((match = this.TOP_LEVEL_TYPE_PATTERN.exec(cleanContent)) !== null) {
            const name = match[1];
            if (!symbolsFound.has(name)) {
                symbolsFound.add(name);
                topLevelSymbols.push({
                    name,
                    kind: 'type',
                    exported: /export\s+type/.test(match[0]),
                    lineNumber: this.getLineNumber(content, match.index)
                });
            }
        }
        
        // Consts
        this.TOP_LEVEL_CONST_PATTERN.lastIndex = 0;
        while ((match = this.TOP_LEVEL_CONST_PATTERN.exec(cleanContent)) !== null) {
            const name = match[1];
            if (!symbolsFound.has(name)) {
                symbolsFound.add(name);
                topLevelSymbols.push({
                    name,
                    kind: 'const',
                    exported: /export\s+const/.test(match[0]),
                    lineNumber: this.getLineNumber(content, match.index)
                });
            }
        }
        
        // Calculate confidence
        const confidence = this.calculateConfidence(content, imports, exports, topLevelSymbols);
        
        return {
            path: filePath,
            imports,
            exports,
            topLevelSymbols,
            confidence,
            fallbackUsed: false,
            extractionTimeMs: 0 // Will be set by caller
        };
    }
    
    /**
     * Remove comments to avoid matching code-like text in comments.
     * Handles:
     * - // single-line comments
     * - /* multi-line comments *\/
     * - Preserves strings (don't remove // inside strings)
     */
    private removeComments(content: string): string {
        // This is a simplified version. A production implementation should
        // use a proper lexer to handle edge cases like // in strings.
        
        let result = content;
        
        // Remove multi-line comments
        result = result.replace(/\/\*[\s\S]*?\*\//g, '');
        
        // Remove single-line comments (preserve strings)
        result = result.replace(/(?<!['"])\/\/.*$/gm, '');
        
        return result;
    }
    
    /**
     * Calculate confidence score for regex extraction.
     * Heuristics:
     * - High confidence (>0.95) if no complex patterns detected
     * - Medium confidence (0.70-0.95) if some complexity
     * - Low confidence (<0.70) if many dynamic/complex patterns
     */
    private calculateConfidence(
        content: string,
        imports: TopologyInfo['imports'],
        exports: TopologyInfo['exports'],
        symbols: TopologyInfo['topLevelSymbols']
    ): number {
        let confidence = 1.0;
        
        // Penalize for dynamic imports (harder to extract correctly)
        const dynamicImports = imports.filter(i => i.isDynamic).length;
        confidence -= dynamicImports * 0.05;
        
        // Penalize for re-exports (can have complex chains)
        const reExports = exports.filter(e => e.reExportFrom).length;
        confidence -= reExports * 0.03;
        
        // Penalize if file is very large (regex may miss nested patterns)
        const lines = content.split('\n').length;
        if (lines > 1000) {
            confidence -= 0.1;
        } else if (lines > 500) {
            confidence -= 0.05;
        }
        
        // Penalize if no imports/exports found but file is not trivial
        if (imports.length === 0 && exports.length === 0 && lines > 50) {
            confidence -= 0.2;
        }
        
        // Boost if patterns look standard
        const standardImports = imports.filter(i => !i.isDynamic && !i.isTypeOnly).length;
        if (standardImports > 0 && standardImports === imports.length) {
            confidence += 0.05;
        }
        
        return Math.max(0.0, Math.min(1.0, confidence));
    }
    
    /**
     * Get line number from character index in content.
     */
    private getLineNumber(content: string, index: number): number {
        const upToIndex = content.substring(0, index);
        return upToIndex.split('\n').length;
    }
    
    /**
     * Fallback to full AST parsing using existing extractors.
     */
    private async fallbackToAST(filePath: string, content: string, startTime: number): Promise<TopologyInfo> {
        // Parse with AstManager
        const doc = await this.astManager.parseFile(filePath, content);
        
        // Extract imports using ImportExtractor
        const imports = await this.importExtractor.extractImports(doc, filePath);
        
        // Extract exports using ExportExtractor
        const exports = await this.exportExtractor.extractExports(doc, filePath);
        
        // Convert to TopologyInfo format
        const topologyImports: TopologyInfo['imports'] = imports.map(imp => ({
            source: imp.source,
            isDefault: imp.importedNames.includes('default'),
            namedImports: imp.importedNames.filter(n => n !== 'default'),
            isTypeOnly: imp.isTypeOnly ?? false,
            isDynamic: false
        }));
        
        const topologyExports: TopologyInfo['exports'] = exports.map(exp => ({
            name: exp.name,
            isDefault: exp.isDefault ?? false,
            isTypeOnly: false
        }));
        
        // Extract top-level symbols from exports
        const topLevelSymbols: TopologyInfo['topLevelSymbols'] = exports.map(exp => ({
            name: exp.name,
            kind: this.inferSymbolKind(exp.name, content),
            exported: true,
            lineNumber: exp.line ?? 0
        }));
        
        const extractionTimeMs = performance.now() - startTime;
        
        return {
            path: filePath,
            imports: topologyImports,
            exports: topologyExports,
            topLevelSymbols,
            confidence: 1.0, // AST is 100% accurate
            fallbackUsed: true,
            extractionTimeMs
        };
    }
    
    /**
     * Infer symbol kind from context (used in AST fallback).
     */
    private inferSymbolKind(name: string, content: string): TopologyInfo['topLevelSymbols'][0]['kind'] {
        if (content.includes(`class ${name}`)) return 'class';
        if (content.includes(`function ${name}`)) return 'function';
        if (content.includes(`interface ${name}`)) return 'interface';
        if (content.includes(`type ${name}`)) return 'type';
        if (content.includes(`const ${name}`)) return 'const';
        return 'const'; // default
    }
}
```

**File: `src/tests/TopologyScanner.test.ts`** (NEW FILE - COMPREHENSIVE TESTS)
```typescript
import { describe, it, expect, beforeEach } from '@jest/globals';
import { TopologyScanner } from '../ast/topology/TopologyScanner.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('TopologyScanner', () => {
    let scanner: TopologyScanner;
    let tempDir: string;
    
    beforeEach(() => {
        scanner = new TopologyScanner();
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'topology-test-'));
    });
    
    afterEach(() => {
        // Cleanup temp files
        fs.rmSync(tempDir, { recursive: true, force: true });
    });
    
    describe('Regex Extraction', () => {
        it('should extract named imports', async () => {
            const testFile = path.join(tempDir, 'test.ts');
            fs.writeFileSync(testFile, `
                import { foo, bar } from 'module1';
                import { baz as qux } from 'module2';
            `);
            
            const result = await scanner.extract(testFile);
            
            expect(result.imports).toHaveLength(2);
            expect(result.imports[0].source).toBe('module1');
            expect(result.imports[0].namedImports).toContain('foo');
            expect(result.imports[0].namedImports).toContain('bar');
            expect(result.imports[0].isDefault).toBe(false);
            
            expect(result.imports[1].source).toBe('module2');
            expect(result.imports[1].namedImports).toContain('baz');
        });
        
        it('should extract default imports', async () => {
            const testFile = path.join(tempDir, 'test.ts');
            fs.writeFileSync(testFile, `
                import React from 'react';
                import _ from 'lodash';
            `);
            
            const result = await scanner.extract(testFile);
            
            expect(result.imports).toHaveLength(2);
            expect(result.imports[0].source).toBe('react');
            expect(result.imports[0].isDefault).toBe(true);
            expect(result.imports[0].namedImports).toContain('React');
        });
        
        it('should extract type-only imports', async () => {
            const testFile = path.join(tempDir, 'test.ts');
            fs.writeFileSync(testFile, `
                import type { Foo } from 'types';
                import { type Bar } from 'module';
            `);
            
            const result = await scanner.extract(testFile);
            
            expect(result.imports[0].isTypeOnly).toBe(true);
        });
        
        it('should extract dynamic imports', async () => {
            const testFile = path.join(tempDir, 'test.ts');
            fs.writeFileSync(testFile, `
                const module = await import('dynamic-module');
                import('lazy-module').then(m => m.init());
            `);
            
            const result = await scanner.extract(testFile);
            
            const dynamicImports = result.imports.filter(i => i.isDynamic);
            expect(dynamicImports).toHaveLength(2);
            expect(dynamicImports[0].source).toBe('dynamic-module');
        });
        
        it('should extract named exports', async () => {
            const testFile = path.join(tempDir, 'test.ts');
            fs.writeFileSync(testFile, `
                export const foo = 42;
                export function bar() {}
                export class Baz {}
                export interface Qux {}
                export type Quux = string;
            `);
            
            const result = await scanner.extract(testFile);
            
            expect(result.exports).toHaveLength(5);
            const names = result.exports.map(e => e.name);
            expect(names).toContain('foo');
            expect(names).toContain('bar');
            expect(names).toContain('Baz');
            expect(names).toContain('Qux');
            expect(names).toContain('Quux');
        });
        
        it('should extract default export', async () => {
            const testFile = path.join(tempDir, 'test.ts');
            fs.writeFileSync(testFile, `
                export default function main() {}
            `);
            
            const result = await scanner.extract(testFile);
            
            const defaultExport = result.exports.find(e => e.isDefault);
            expect(defaultExport).toBeDefined();
            expect(defaultExport!.name).toBe('default');
        });
        
        it('should extract re-exports', async () => {
            const testFile = path.join(tempDir, 'test.ts');
            fs.writeFileSync(testFile, `
                export * from 'module1';
                export { foo, bar } from 'module2';
            `);
            
            const result = await scanner.extract(testFile);
            
            const reExports = result.exports.filter(e => e.reExportFrom);
            expect(reExports).toHaveLength(1);
            expect(reExports[0].reExportFrom).toBe('module1');
        });
        
        it('should extract top-level symbols', async () => {
            const testFile = path.join(tempDir, 'test.ts');
            fs.writeFileSync(testFile, `
                function helper() {}
                class Service {}
                interface Config {}
                type State = {};
                const API_KEY = 'secret';
                
                export function publicApi() {}
            `);
            
            const result = await scanner.extract(testFile);
            
            expect(result.topLevelSymbols.length).toBeGreaterThan(5);
            
            const publicApi = result.topLevelSymbols.find(s => s.name === 'publicApi');
            expect(publicApi).toBeDefined();
            expect(publicApi!.exported).toBe(true);
            expect(publicApi!.kind).toBe('function');
            
            const helper = result.topLevelSymbols.find(s => s.name === 'helper');
            expect(helper).toBeDefined();
            expect(helper!.exported).toBe(false);
        });
    });
    
    describe('Comment Handling', () => {
        it('should ignore imports in comments', async () => {
            const testFile = path.join(tempDir, 'test.ts');
            fs.writeFileSync(testFile, `
                // import { fake } from 'commented';
                /* import { alsoFake } from 'multiline'; */
                import { real } from 'actual';
            `);
            
            const result = await scanner.extract(testFile);
            
            expect(result.imports).toHaveLength(1);
            expect(result.imports[0].source).toBe('actual');
        });
        
        it('should handle code-like comments', async () => {
            const testFile = path.join(tempDir, 'test.ts');
            fs.writeFileSync(testFile, `
                /**
                 * Example usage:
                 * import { Component } from 'fake-example';
                 */
                import { RealComponent } from 'real-module';
            `);
            
            const result = await scanner.extract(testFile);
            
            // Should only extract the real import
            const realImports = result.imports.filter(i => i.source === 'real-module');
            expect(realImports).toHaveLength(1);
        });
    });
    
    describe('Confidence Scoring', () => {
        it('should have high confidence for simple files', async () => {
            const testFile = path.join(tempDir, 'test.ts');
            fs.writeFileSync(testFile, `
                import { foo } from 'bar';
                export const baz = foo();
            `);
            
            const result = await scanner.extract(testFile);
            
            expect(result.confidence).toBeGreaterThan(0.95);
            expect(result.fallbackUsed).toBe(false);
        });
        
        it('should have lower confidence for complex files', async () => {
            const testFile = path.join(tempDir, 'test.ts');
            const complexContent = `
                import('dynamic1').then();
                import('dynamic2').then();
                export * from 'reexport1';
                export * from 'reexport2';
                ${'\\n'.repeat(1000)} // Make file very large
            `;
            fs.writeFileSync(testFile, complexContent);
            
            const result = await scanner.extract(testFile);
            
            // Should still work but with lower confidence
            expect(result.confidence).toBeLessThan(0.95);
        });
    });
    
    describe('AST Fallback', () => {
        it('should fallback to AST for low confidence', async () => {
            // Create a file that triggers fallback
            const testFile = path.join(tempDir, 'complex.ts');
            const content = `
                ${'\\n'.repeat(2000)} // Very large file
                import('dynamic').then();
                import('dynamic2').then();
                import('dynamic3').then();
                import('dynamic4').then();
                import('dynamic5').then();
            `;
            fs.writeFileSync(testFile, content);
            
            const result = await scanner.extract(testFile);
            
            // Should use fallback
            expect(result.fallbackUsed).toBe(true);
            expect(result.confidence).toBe(1.0); // AST is 100% accurate
        });
    });
    
    describe('Performance', () => {
        it('should extract in <2ms for typical files', async () => {
            const testFile = path.join(tempDir, 'test.ts');
            const typicalContent = `
                import { useState, useEffect } from 'react';
                import axios from 'axios';
                
                export function MyComponent() {
                    const [data, setData] = useState(null);
                    
                    useEffect(() => {
                        axios.get('/api').then(setData);
                    }, []);
                    
                    return data;
                }
            `;
            fs.writeFileSync(testFile, typicalContent);
            
            const result = await scanner.extract(testFile);
            
            expect(result.extractionTimeMs).toBeLessThan(2);
        });
    });
    
    describe('Edge Cases', () => {
        it('should handle files with no imports/exports', async () => {
            const testFile = path.join(tempDir, 'test.ts');
            fs.writeFileSync(testFile, `
                function internal() {}
                const x = 1;
            `);
            
            const result = await scanner.extract(testFile);
            
            expect(result.imports).toHaveLength(0);
            expect(result.exports).toHaveLength(0);
            expect(result.topLevelSymbols.length).toBeGreaterThan(0);
        });
        
        it('should handle empty files', async () => {
            const testFile = path.join(tempDir, 'empty.ts');
            fs.writeFileSync(testFile, '');
            
            const result = await scanner.extract(testFile);
            
            expect(result.imports).toHaveLength(0);
            expect(result.exports).toHaveLength(0);
            expect(result.topLevelSymbols).toHaveLength(0);
        });
        
        it('should handle files with only comments', async () => {
            const testFile = path.join(tempDir, 'comments.ts');
            fs.writeFileSync(testFile, `
                /**
                 * This file only has comments
                 */
                // No actual code
            `);
            
            const result = await scanner.extract(testFile);
            
            expect(result.imports).toHaveLength(0);
            expect(result.exports).toHaveLength(0);
        });
    });
});
```

**Checklist for 2.1:**
- [ ] Create `src/ast/topology/` directory
- [ ] Implement complete `TopologyScanner.ts` with all regex patterns
- [ ] Verify regex patterns match examples: `npm run test -- TopologyScanner`
- [ ] Create comprehensive test suite (15+ test cases)
- [ ] Run tests: `npm test -- TopologyScanner` - should pass all
- [ ] Benchmark performance: Add to `benchmarks/lod-comparison.ts`
- [ ] Verify <2ms extraction time for typical files
- [ ] Test fallback logic with low-confidence files
- [ ] Test comment handling (avoid false positives)
- [ ] Commit: "feat(lod): Implement TopologyScanner with regex extraction and AST fallback"

---

#### 2.2 UnifiedContextGraph Implementation

**File: `src/orchestration/context/ContextNode.ts`** (NEW FILE)
```typescript
import { LOD_LEVEL, TopologyInfo } from '../../types.js';

/**
 * Node in the Unified Context Graph.
 * Represents a file and its analysis state.
 */
export class ContextNode {
    /** Absolute file path */
    path: string;
    
    /** Current LOD level (0-3) */
    lod: LOD_LEVEL;
    
    /** Last modified timestamp (mtime) */
    lastModified: number;
    
    /** File size in bytes */
    size: number;
    
    /** LOD 1: Topology data */
    topology?: TopologyInfo;
    
    /** LOD 2: Skeleton data */
    skeleton?: string;
    
    /** LOD 3: Full AST document reference */
    astDocId?: string;
    
    /** Outgoing edges: Files this file imports/depends on */
    dependencies: Set<string>;
    
    /** Incoming edges: Files that import/depend on this file */
    dependents: Set<string>;
    
    /** Timestamp of last LOD update */
    lodUpdatedAt: number;
    
    /** Metadata for debugging */
    metadata: {
        promotions: number;           // How many times promoted
        lastPromotionDuration: number; // Duration of last promotion (ms)
        lastError?: string;           // Last error during promotion
    };
    
    constructor(path: string, lod: LOD_LEVEL = 0) {
        this.path = path;
        this.lod = lod;
        this.lastModified = 0;
        this.size = 0;
        this.dependencies = new Set();
        this.dependents = new Set();
        this.lodUpdatedAt = Date.now();
        this.metadata = {
            promotions: 0,
            lastPromotionDuration: 0
        };
    }
    
    /**
     * Update topology data (LOD 1).
     */
    setTopology(topology: TopologyInfo): void {
        this.topology = topology;
        this.lod = Math.max(this.lod, 1) as LOD_LEVEL;
        this.lodUpdatedAt = Date.now();
        this.metadata.promotions++;
    }
    
    /**
     * Update skeleton data (LOD 2).
     */
    setSkeleton(skeleton: string): void {
        this.skeleton = skeleton;
        this.lod = Math.max(this.lod, 2) as LOD_LEVEL;
        this.lodUpdatedAt = Date.now();
        this.metadata.promotions++;
    }
    
    /**
     * Update AST document reference (LOD 3).
     */
    setAstDoc(docId: string): void {
        this.astDocId = docId;
        this.lod = 3;
        this.lodUpdatedAt = Date.now();
        this.metadata.promotions++;
    }
    
    /**
     * Downgrade to a lower LOD level (e.g., on file change).
     */
    downgrade(newLod: LOD_LEVEL): void {
        if (newLod < this.lod) {
            this.lod = newLod;
            this.lodUpdatedAt = Date.now();
            
            // Clear higher-LOD data
            if (newLod < 3) {
                this.astDocId = undefined;
            }
            if (newLod < 2) {
                this.skeleton = undefined;
            }
            if (newLod < 1) {
                this.topology = undefined;
                this.dependencies.clear();
            }
        }
    }
    
    /**
     * Add a dependency edge (this file imports another file).
     */
    addDependency(targetPath: string): void {
        this.dependencies.add(targetPath);
    }
    
    /**
     * Add a dependent edge (another file imports this file).
     */
    addDependent(sourcePath: string): void {
        this.dependents.add(sourcePath);
    }
    
    /**
     * Remove a dependency edge.
     */
    removeDependency(targetPath: string): void {
        this.dependencies.delete(targetPath);
    }
    
    /**
     * Remove a dependent edge.
     */
    removeDependent(sourcePath: string): void {
        this.dependents.delete(sourcePath);
    }
}
```

**File: `src/orchestration/context/UnifiedContextGraph.ts`** (NEW FILE - COMPLETE IMPLEMENTATION)
```typescript
import * as fs from 'fs';
import * as path from 'path';
import { ContextNode } from './ContextNode.js';
import { LOD_LEVEL, AnalysisRequest, LODResult, TopologyInfo } from '../../types.js';
import { TopologyScanner } from '../../ast/topology/TopologyScanner.js';
import { SkeletonGenerator } from '../../ast/skeleton/SkeletonGenerator.js';
import { SkeletonCache } from '../../ast/skeleton/SkeletonCache.js';
import { AstManager } from '../../ast/AstManager.js';
import { FeatureFlags } from '../../config/FeatureFlags.js';

/**
 * Unified Context Graph: Centralized state for all file analysis.
 * Manages LOD levels, dependency edges, and lazy evaluation.
 * 
 * CRITICAL INVARIANTS:
 * 1. A file at LOD N has all data for LOD 0..N
 * 2. Dependency edges are only populated at LOD 1+
 * 3. Invalidation cascades to dependents
 * 4. LRU eviction maintains graph consistency (removes edges)
 */
export class UnifiedContextGraph {
    /** All nodes in the graph (key: absolute file path) */
    private nodes: Map<string, ContextNode>;
    
    /** LRU tracking for eviction */
    private lruQueue: string[];
    
    /** Maximum nodes to keep in memory */
    private maxNodes: number;
    
    /** Components for analysis */
    private topologyScanner: TopologyScanner;
    private skeletonGenerator: SkeletonGenerator;
    private skeletonCache: SkeletonCache;
    private astManager: AstManager;
    
    /** Root path for resolving relative imports */
    private rootPath: string;
    
    /** Statistics */
    private stats: {
        promotions: { l0_to_l1: number; l1_to_l2: number; l2_to_l3: number };
        evictions: number;
        cascadeInvalidations: number;
    };
    
    constructor(rootPath: string, maxNodes: number = 5000) {
        this.nodes = new Map();
        this.lruQueue = [];
        this.maxNodes = maxNodes;
        this.rootPath = rootPath;
        
        this.topologyScanner = new TopologyScanner();
        this.skeletonGenerator = new SkeletonGenerator();
        this.skeletonCache = new SkeletonCache();
        this.astManager = AstManager.getInstance();
        
        this.stats = {
            promotions: { l0_to_l1: 0, l1_to_l2: 0, l2_to_l3: 0 },
            evictions: 0,
            cascadeInvalidations: 0
        };
    }
    
    /**
     * Ensure a file is analyzed to at least the requested LOD.
     * Lazy evaluation: only promotes if current LOD < requested LOD.
     */
    async ensureLOD(request: AnalysisRequest): Promise<LODResult> {
        const startTime = performance.now();
        
        // Get or create node
        let node = this.nodes.get(request.path);
        if (!node) {
            node = new ContextNode(request.path, 0);
            this.nodes.set(request.path, node);
            this.updateLRU(request.path);
        } else {
            this.updateLRU(request.path);
        }
        
        const previousLOD = node.lod;
        
        // Already at requested LOD?
        if (node.lod >= request.minLOD && !request.force) {
            return {
                path: request.path,
                previousLOD,
                currentLOD: node.lod,
                requestedLOD: request.minLOD,
                promoted: false,
                durationMs: performance.now() - startTime,
                fallbackUsed: false,
                confidence: 1.0
            };
        }
        
        // Promote to requested LOD
        try {
            let fallbackUsed = false;
            let confidence = 1.0;
            
            // Promote incrementally through each LOD level
            for (let targetLOD = node.lod + 1; targetLOD <= request.minLOD; targetLOD++) {
                switch (targetLOD) {
                    case 1: // LOD 0 → 1
                        const topologyResult = await this.promoteToLOD1(node);
                        fallbackUsed = topologyResult.fallbackUsed;
                        confidence = topologyResult.confidence;
                        this.stats.promotions.l0_to_l1++;
                        break;
                        
                    case 2: // LOD 1 → 2
                        await this.promoteToLOD2(node);
                        this.stats.promotions.l1_to_l2++;
                        break;
                        
                    case 3: // LOD 2 → 3
                        await this.promoteToLOD3(node);
                        this.stats.promotions.l2_to_l3++;
                        break;
                }
            }
            
            const durationMs = performance.now() - startTime;
            node.metadata.lastPromotionDuration = durationMs;
            
            // Check for eviction
            this.evictIfNeeded();
            
            return {
                path: request.path,
                previousLOD,
                currentLOD: node.lod,
                requestedLOD: request.minLOD,
                promoted: true,
                durationMs,
                fallbackUsed,
                confidence
            };
            
        } catch (error) {
            node.metadata.lastError = error instanceof Error ? error.message : String(error);
            throw error;
        }
    }
    
    /**
     * Promote a node from LOD 0 to LOD 1 (Topology).
     */
    private async promoteToLOD1(node: ContextNode): Promise<{ fallbackUsed: boolean; confidence: number }> {
        console.log(`[UCG] Promoting ${node.path} to LOD 1 (Topology)`);
        
        if (!FeatureFlags.isEnabled(FeatureFlags.TOPOLOGY_SCANNER_ENABLED)) {
            // Fallback: Use full AST parsing
            return await this.promoteToLOD1Fallback(node);
        }
        
        // Use TopologyScanner
        const topology = await this.topologyScanner.extract(node.path);
        
        // Update node
        node.setTopology(topology);
        
        // Update file metadata
        const stats = fs.statSync(node.path);
        node.lastModified = stats.mtimeMs;
        node.size = stats.size;
        
        // Build dependency edges
        this.buildDependencyEdges(node, topology);
        
        return {
            fallbackUsed: topology.fallbackUsed,
            confidence: topology.confidence
        };
    }
    
    /**
     * Fallback: Promote to LOD 1 using full AST.
     */
    private async promoteToLOD1Fallback(node: ContextNode): Promise<{ fallbackUsed: boolean; confidence: number }> {
        console.warn(`[UCG] Using AST fallback for LOD 1: ${node.path}`);
        
        // Read file
        const content = fs.readFileSync(node.path, 'utf-8');
        
        // Parse with AstManager
        const doc = await this.astManager.parseFile(node.path, content);
        
        // Extract topology from AST
        // NOTE: This is a simplified version. Real implementation would use ImportExtractor/ExportExtractor
        const topology: TopologyInfo = {
            path: node.path,
            imports: [],
            exports: [],
            topLevelSymbols: [],
            confidence: 1.0,
            fallbackUsed: true,
            extractionTimeMs: 0
        };
        
        node.setTopology(topology);
        
        return {
            fallbackUsed: true,
            confidence: 1.0
        };
    }
    
    /**
     * Promote a node from LOD 1 to LOD 2 (Structure/Skeleton).
     */
    private async promoteToLOD2(node: ContextNode): Promise<void> {
        console.log(`[UCG] Promoting ${node.path} to LOD 2 (Structure)`);
        
        // Check cache first
        const cached = this.skeletonCache.get(node.path);
        if (cached) {
            node.setSkeleton(cached.skeleton);
            return;
        }
        
        // Generate skeleton
        const content = fs.readFileSync(node.path, 'utf-8');
        const doc = await this.astManager.parseFile(node.path, content);
        const skeleton = await this.skeletonGenerator.generateSkeleton(doc, node.path, 'medium');
        
        // Update node and cache
        node.setSkeleton(skeleton);
        this.skeletonCache.set(node.path, { skeleton, mtime: node.lastModified });
    }
    
    /**
     * Promote a node from LOD 2 to LOD 3 (Semantic).
     */
    private async promoteToLOD3(node: ContextNode): Promise<void> {
        console.log(`[UCG] Promoting ${node.path} to LOD 3 (Semantic)`);
        
        // Full AST parsing (semantic analysis would go here)
        const content = fs.readFileSync(node.path, 'utf-8');
        const doc = await this.astManager.parseFile(node.path, content);
        
        // Store AST document reference
        // In production, this would store in a separate AST cache
        const docId = `ast:${node.path}:${Date.now()}`;
        node.setAstDoc(docId);
    }
    
    /**
     * Build dependency edges from topology information.
     */
    private buildDependencyEdges(node: ContextNode, topology: TopologyInfo): void {
        // Clear existing dependencies
        for (const dep of node.dependencies) {
            const depNode = this.nodes.get(dep);
            if (depNode) {
                depNode.removeDependent(node.path);
            }
        }
        node.dependencies.clear();
        
        // Add new dependencies
        for (const imp of topology.imports) {
            const resolvedPath = this.resolveImport(node.path, imp.source);
            if (resolvedPath) {
                node.addDependency(resolvedPath);
                
                // Get or create target node
                let depNode = this.nodes.get(resolvedPath);
                if (!depNode) {
                    depNode = new ContextNode(resolvedPath, 0);
                    this.nodes.set(resolvedPath, depNode);
                }
                depNode.addDependent(node.path);
            }
        }
    }
    
    /**
     * Resolve import path to absolute file path.
     * Simplified version - real implementation would use ModuleResolver.
     */
    private resolveImport(fromPath: string, importSource: string): string | null {
        // Relative imports
        if (importSource.startsWith('.')) {
            const dir = path.dirname(fromPath);
            const resolved = path.resolve(dir, importSource);
            
            // Try common extensions
            const extensions = ['.ts', '.tsx', '.js', '.jsx', ''];
            for (const ext of extensions) {
                const withExt = resolved + ext;
                if (fs.existsSync(withExt) && fs.statSync(withExt).isFile()) {
                    return withExt;
                }
            }
            
            // Try index files
            const indexPath = path.join(resolved, 'index.ts');
            if (fs.existsSync(indexPath)) {
                return indexPath;
            }
        }
        
        // Absolute imports from node_modules (not tracked in UCG)
        return null;
    }
    
    /**
     * Get a node from the graph (does not trigger analysis).
     */
    getNode(path: string): ContextNode | undefined {
        return this.nodes.get(path);
    }
    
    /**
     * Invalidate a file, downgrading it to LOD 0.
     * Optionally cascade to dependents.
     */
    invalidate(path: string, cascade: boolean = true): void {
        const node = this.nodes.get(path);
        if (!node) return;
        
        console.log(`[UCG] Invalidating ${path}, cascade: ${cascade}`);
        
        // Downgrade to LOD 0
        node.downgrade(0);
        
        // Invalidate legacy caches if dual-write enabled
        if (FeatureFlags.isEnabled(FeatureFlags.DUAL_WRITE_VALIDATION)) {
            this.skeletonCache.invalidate(path);
            // symbolIndex.invalidateFile(path) - would be called here
        }
        
        // Cascade to dependents
        if (cascade) {
            for (const dependentPath of node.dependents) {
                const dependent = this.nodes.get(dependentPath);
                if (dependent && dependent.lod >= 2) {
                    // Downgrade to LOD 1 (keep topology, invalidate structure/semantic)
                    dependent.downgrade(1);
                    this.stats.cascadeInvalidations++;
                    
                    console.log(`  ↳ Cascaded to ${dependentPath} (LOD ${dependent.lod})`);
                }
            }
        }
    }
    
    /**
     * Get outgoing edges (dependencies).
     */
    getEdges(path: string, direction: 'outgoing' | 'incoming' | 'both'): string[] {
        const node = this.nodes.get(path);
        if (!node) return [];
        
        if (direction === 'outgoing') {
            return Array.from(node.dependencies);
        } else if (direction === 'incoming') {
            return Array.from(node.dependents);
        } else {
            return [...Array.from(node.dependencies), ...Array.from(node.dependents)];
        }
    }
    
    /**
     * Get transitive dependencies up to maxDepth.
     */
    async getTransitiveDependencies(path: string, options: { maxDepth: number }): Promise<string[]> {
        const visited = new Set<string>();
        const queue: Array<{ path: string; depth: number }> = [{ path, depth: 0 }];
        
        while (queue.length > 0) {
            const { path: currentPath, depth } = queue.shift()!;
            
            if (depth >= options.maxDepth) continue;
            if (visited.has(currentPath)) continue;
            visited.add(currentPath);
            
            const node = this.nodes.get(currentPath);
            if (!node) continue;
            
            // Ensure at least LOD 1 to get dependencies
            if (node.lod < 1) {
                await this.ensureLOD({ path: currentPath, minLOD: 1 });
            }
            
            // Add dependencies to queue
            for (const dep of node.dependencies) {
                if (!visited.has(dep)) {
                    queue.push({ path: dep, depth: depth + 1 });
                }
            }
        }
        
        visited.delete(path); // Remove self
        return Array.from(visited);
    }
    
    /**
     * Update LRU queue (moves path to end = most recently used).
     */
    private updateLRU(path: string): void {
        const index = this.lruQueue.indexOf(path);
        if (index !== -1) {
            this.lruQueue.splice(index, 1);
        }
        this.lruQueue.push(path);
    }
    
    /**
     * Evict least recently used nodes if over limit.
     */
    private evictIfNeeded(): void {
        while (this.nodes.size > this.maxNodes && this.lruQueue.length > 0) {
            const evictPath = this.lruQueue.shift()!;
            const node = this.nodes.get(evictPath);
            
            if (node) {
                console.log(`[UCG] Evicting ${evictPath} (LOD ${node.lod})`);
                
                // Remove edges
                for (const dep of node.dependencies) {
                    const depNode = this.nodes.get(dep);
                    if (depNode) {
                        depNode.removeDependent(evictPath);
                    }
                }
                
                for (const dependent of node.dependents) {
                    const depNode = this.nodes.get(dependent);
                    if (depNode) {
                        depNode.removeDependency(evictPath);
                    }
                }
                
                this.nodes.delete(evictPath);
                this.stats.evictions++;
            }
        }
    }
    
    /**
     * Get statistics.
     */
    getStats() {
        return {
            nodes: this.nodes.size,
            maxNodes: this.maxNodes,
            ...this.stats,
            memoryEstimateMB: (this.nodes.size * 2) / 1024 // Rough estimate: ~2KB per node
        };
    }
    
    /**
     * Clear all nodes (for testing).
     */
    clear(): void {
        this.nodes.clear();
        this.lruQueue = [];
        this.stats = {
            promotions: { l0_to_l1: 0, l1_to_l2: 0, l2_to_l3: 0 },
            evictions: 0,
            cascadeInvalidations: 0
        };
    }
}
```

**File: `src/tests/UnifiedContextGraph.test.ts`** (NEW FILE)
```typescript
import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { UnifiedContextGraph } from '../orchestration/context/UnifiedContextGraph.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('UnifiedContextGraph', () => {
    let ucg: UnifiedContextGraph;
    let tempDir: string;
    
    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucg-test-'));
        ucg = new UnifiedContextGraph(tempDir);
    });
    
    afterEach(() => {
        ucg.clear();
        fs.rmSync(tempDir, { recursive: true, force: true });
    });
    
    describe('LOD Promotion', () => {
        it('should promote file from LOD 0 to LOD 1', async () => {
            const testFile = path.join(tempDir, 'test.ts');
            fs.writeFileSync(testFile, `
                import { foo } from 'bar';
                export const baz = foo();
            `);
            
            const result = await ucg.ensureLOD({ path: testFile, minLOD: 1 });
            
            expect(result.promoted).toBe(true);
            expect(result.previousLOD).toBe(0);
            expect(result.currentLOD).toBe(1);
            
            const node = ucg.getNode(testFile);
            expect(node).toBeDefined();
            expect(node!.lod).toBe(1);
            expect(node!.topology).toBeDefined();
        });
        
        it('should not re-promote if already at requested LOD', async () => {
            const testFile = path.join(tempDir, 'test.ts');
            fs.writeFileSync(testFile, 'const x = 1;');
            
            await ucg.ensureLOD({ path: testFile, minLOD: 1 });
            const result2 = await ucg.ensureLOD({ path: testFile, minLOD: 1 });
            
            expect(result2.promoted).toBe(false);
        });
        
        it('should promote incrementally through LOD levels', async () => {
            const testFile = path.join(tempDir, 'test.ts');
            fs.writeFileSync(testFile, 'export const x = 1;');
            
            const result3 = await ucg.ensureLOD({ path: testFile, minLOD: 3 });
            
            expect(result3.currentLOD).toBe(3);
            
            const node = ucg.getNode(testFile);
            expect(node!.topology).toBeDefined(); // LOD 1
            expect(node!.skeleton).toBeDefined(); // LOD 2
            expect(node!.astDocId).toBeDefined(); // LOD 3
        });
    });
    
    describe('Dependency Edges', () => {
        it('should build dependency edges at LOD 1', async () => {
            const fileA = path.join(tempDir, 'a.ts');
            const fileB = path.join(tempDir, 'b.ts');
            
            fs.writeFileSync(fileA, `import { foo } from './b';`);
            fs.writeFileSync(fileB, `export const foo = 1;`);
            
            await ucg.ensureLOD({ path: fileA, minLOD: 1 });
            
            const nodeA = ucg.getNode(fileA);
            expect(nodeA!.dependencies.size).toBe(1);
            expect(nodeA!.dependencies.has(fileB)).toBe(true);
            
            const nodeB = ucg.getNode(fileB);
            expect(nodeB).toBeDefined(); // Created automatically
            expect(nodeB!.dependents.has(fileA)).toBe(true);
        });
        
        it('should get outgoing edges', async () => {
            const fileA = path.join(tempDir, 'a.ts');
            const fileB = path.join(tempDir, 'b.ts');
            
            fs.writeFileSync(fileA, `import { foo } from './b';`);
            fs.writeFileSync(fileB, `export const foo = 1;`);
            
            await ucg.ensureLOD({ path: fileA, minLOD: 1 });
            
            const deps = ucg.getEdges(fileA, 'outgoing');
            expect(deps).toContain(fileB);
        });
        
        it('should get incoming edges', async () => {
            const fileA = path.join(tempDir, 'a.ts');
            const fileB = path.join(tempDir, 'b.ts');
            
            fs.writeFileSync(fileA, `import { foo } from './b';`);
            fs.writeFileSync(fileB, `export const foo = 1;`);
            
            await ucg.ensureLOD({ path: fileA, minLOD: 1 });
            
            const dependents = ucg.getEdges(fileB, 'incoming');
            expect(dependents).toContain(fileA);
        });
    });
    
    describe('Invalidation', () => {
        it('should downgrade file to LOD 0 on invalidation', async () => {
            const testFile = path.join(tempDir, 'test.ts');
            fs.writeFileSync(testFile, 'export const x = 1;');
            
            await ucg.ensureLOD({ path: testFile, minLOD: 2 });
            
            ucg.invalidate(testFile, false);
            
            const node = ucg.getNode(testFile);
            expect(node!.lod).toBe(0);
            expect(node!.skeleton).toBeUndefined();
        });
        
        it('should cascade invalidation to dependents', async () => {
            const fileA = path.join(tempDir, 'a.ts');
            const fileB = path.join(tempDir, 'b.ts');
            
            fs.writeFileSync(fileA, `import { foo } from './b';`);
            fs.writeFileSync(fileB, `export const foo = 1;`);
            
            await ucg.ensureLOD({ path: fileA, minLOD: 2 });
            await ucg.ensureLOD({ path: fileB, minLOD: 2 });
            
            // Invalidate B with cascade
            ucg.invalidate(fileB, true);
            
            const nodeA = ucg.getNode(fileA);
            expect(nodeA!.lod).toBe(1); // Downgraded from 2 to 1
            
            const nodeB = ucg.getNode(fileB);
            expect(nodeB!.lod).toBe(0); // Fully downgraded
        });
    });
    
    describe('LRU Eviction', () => {
        it('should evict least recently used nodes', async () => {
            const smallUcg = new UnifiedContextGraph(tempDir, 3); // Max 3 nodes
            
            const files = [
                path.join(tempDir, 'a.ts'),
                path.join(tempDir, 'b.ts'),
                path.join(tempDir, 'c.ts'),
                path.join(tempDir, 'd.ts')
            ];
            
            files.forEach(f => fs.writeFileSync(f, 'const x = 1;'));
            
            // Add 4 nodes (should evict first)
            for (const file of files) {
                await smallUcg.ensureLOD({ path: file, minLOD: 1 });
            }
            
            const stats = smallUcg.getStats();
            expect(stats.nodes).toBeLessThanOrEqual(3);
            expect(stats.evictions).toBeGreaterThan(0);
        });
    });
    
    describe('Statistics', () => {
        it('should track promotion statistics', async () => {
            const testFile = path.join(tempDir, 'test.ts');
            fs.writeFileSync(testFile, 'export const x = 1;');
            
            await ucg.ensureLOD({ path: testFile, minLOD: 3 });
            
            const stats = ucg.getStats();
            expect(stats.promotions.l0_to_l1).toBe(1);
            expect(stats.promotions.l1_to_l2).toBe(1);
            expect(stats.promotions.l2_to_l3).toBe(1);
        });
    });
});
```

**Checklist for 2.2:**
- [ ] Create `src/orchestration/context/ContextNode.ts`
- [ ] Create `src/orchestration/context/UnifiedContextGraph.ts`
- [ ] Implement all LOD promotion logic (L0→L1, L1→L2, L2→L3)
- [ ] Implement dependency edge management
- [ ] Implement cascade invalidation
- [ ] Implement LRU eviction policy
- [ ] Create comprehensive test suite: `src/tests/UnifiedContextGraph.test.ts`
- [ ] Run tests: `npm test -- UnifiedContextGraph` - should pass
- [ ] Verify eviction maintains graph consistency (no dangling edges)
- [ ] Test cascade invalidation with complex dependency graphs
- [ ] Commit: "feat(lod): Implement UnifiedContextGraph with LOD management and dependency tracking"

---

#### 2.3 Cache Integration & Dual-Write Validation

**File: `src/ast/AstManager.ts`** (Complete implementation of ensureLOD)
```typescript
// CRITICAL: Add UnifiedContextGraph to AstManager
import { UnifiedContextGraph } from '../orchestration/context/UnifiedContextGraph.js';

export class AstManager implements AdaptiveAstManager {
    // ... existing fields ...
    
    // NEW: Unified Context Graph (lazy initialization)
    private ucg?: UnifiedContextGraph;
    
    private getUCG(): UnifiedContextGraph {
        if (!this.ucg) {
            const rootPath = this.engineConfig.rootPath ?? process.cwd();
            this.ucg = new UnifiedContextGraph(rootPath);
        }
        return this.ucg;
    }
    
    // COMPLETE IMPLEMENTATION of ensureLOD
    async ensureLOD(request: AnalysisRequest): Promise<LODResult> {
        if (!FeatureFlags.isEnabled(FeatureFlags.ADAPTIVE_FLOW_ENABLED)) {
            // Fallback: Use fallbackToFullAST
            return await this.fallbackToFullAST(request.path);
        }
        
        const ucg = this.getUCG();
        const result = await ucg.ensureLOD(request);
        
        // Dual-write validation (if enabled)
        if (FeatureFlags.isEnabled(FeatureFlags.DUAL_WRITE_VALIDATION)) {
            await this.validateDualWrite(request.path, result);
        }
        
        // Update stats
        if (result.promoted) {
            const prevLOD = result.previousLOD;
            const currLOD = result.currentLOD;
            
            if (prevLOD === 0 && currLOD >= 1) this.lodStats.l0_to_l1++;
            if (prevLOD <= 1 && currLOD >= 2) this.lodStats.l1_to_l2++;
            if (prevLOD <= 2 && currLOD === 3) this.lodStats.l2_to_l3++;
        }
        
        if (result.fallbackUsed) {
            const totalPromotions = this.lodStats.l0_to_l1 + this.lodStats.l1_to_l2 + this.lodStats.l2_to_l3;
            this.lodStats.fallback_rate = totalPromotions > 0 
                ? (this.lodStats.l0_to_l1 / totalPromotions) 
                : 0;
        }
        
        return result;
    }
    
    getFileNode(path: string) {
        if (!FeatureFlags.isEnabled(FeatureFlags.UCG_ENABLED)) {
            return undefined;
        }
        return this.getUCG().getNode(path);
    }
    
    getCurrentLOD(path: string): LOD_LEVEL {
        if (!FeatureFlags.isEnabled(FeatureFlags.UCG_ENABLED)) {
            return 0;
        }
        const node = this.getUCG().getNode(path);
        return node?.lod ?? 0;
    }
    
    invalidate(path: string, cascade: boolean = false): void {
        if (!FeatureFlags.isEnabled(FeatureFlags.UCG_ENABLED)) {
            return;
        }
        this.getUCG().invalidate(path, cascade);
    }
    
    private async validateDualWrite(path: string, ucgResult: LODResult): Promise<void> {
        // Compare UCG result with legacy cache
        // Log inconsistencies for debugging
        try {
            if (ucgResult.currentLOD >= 2) {
                const ucgNode = this.getUCG().getNode(path);
                const legacySkeleton = this.skeletonCache?.get(path);
                
                if (ucgNode?.skeleton && legacySkeleton?.skeleton) {
                    if (ucgNode.skeleton !== legacySkeleton.skeleton) {
                        console.warn(`[DualWrite] Inconsistency detected in ${path}`);
                        console.warn(`  UCG skeleton length: ${ucgNode.skeleton.length}`);
                        console.warn(`  Legacy skeleton length: ${legacySkeleton.skeleton.length}`);
                    }
                }
            }
        } catch (error) {
            console.error(`[DualWrite] Validation error for ${path}:`, error);
        }
    }
}
```

**Checklist for 2.3:**
- [ ] Implement complete `ensureLOD()` in AstManager
- [ ] Add UCG lazy initialization in AstManager
- [ ] Implement dual-write validation logic
- [ ] Update LOD promotion stats tracking
- [ ] Add integration test: UCG + legacy caches side-by-side
- [ ] Verify dual-write logs inconsistencies correctly
- [ ] Test feature flag combinations (UCG only, TopologyScanner only, both)
- [ ] Commit: "feat(lod): Complete AstManager integration with UCG and dual-write validation"

**Phase 2 Completion Checklist:**
- [ ] TopologyScanner: <2ms extraction, 95%+ accuracy
- [ ] UCG: All LOD promotions work (0→1, 1→2, 2→3)
- [ ] Dependency edges correctly built and maintained
- [ ] Cascade invalidation works
- [ ] LRU eviction maintains graph consistency
- [ ] Dual-write validation detects inconsistencies
- [ ] All tests pass: `npm test`
- [ ] Benchmark shows expected performance gains
- [ ] Git tag: `v0.2.0-lod-phase2`

---

### Phase 3: Pillar Integration (Week 6-7)
**Goal:** Refactor pillars to use UCG and LOD-based analysis.

---

#### 3.1 ExplorePillar LOD 1 Adoption

**File: `src/orchestration/pillars/ExplorePillar.ts`** (Key modifications)
```typescript
// CRITICAL: Add these imports at the top
import { UnifiedContextGraph } from '../context/UnifiedContextGraph.js';
import { FeatureFlags } from '../../config/FeatureFlags.js';

export class ExplorePillar {
    // ... existing fields ...
    
    async execute(context: OrchestrationContext, intent: ParsedIntent): Promise<ExploreResponse> {
        // ... existing code ...
        
        // NEW: Get UCG from context (if enabled)
        let ucg: UnifiedContextGraph | undefined;
        if (FeatureFlags.isEnabled(FeatureFlags.ADAPTIVE_FLOW_ENABLED)) {
            ucg = context.getState<UnifiedContextGraph>('ucg');
            if (!ucg) {
                ucg = new UnifiedContextGraph(this.rootPath);
                context.setState('ucg', ucg);
            }
        }
        
        // ... search execution ...
        
        // NEW: Use LOD 1 for search results
        if (ucg && results.length > 0) {
            // Promote all search results to LOD 1 in parallel
            await Promise.all(
                results.map(r => ucg!.ensureLOD({ path: r.filePath, minLOD: 1 }))
            );
            
            // Enrich results with topology context
            for (const result of results) {
                const node = ucg.getNode(result.filePath);
                if (node?.topology) {
                    result.metadata = {
                        ...result.metadata,
                        imports: node.topology.imports.length,
                        exports: node.topology.exports.length,
                        dependents: node.dependents.size
                    };
                }
            }
        }
        
        // ... rest of explore logic ...
    }
}
```

**Testing:**
```typescript
// src/tests/ExplorePillar-LOD.test.ts
describe('ExplorePillar with LOD', () => {
    it('should use LOD 1 for search results when enabled', async () => {
        FeatureFlags.set(FeatureFlags.ADAPTIVE_FLOW_ENABLED, true);
        
        const pillar = new ExplorePillar(/* ... */);
        const context = new OrchestrationContext();
        
        const result = await pillar.execute(context, { query: 'search term' });
        
        // Verify UCG was used
        const ucg = context.getState<UnifiedContextGraph>('ucg');
        expect(ucg).toBeDefined();
        
        // Verify results have topology metadata
        const item = result.data.code[0];
        expect(item.metadata?.imports).toBeDefined();
    });
});
```

**Checklist for 3.1:**
- [ ] Add UCG initialization to ExplorePillar
- [ ] Modify search result processing to use LOD 1
- [ ] Enrich results with topology metadata (imports, exports, dependents)
- [ ] Add tests for ExplorePillar + UCG integration
- [ ] Benchmark: Verify 6x improvement in initial scan
- [ ] Test with feature flag disabled (backward compatibility)
- [ ] Commit: "feat(lod): Integrate UCG LOD 1 into ExplorePillar"

---

#### 3.2 UnderstandPillar Mixed-LOD Strategy

**File: `src/orchestration/pillars/UnderstandPillar.ts`** (Key modifications)
```typescript
export class UnderstandPillar {
    async execute(context: OrchestrationContext, intent: ParsedIntent): Promise<UnderstandResponse> {
        const ucg = context.getState<UnifiedContextGraph>('ucg');
        const targetFile = intent.args.goal; // File to understand
        
        if (ucg) {
            // Core file: LOD 3 (full semantic)
            await ucg.ensureLOD({ path: targetFile, minLOD: 3 });
            
            // Direct dependencies: LOD 2 (structure)
            const directDeps = ucg.getEdges(targetFile, 'outgoing');
            await Promise.all(
                directDeps.map(dep => ucg.ensureLOD({ path: dep, minLOD: 2 }))
            );
            
            // Transitive dependencies (depth 2): LOD 1 (topology only)
            const transitiveDeps = await ucg.getTransitiveDependencies(targetFile, { maxDepth: 2 });
            await Promise.all(
                transitiveDeps.map(dep => ucg.ensureLOD({ path: dep, minLOD: 1 }))
            );
            
            // Generate insights using mixed-LOD graph
            const insights = this.generateInsights(ucg, targetFile);
            return { success: true, insights };
        }
        
        // Fallback to legacy logic
        return this.legacyUnderstand(intent);
    }
}
```

**Checklist for 3.2:**
- [ ] Implement mixed-LOD strategy (LOD 3 for core, LOD 2 for direct deps, LOD 1 for transitive)
- [ ] Test token savings (should be 60-70% for large dependency graphs)
- [ ] Verify semantic analysis still works with partial LODs
- [ ] Commit: "feat(lod): Implement mixed-LOD strategy in UnderstandPillar"

---

#### 3.3 ChangePillar Impact Analysis

**File: `src/orchestration/pillars/ChangePillar.ts`** (Key modifications)
```typescript
export class ChangePillar {
    async execute(context: OrchestrationContext, intent: ParsedIntent): Promise<ChangeResponse> {
        const ucg = context.getState<UnifiedContextGraph>('ucg');
        const targetFiles = intent.args.targetFiles;
        
        if (ucg) {
            // Promote target files to LOD 3
            await Promise.all(
                targetFiles.map(f => ucg.ensureLOD({ path: f, minLOD: 3 }))
            );
            
            // Find impacted files (reverse dependencies)
            const impacted = new Set<string>();
            for (const target of targetFiles) {
                const dependents = ucg.getEdges(target, 'incoming');
                dependents.forEach(d => impacted.add(d));
            }
            
            // Promote impacted files to LOD 2 (verify signatures)
            await Promise.all(
                Array.from(impacted).map(f => ucg.ensureLOD({ path: f, minLOD: 2 }))
            );
            
            // Apply changes and verify consistency
            const result = await this.applyChanges(intent.args.edits);
            
            // Invalidate changed files (cascade to dependents)
            for (const target of targetFiles) {
                ucg.invalidate(target, true);
            }
            
            return result;
        }
        
        return this.legacyChange(intent);
    }
}
```

**Checklist for 3.3:**
- [ ] Use UCG reverse edges for impact discovery
- [ ] Promote impacted files to LOD 2 (not LOD 3, save time)
- [ ] Invalidate with cascade after changes
- [ ] Test impact analysis with complex dependency chains
- [ ] Commit: "feat(lod): Implement UCG-based impact analysis in ChangePillar"

---

#### 3.4 OrchestrationContext Integration

**File: `src/orchestration/OrchestrationEngine.ts`** (Ensure UCG is initialized)
```typescript
export class OrchestrationEngine {
    async executePillar(pillarName: string, intent: ParsedIntent): Promise<any> {
        const context = new OrchestrationContext();
        
        // CRITICAL: Initialize UCG if adaptive flow enabled
        if (FeatureFlags.isEnabled(FeatureFlags.ADAPTIVE_FLOW_ENABLED)) {
            const ucg = new UnifiedContextGraph(this.rootPath);
            context.setState('ucg', ucg);
        }
        
        const pillar = this.pillars.get(pillarName);
        return await pillar.execute(context, intent);
    }
}
```

**Checklist for 3.4:**
- [ ] Ensure UCG is initialized in OrchestrationEngine
- [ ] Verify UCG is shared across pillars within same session
- [ ] Test multi-pillar workflows (Explore → Understand → Change)
- [ ] Commit: "feat(lod): Centralize UCG initialization in OrchestrationEngine"

**Phase 3 Completion Checklist:**
- [ ] All 3 pillars (Explore, Understand, Change) use UCG
- [ ] Mixed-LOD strategies implemented and tested
- [ ] Token savings verified (60-70% for Understand)
- [ ] Performance improvements verified (6x for Explore)
- [ ] Backward compatibility maintained (feature flags work)
- [ ] Git tag: `v0.3.0-lod-phase3`

---

### Phase 4: Validation & Rollout (Week 8-10)
**Goal:** Ensure production readiness and gradual rollout.

---

#### 4.1 Performance Validation

**Update: `benchmarks/lod-comparison.ts`**
```typescript
// Add LOD 1 vs Full AST comparison
async function benchmarkLOD1(): Promise<BenchmarkResult> {
    FeatureFlags.set(FeatureFlags.ADAPTIVE_FLOW_ENABLED, true);
    FeatureFlags.set(FeatureFlags.TOPOLOGY_SCANNER_ENABLED, true);
    
    const ucg = new UnifiedContextGraph(process.cwd());
    const startTime = performance.now();
    
    for (const file of testFiles) {
        await ucg.ensureLOD({ path: file, minLOD: 1 });
    }
    
    const totalTimeMs = performance.now() - startTime;
    
    return {
        scenario: 'LOD 1 Topology Scan',
        files: testFiles.length,
        totalTimeMs,
        avgTimePerFileMs: totalTimeMs / testFiles.length,
        memoryUsedMB: /* measure */
    };
}
```

**Checklist for 4.1:**
- [ ] Run full benchmark suite: `npm run benchmark:lod`
- [ ] Verify LOD 1 extraction <2ms per file
- [ ] Verify LOD promotion latency: <100ms (L1→L2), <500ms (L2→L3)
- [ ] Verify memory usage <500MB for 10,000 files
- [ ] Document results in `benchmarks/reports/lod-final-$(date +%s).md`
- [ ] Compare with baseline (Phase 1): Should meet or exceed all targets

---

#### 4.2 Gradual Rollout

**Week 8: Internal (Canary)**
- [ ] Set `SMART_CONTEXT_ADAPTIVE_FLOW_ENABLED=canary` (restrict to specific users)
- [ ] Enable all logging: UCG promotions, TopologyScanner fallbacks
- [ ] Collect metrics: Export to `logs/adaptive-flow-canary.json`
- [ ] Monitor for 48 hours: Check promotion patterns, fallback rates

**Week 9: Beta (10%)**
- [ ] Enable for 10% of users (via feature flag)
- [ ] Enable dual-write validation: `SMART_CONTEXT_DUAL_WRITE_VALIDATION=true`
- [ ] Set up alerts: Consistency errors >1%, latency increase >20%
- [ ] Monitor for 1 week: Daily review of metrics

**Week 10: Full Rollout (100%)**
- [ ] Enable for all users: `SMART_CONTEXT_ADAPTIVE_FLOW_ENABLED=true`
- [ ] Disable dual-write: `SMART_CONTEXT_DUAL_WRITE_VALIDATION=false`
- [ ] Remove legacy code paths (if stable for 1 week)
- [ ] Archive old caches: Document migration path

---

#### 4.3 Monitoring Setup

**File: `src/utils/AdaptiveFlowMetrics.ts`** (NEW FILE)
```typescript
import { LODPromotionStats } from '../types.js';

export class AdaptiveFlowMetrics {
    private static metrics: {
        lod_promotions: { l0_to_l1: number; l1_to_l2: number; l2_to_l3: number };
        topology_scanner: { success_count: number; fallback_count: number; total_time_ms: number };
        ucg: { node_count: number; evictions: number; cascade_invalidations: number };
    } = {
        lod_promotions: { l0_to_l1: 0, l1_to_l2: 0, l2_to_l3: 0 },
        topology_scanner: { success_count: 0, fallback_count: 0, total_time_ms: 0 },
        ucg: { node_count: 0, evictions: 0, cascade_invalidations: 0 }
    };
    
    static recordPromotion(from: number, to: number): void {
        if (from === 0 && to >= 1) this.metrics.lod_promotions.l0_to_l1++;
        if (from <= 1 && to >= 2) this.metrics.lod_promotions.l1_to_l2++;
        if (from <= 2 && to === 3) this.metrics.lod_promotions.l2_to_l3++;
    }
    
    static recordTopologyScan(durationMs: number, fallbackUsed: boolean): void {
        if (fallbackUsed) {
            this.metrics.topology_scanner.fallback_count++;
        } else {
            this.metrics.topology_scanner.success_count++;
        }
        this.metrics.topology_scanner.total_time_ms += durationMs;
    }
    
    static getMetrics() {
        const total = this.metrics.topology_scanner.success_count + this.metrics.topology_scanner.fallback_count;
        return {
            ...this.metrics,
            topology_scanner: {
                ...this.metrics.topology_scanner,
                success_rate: total > 0 ? this.metrics.topology_scanner.success_count / total : 0,
                fallback_rate: total > 0 ? this.metrics.topology_scanner.fallback_count / total : 0,
                avg_duration_ms: total > 0 ? this.metrics.topology_scanner.total_time_ms / total : 0
            }
        };
    }
    
    static exportToFile(path: string): void {
        const fs = require('fs');
        fs.writeFileSync(path, JSON.stringify(this.getMetrics(), null, 2));
    }
}
```

**Alert Conditions:**
- [ ] TopologyScanner success_rate < 0.95 → Email alert + Slack notification
- [ ] UCG memory > 500MB → Auto-trigger LRU eviction audit
- [ ] LOD promotion L1→L3 > 50% → Log warning (LOD 1 not effective)

**Checklist for 4.3:**
- [ ] Implement AdaptiveFlowMetrics class
- [ ] Add metrics recording to UCG, TopologyScanner, AstManager
- [ ] Set up alert thresholds in monitoring system
- [ ] Create dashboard: Grafana/Datadog for real-time metrics
- [ ] Export metrics daily: `logs/adaptive-flow-$(date +%Y%m%d).json`

---

**Phase 4 Completion Checklist:**
- [ ] All performance targets met
- [ ] Gradual rollout completed successfully
- [ ] Metrics dashboard operational
- [ ] No critical bugs reported for 7 days
- [ ] Documentation complete (API docs, ADR, README)
- [ ] Git tag: `v1.0.0-adaptive-flow`

---

## Post-Implementation Monitoring

### Daily Checks (First 2 Weeks)
- [ ] Review `logs/adaptive-flow-*.json` for anomalies
- [ ] Check TopologyScanner fallback rate (target: <5%)
- [ ] Verify UCG memory usage (target: <500MB)
- [ ] Monitor user-reported issues

### Weekly Checks (First 2 Months)
- [ ] Analyze promotion patterns: Are files staying at optimal LOD?
- [ ] Review eviction rates: Is LRU policy too aggressive/conservative?
- [ ] Performance regression testing: Re-run benchmarks

### Monthly Optimization (Ongoing)
- [ ] Tune regex patterns if fallback rate increases
- [ ] Adjust UCG max_nodes based on usage patterns
- [ ] Optimize LOD promotion thresholds

---

## Troubleshooting Guide

### Issue: TopologyScanner Accuracy <95%
**Symptoms:** High fallback rate, incorrect import/export detection
**Diagnosis:**
1. Check `logs/topology-scanner-failures.log` for patterns
2. Identify file types with high failure rate
3. Test regex patterns against failing files

**Fix:**
1. Update regex patterns in `TopologyScanner.ts`
2. Add new test cases for edge cases
3. Re-run tests: `npm test -- TopologyScanner`
4. Deploy and monitor for 24 hours

### Issue: Memory > 500MB
**Symptoms:** UCG eviction rate > 30%, OOM errors
**Diagnosis:**
1. Check `ucg.getStats()` for node count
2. Profile memory usage: `node --inspect`
3. Identify files with large topology data

**Fix:**
1. Reduce `maxNodes` in UCG constructor
2. Implement more aggressive eviction (evict LOD 2/3 first)
3. Add memory limit alerts

### Issue: Inconsistent Dual-Write Results
**Symptoms:** UCG and legacy cache return different data
**Diagnosis:**
1. Enable verbose logging: `DEBUG=smart-context:*`
2. Compare UCG node vs SkeletonCache entry
3. Check cache invalidation timing

**Fix:**
1. Ensure both caches invalidated on file change
2. Add synchronization locks if race condition detected
3. Consider disabling dual-write and using UCG only

---

## Success Criteria Summary

**Must Have (Blocking):**
- [ ] TopologyScanner accuracy ≥95%
- [ ] LOD 1 extraction <2ms per file (p95)
- [ ] Memory usage <500MB for 10,000 files
- [ ] All existing tests pass
- [ ] No regressions in Explore/Understand/Change functionality

**Should Have (Non-Blocking):**
- [ ] 6x improvement in Explore initial scan
- [ ] 60-70% token savings in Understand
- [ ] Fallback rate <5%
- [ ] Zero consistency errors in dual-write mode

**Nice to Have (Future):**
- [ ] LOD 4: Advanced semantic (data-flow analysis)
- [ ] UCG persistence (disk snapshot for warm restart)
- [ ] Distributed UCG (Redis-backed for multi-instance)

---

## Missing Implementation Details

### File Watcher Integration

**File: `src/orchestration/context/FileWatcher.ts`** (NEW FILE)
```typescript
import * as fs from 'fs';
import * as chokidar from 'chokidar';
import { UnifiedContextGraph } from './UnifiedContextGraph.js';
import { FeatureFlags } from '../../config/FeatureFlags.js';

/**
 * File watcher for automatic UCG invalidation on file changes.
 * Monitors workspace files and triggers cascade invalidation.
 */
export class FileWatcher {
    private watcher?: chokidar.FSWatcher;
    private ucg: UnifiedContextGraph;
    private rootPath: string;
    private enabled: boolean;
    
    // Debounce multiple rapid changes to same file
    private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
    private readonly DEBOUNCE_MS = 100;
    
    constructor(ucg: UnifiedContextGraph, rootPath: string) {
        this.ucg = ucg;
        this.rootPath = rootPath;
        this.enabled = FeatureFlags.isEnabled(FeatureFlags.ADAPTIVE_FLOW_ENABLED);
    }
    
    /**
     * Start watching files for changes.
     * Ignores node_modules, .git, and other common ignore patterns.
     */
    start(): void {
        if (!this.enabled || this.watcher) return;
        
        console.log('[FileWatcher] Starting file watcher...');
        
        this.watcher = chokidar.watch(this.rootPath, {
            ignored: [
                '**/node_modules/**',
                '**/.git/**',
                '**/.venv/**',
                '**/.smart-context/**',
                '**/dist/**',
                '**/build/**',
                '**/*.log'
            ],
            persistent: true,
            ignoreInitial: true,
            awaitWriteFinish: {
                stabilityThreshold: 100,
                pollInterval: 50
            }
        });
        
        this.watcher
            .on('change', (path) => this.handleFileChange(path, 'change'))
            .on('unlink', (path) => this.handleFileChange(path, 'delete'))
            .on('add', (path) => this.handleFileChange(path, 'add'))
            .on('error', (error) => console.error('[FileWatcher] Error:', error));
        
        console.log('[FileWatcher] Watching for file changes in:', this.rootPath);
    }
    
    /**
     * Stop watching files.
     */
    stop(): void {
        if (this.watcher) {
            console.log('[FileWatcher] Stopping file watcher...');
            this.watcher.close();
            this.watcher = undefined;
        }
        
        // Clear pending debounce timers
        for (const timer of this.debounceTimers.values()) {
            clearTimeout(timer);
        }
        this.debounceTimers.clear();
    }
    
    /**
     * Handle file change event with debouncing.
     */
    private handleFileChange(filePath: string, event: 'change' | 'delete' | 'add'): void {
        // Clear existing debounce timer
        const existingTimer = this.debounceTimers.get(filePath);
        if (existingTimer) {
            clearTimeout(existingTimer);
        }
        
        // Set new debounce timer
        const timer = setTimeout(() => {
            this.processFileChange(filePath, event);
            this.debounceTimers.delete(filePath);
        }, this.DEBOUNCE_MS);
        
        this.debounceTimers.set(filePath, timer);
    }
    
    /**
     * Process file change after debounce.
     */
    private processFileChange(filePath: string, event: 'change' | 'delete' | 'add'): void {
        console.log(`[FileWatcher] File ${event}: ${filePath}`);
        
        const node = this.ucg.getNode(filePath);
        
        if (event === 'delete') {
            if (node) {
                // Remove node and update edges
                this.ucg.removeNode(filePath);
                console.log(`  ↳ Removed from UCG: ${filePath}`);
            }
        } else if (event === 'change') {
            if (node) {
                // Invalidate with cascade
                this.ucg.invalidate(filePath, true);
                console.log(`  ↳ Invalidated (cascade): ${filePath} (was LOD ${node.lod})`);
            }
        } else if (event === 'add') {
            // New file added - will be analyzed on demand
            console.log(`  ↳ New file detected: ${filePath}`);
        }
    }
    
    /**
     * Check if watcher is active.
     */
    isWatching(): boolean {
        return this.watcher !== undefined;
    }
}
```

**Integration with UCG:**
```typescript
// In UnifiedContextGraph.ts, add:
import { FileWatcher } from './FileWatcher.js';

export class UnifiedContextGraph {
    // ... existing fields ...
    private fileWatcher?: FileWatcher;
    
    constructor(rootPath: string, maxNodes: number = 5000, enableWatcher: boolean = true) {
        // ... existing initialization ...
        
        if (enableWatcher) {
            this.fileWatcher = new FileWatcher(this, rootPath);
            this.fileWatcher.start();
        }
    }
    
    /**
     * Remove a node from the graph (called by FileWatcher on delete).
     */
    removeNode(path: string): void {
        const node = this.nodes.get(path);
        if (!node) return;
        
        console.log(`[UCG] Removing node: ${path}`);
        
        // Remove all edges
        for (const dep of node.dependencies) {
            const depNode = this.nodes.get(dep);
            if (depNode) {
                depNode.removeDependent(path);
            }
        }
        
        for (const dependent of node.dependents) {
            const depNode = this.nodes.get(dependent);
            if (depNode) {
                depNode.removeDependency(path);
            }
        }
        
        // Remove from LRU
        const index = this.lruQueue.indexOf(path);
        if (index !== -1) {
            this.lruQueue.splice(index, 1);
        }
        
        // Delete node
        this.nodes.delete(path);
    }
    
    /**
     * Dispose resources (call on shutdown).
     */
    dispose(): void {
        this.fileWatcher?.stop();
        this.clear();
    }
}
```

**Checklist:**
- [ ] Install chokidar: `npm install chokidar @types/chokidar`
- [ ] Create FileWatcher.ts with file system monitoring
- [ ] Add debouncing (100ms) to avoid rapid re-invalidation
- [ ] Integrate with UCG constructor
- [ ] Test file change detection: `touch src/test.ts` should trigger invalidation
- [ ] Test file deletion: `rm src/test.ts` should remove node
- [ ] Verify cascade invalidation works on file change
- [ ] Add FileWatcher.test.ts with mock filesystem

---

### Module Resolution Enhancement

**File: `src/ast/resolution/ModuleResolver.ts`** (NEW FILE - Enhanced version)
```typescript
import * as fs from 'fs';
import * as path from 'path';

/**
 * Enhanced module resolver for import path resolution.
 * Handles:
 * - Relative imports (./foo, ../bar)
 * - Absolute imports (from rootPath)
 * - tsconfig.json path mappings
 * - index files
 * - Multiple extensions (.ts, .tsx, .js, .jsx, .mts, .cts)
 */
export class ModuleResolver {
    private rootPath: string;
    private pathMappings: Map<string, string[]> = new Map();
    private extensionPriority = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
    
    constructor(rootPath: string) {
        this.rootPath = rootPath;
        this.loadTsConfig();
    }
    
    /**
     * Load tsconfig.json path mappings.
     */
    private loadTsConfig(): void {
        const tsconfigPath = path.join(this.rootPath, 'tsconfig.json');
        
        if (!fs.existsSync(tsconfigPath)) {
            console.log('[ModuleResolver] No tsconfig.json found, using default resolution');
            return;
        }
        
        try {
            const content = fs.readFileSync(tsconfigPath, 'utf-8');
            // Remove comments (simplified - doesn't handle all edge cases)
            const cleanContent = content.replace(/\/\*[\s\S]*?\*\/|\/\/.*/g, '');
            const tsconfig = JSON.parse(cleanContent);
            
            const paths = tsconfig.compilerOptions?.paths;
            if (paths) {
                for (const [pattern, mappings] of Object.entries(paths)) {
                    // Convert TS path pattern to regex
                    // e.g., "@components/*" -> "^@components/(.*)$"
                    const regexPattern = pattern.replace(/\*/g, '(.*)');
                    this.pathMappings.set(regexPattern, mappings as string[]);
                }
                
                console.log('[ModuleResolver] Loaded path mappings:', Object.keys(paths));
            }
        } catch (error) {
            console.error('[ModuleResolver] Failed to parse tsconfig.json:', error);
        }
    }
    
    /**
     * Resolve import source to absolute file path.
     * Returns null if module is external (node_modules).
     */
    resolve(fromPath: string, importSource: string): string | null {
        // Skip external modules (node_modules)
        if (!importSource.startsWith('.') && !importSource.startsWith('/') && !this.isPathMapping(importSource)) {
            return null;
        }
        
        // Relative imports
        if (importSource.startsWith('.')) {
            return this.resolveRelative(fromPath, importSource);
        }
        
        // Absolute imports (from rootPath)
        if (importSource.startsWith('/')) {
            return this.resolveAbsolute(importSource);
        }
        
        // Path mappings (e.g., @components/Button)
        return this.resolvePathMapping(importSource);
    }
    
    /**
     * Check if import source matches a tsconfig path mapping.
     */
    private isPathMapping(importSource: string): boolean {
        for (const pattern of this.pathMappings.keys()) {
            const regex = new RegExp(pattern);
            if (regex.test(importSource)) {
                return true;
            }
        }
        return false;
    }
    
    /**
     * Resolve relative import (./foo, ../bar).
     */
    private resolveRelative(fromPath: string, importSource: string): string | null {
        const fromDir = path.dirname(fromPath);
        const resolved = path.resolve(fromDir, importSource);
        
        return this.resolveWithExtensions(resolved);
    }
    
    /**
     * Resolve absolute import (from rootPath).
     */
    private resolveAbsolute(importSource: string): string | null {
        const resolved = path.join(this.rootPath, importSource);
        return this.resolveWithExtensions(resolved);
    }
    
    /**
     * Resolve tsconfig path mapping.
     * e.g., @components/Button -> src/components/Button.tsx
     */
    private resolvePathMapping(importSource: string): string | null {
        for (const [pattern, mappings] of this.pathMappings.entries()) {
            const regex = new RegExp(pattern);
            const match = importSource.match(regex);
            
            if (match) {
                // Try each mapping
                for (const mapping of mappings) {
                    // Replace * with captured group
                    let resolvedPath = mapping;
                    if (match[1]) {
                        resolvedPath = mapping.replace(/\*/g, match[1]);
                    }
                    
                    const fullPath = path.join(this.rootPath, resolvedPath);
                    const result = this.resolveWithExtensions(fullPath);
                    if (result) {
                        return result;
                    }
                }
            }
        }
        
        return null;
    }
    
    /**
     * Try to resolve file with various extensions and index patterns.
     */
    private resolveWithExtensions(basePath: string): string | null {
        // Try exact path first
        if (fs.existsSync(basePath) && fs.statSync(basePath).isFile()) {
            return basePath;
        }
        
        // Try with extensions
        for (const ext of this.extensionPriority) {
            const withExt = basePath + ext;
            if (fs.existsSync(withExt) && fs.statSync(withExt).isFile()) {
                return withExt;
            }
        }
        
        // Try index files
        if (fs.existsSync(basePath) && fs.statSync(basePath).isDirectory()) {
            for (const ext of this.extensionPriority) {
                const indexPath = path.join(basePath, `index${ext}`);
                if (fs.existsSync(indexPath) && fs.statSync(indexPath).isFile()) {
                    return indexPath;
                }
            }
        }
        
        return null;
    }
    
    /**
     * Reload tsconfig.json (call when tsconfig changes).
     */
    reloadConfig(): void {
        this.pathMappings.clear();
        this.loadTsConfig();
    }
}
```

**Integration with UCG:**
```typescript
// In UnifiedContextGraph.ts, replace resolveImport with:
import { ModuleResolver } from '../../ast/resolution/ModuleResolver.js';

export class UnifiedContextGraph {
    private moduleResolver: ModuleResolver;
    
    constructor(rootPath: string, maxNodes: number = 5000, enableWatcher: boolean = true) {
        // ... existing code ...
        this.moduleResolver = new ModuleResolver(rootPath);
    }
    
    private buildDependencyEdges(node: ContextNode, topology: TopologyInfo): void {
        // ... clear existing dependencies ...
        
        // Add new dependencies with enhanced resolution
        for (const imp of topology.imports) {
            const resolvedPath = this.moduleResolver.resolve(node.path, imp.source);
            if (resolvedPath) {
                node.addDependency(resolvedPath);
                
                let depNode = this.nodes.get(resolvedPath);
                if (!depNode) {
                    depNode = new ContextNode(resolvedPath, 0);
                    this.nodes.set(resolvedPath, depNode);
                }
                depNode.addDependent(node.path);
            }
        }
    }
}
```

**Tests:**
```typescript
// src/tests/ModuleResolver.test.ts
describe('ModuleResolver', () => {
    it('should resolve relative imports', () => {
        const resolver = new ModuleResolver('/project');
        // Test ./foo, ../bar
    });
    
    it('should resolve tsconfig path mappings', () => {
        // Test @components/*, @utils/*
    });
    
    it('should resolve index files', () => {
        // Test ./components -> ./components/index.ts
    });
});
```

**Checklist:**
- [ ] Create ModuleResolver.ts with tsconfig.json parsing
- [ ] Support path mappings (@components/*, @utils/*)
- [ ] Handle multiple extensions (.ts, .tsx, .mts, etc.)
- [ ] Support index file resolution
- [ ] Add comprehensive tests (10+ scenarios)
- [ ] Integrate with UnifiedContextGraph
- [ ] Test with real tsconfig.json from project

---

### Configuration System

**File: `src/config/AdaptiveFlowConfig.ts`** (NEW FILE)
```typescript
import * as fs from 'fs';
import * as path from 'path';

/**
 * Configuration for Adaptive Flow system.
 * Can be loaded from:
 * 1. Environment variables
 * 2. .adaptiveflowrc.json
 * 3. package.json (adaptiveFlow section)
 * 4. Defaults
 */
export interface AdaptiveFlowConfigOptions {
    // Feature toggles
    enabled: boolean;
    topologyScannerEnabled: boolean;
    ucgEnabled: boolean;
    dualWriteValidation: boolean;
    
    // Performance tuning
    ucgMaxNodes: number;
    ucgEvictionPolicy: 'lru' | 'lfu' | 'fifo';
    topologyScannerConfidenceThreshold: number;
    
    // File watching
    fileWatcherEnabled: boolean;
    fileWatcherDebounceMs: number;
    fileWatcherIgnorePatterns: string[];
    
    // Monitoring
    metricsEnabled: boolean;
    metricsExportPath: string;
    alertThresholds: {
        topologyScannerSuccessRate: number;
        ucgMemoryMB: number;
        promotionLatencyMs: number;
    };
    
    // Module resolution
    moduleExtensions: string[];
    respectTsConfig: boolean;
}

export class AdaptiveFlowConfig {
    private static instance: AdaptiveFlowConfig;
    private config: AdaptiveFlowConfigOptions;
    
    private constructor(rootPath: string) {
        // Load default config
        this.config = this.getDefaults();
        
        // Override with file config
        this.loadFromFile(rootPath);
        
        // Override with environment variables
        this.loadFromEnv();
    }
    
    static getInstance(rootPath?: string): AdaptiveFlowConfig {
        if (!AdaptiveFlowConfig.instance) {
            AdaptiveFlowConfig.instance = new AdaptiveFlowConfig(rootPath ?? process.cwd());
        }
        return AdaptiveFlowConfig.instance;
    }
    
    private getDefaults(): AdaptiveFlowConfigOptions {
        return {
            // Feature toggles
            enabled: false,
            topologyScannerEnabled: false,
            ucgEnabled: false,
            dualWriteValidation: false,
            
            // Performance tuning
            ucgMaxNodes: 5000,
            ucgEvictionPolicy: 'lru',
            topologyScannerConfidenceThreshold: 0.95,
            
            // File watching
            fileWatcherEnabled: true,
            fileWatcherDebounceMs: 100,
            fileWatcherIgnorePatterns: [
                '**/node_modules/**',
                '**/.git/**',
                '**/dist/**',
                '**/build/**'
            ],
            
            // Monitoring
            metricsEnabled: true,
            metricsExportPath: 'logs/adaptive-flow-metrics.json',
            alertThresholds: {
                topologyScannerSuccessRate: 0.95,
                ucgMemoryMB: 500,
                promotionLatencyMs: 500
            },
            
            // Module resolution
            moduleExtensions: ['.ts', '.tsx', '.js', '.jsx', '.mts', '.cts'],
            respectTsConfig: true
        };
    }
    
    private loadFromFile(rootPath: string): void {
        // Try .adaptiveflowrc.json
        const rcPath = path.join(rootPath, '.adaptiveflowrc.json');
        if (fs.existsSync(rcPath)) {
            try {
                const content = fs.readFileSync(rcPath, 'utf-8');
                const fileConfig = JSON.parse(content);
                this.mergeConfig(fileConfig);
                console.log('[AdaptiveFlowConfig] Loaded from .adaptiveflowrc.json');
                return;
            } catch (error) {
                console.error('[AdaptiveFlowConfig] Failed to parse .adaptiveflowrc.json:', error);
            }
        }
        
        // Try package.json
        const pkgPath = path.join(rootPath, 'package.json');
        if (fs.existsSync(pkgPath)) {
            try {
                const content = fs.readFileSync(pkgPath, 'utf-8');
                const pkg = JSON.parse(content);
                if (pkg.adaptiveFlow) {
                    this.mergeConfig(pkg.adaptiveFlow);
                    console.log('[AdaptiveFlowConfig] Loaded from package.json');
                }
            } catch (error) {
                console.error('[AdaptiveFlowConfig] Failed to parse package.json:', error);
            }
        }
    }
    
    private loadFromEnv(): void {
        const env = process.env;
        
        if (env.SMART_CONTEXT_ADAPTIVE_FLOW_ENABLED) {
            this.config.enabled = env.SMART_CONTEXT_ADAPTIVE_FLOW_ENABLED === 'true';
        }
        
        if (env.SMART_CONTEXT_TOPOLOGY_SCANNER_ENABLED) {
            this.config.topologyScannerEnabled = env.SMART_CONTEXT_TOPOLOGY_SCANNER_ENABLED === 'true';
        }
        
        if (env.SMART_CONTEXT_UCG_ENABLED) {
            this.config.ucgEnabled = env.SMART_CONTEXT_UCG_ENABLED === 'true';
        }
        
        if (env.SMART_CONTEXT_UCG_MAX_NODES) {
            this.config.ucgMaxNodes = parseInt(env.SMART_CONTEXT_UCG_MAX_NODES, 10);
        }
        
        if (env.SMART_CONTEXT_METRICS_PATH) {
            this.config.metricsExportPath = env.SMART_CONTEXT_METRICS_PATH;
        }
    }
    
    private mergeConfig(partial: Partial<AdaptiveFlowConfigOptions>): void {
        this.config = { ...this.config, ...partial };
    }
    
    get(): AdaptiveFlowConfigOptions {
        return { ...this.config };
    }
    
    set(partial: Partial<AdaptiveFlowConfigOptions>): void {
        this.mergeConfig(partial);
    }
}
```

**Example .adaptiveflowrc.json:**
```json
{
  "enabled": true,
  "topologyScannerEnabled": true,
  "ucgEnabled": true,
  "ucgMaxNodes": 10000,
  "topologyScannerConfidenceThreshold": 0.90,
  "fileWatcherDebounceMs": 200,
  "alertThresholds": {
    "topologyScannerSuccessRate": 0.92,
    "ucgMemoryMB": 1000,
    "promotionLatencyMs": 1000
  }
}
```

**Checklist:**
- [ ] Create AdaptiveFlowConfig.ts with multi-source loading
- [ ] Support environment variables (highest priority)
- [ ] Support .adaptiveflowrc.json (medium priority)
- [ ] Support package.json (lowest priority)
- [ ] Document all configuration options in README
- [ ] Add schema validation (optional: use zod or joi)
- [ ] Create example config files in docs/examples/

---

### End-to-End Usage Examples

**File: `docs/examples/adaptive-flow-usage.md`** (NEW FILE)
```markdown
# Adaptive Flow: End-to-End Usage Examples

## Example 1: Explore → Understand → Change Workflow

This example shows a complete workflow using Adaptive Flow with LOD optimization.

### Scenario
User wants to find all files related to "authentication", understand the main auth file, and then refactor it.

### Step 1: Explore (LOD 1)
```typescript
// User query
const exploreIntent = {
    tool: 'explore',
    args: { query: 'authentication' }
};

// What happens internally:
const context = new OrchestrationContext();
const ucg = new UnifiedContextGraph(rootPath);
context.setState('ucg', ucg);

// Search finds 50 files
const searchResults = await searchEngine.search('authentication');

// Promote all to LOD 1 in parallel (fast topology scan)
await Promise.all(
    searchResults.map(r => ucg.ensureLOD({ path: r.path, minLOD: 1 }))
);
// Time: 50 files × 1.5ms = 75ms (vs 450ms with full AST)

// Enrich results with topology metadata
for (const result of searchResults) {
    const node = ucg.getNode(result.path);
    result.metadata = {
        imports: node.topology.imports.length,
        exports: node.topology.exports.length,
        dependents: node.dependents.size
    };
}

// Return top results with connectivity info
// e.g., "auth/AuthService.ts (15 dependents, highly connected)"
```

### Step 2: Understand (Mixed LOD)
```typescript
// User selects main auth file
const understandIntent = {
    tool: 'understand',
    args: { goal: 'auth/AuthService.ts', depth: 2 }
};

// Promote core file to LOD 3 (full semantic)
await ucg.ensureLOD({ path: 'auth/AuthService.ts', minLOD: 3 });
// Time: 8ms (full AST)

// Direct dependencies: LOD 2 (structure only)
const directDeps = ucg.getEdges('auth/AuthService.ts', 'outgoing');
// e.g., ['auth/TokenManager.ts', 'utils/crypto.ts']
await Promise.all(
    directDeps.map(dep => ucg.ensureLOD({ path: dep, minLOD: 2 }))
);
// Time: 2 files × 5ms = 10ms (skeleton only)

// Transitive deps (depth 2): LOD 1 (topology only)
const transitiveDeps = await ucg.getTransitiveDependencies(
    'auth/AuthService.ts',
    { maxDepth: 2 }
);
// e.g., 10 more files
await Promise.all(
    transitiveDeps.map(dep => ucg.ensureLOD({ path: dep, minLOD: 1 }))
);
// Time: 10 files × 1.5ms = 15ms

// Total time: 8 + 10 + 15 = 33ms
// vs Full AST for all 13 files: 13 × 9ms = 117ms
// Savings: 72% faster
```

### Step 3: Change (Impact Analysis with UCG)
```typescript
// User wants to refactor AuthService
const changeIntent = {
    tool: 'change',
    args: {
        targetFiles: ['auth/AuthService.ts'],
        edits: [/* ... */]
    }
};

// Already at LOD 3 from Understand step (no re-parsing!)

// Find impacted files using reverse edges
const impacted = ucg.getEdges('auth/AuthService.ts', 'incoming');
// e.g., ['pages/Login.tsx', 'pages/Signup.tsx', 'middleware/auth.ts']

// Promote impacted to LOD 2 to verify signatures match
await Promise.all(
    impacted.map(f => ucg.ensureLOD({ path: f, minLOD: 2 }))
);
// Time: 3 files × 5ms = 15ms

// Apply changes
await applyEdits(changeIntent.args.edits);

// Invalidate with cascade
ucg.invalidate('auth/AuthService.ts', true);
// Downgrades:
// - AuthService: LOD 3 → LOD 0
// - Direct dependents: LOD 2 → LOD 1
```

### Total Workflow Time
- **Explore**: 75ms (LOD 1 for 50 files)
- **Understand**: 33ms (Mixed LOD for 13 files)
- **Change**: 15ms (LOD 2 for 3 impacted files)
- **Total**: 123ms

**Without Adaptive Flow:**
- Explore: 450ms (Full AST for 50 files)
- Understand: 117ms (Full AST for 13 files)
- Change: 27ms (Full AST for 3 files)
- **Total**: 594ms

**Improvement: 4.8x faster**

---

## Example 2: Large Codebase (10,000 files)

### Cold Start
```typescript
// Server starts, UCG is empty
const ucg = new UnifiedContextGraph(rootPath, maxNodes: 10000);

// User searches for "database"
const results = await searchEngine.search('database');
// Returns 200 files

// Promote all to LOD 1
await Promise.all(
    results.map(r => ucg.ensureLOD({ path: r.path, minLOD: 1 }))
);
// Time: 200 × 1.5ms = 300ms

// UCG now has 200 nodes at LOD 1
// Memory: 200 × 2KB = 400KB
```

### Subsequent Queries
```typescript
// User searches for "user" (overlaps with previous search)
const results2 = await searchEngine.search('user');
// Returns 150 files, 50 overlap with previous search

// Only 100 new files need promotion
const newFiles = results2.filter(r => !ucg.getNode(r.path));
await Promise.all(
    newFiles.map(r => ucg.ensureLOD({ path: r.path, minLOD: 1 }))
);
// Time: 100 × 1.5ms = 150ms (vs 300ms)

// UCG now has 300 nodes
```

### File Change Event
```typescript
// User edits database/Connection.ts
// FileWatcher detects change

ucg.invalidate('database/Connection.ts', cascade: true);

// Cascade downgrades:
// - Connection.ts: LOD 3 → LOD 0
// - 15 dependents: LOD 2 → LOD 1 (keep topology)

// Next access will re-promote only what's needed
```

---

## Example 3: Error Handling & Fallback

### TopologyScanner Failure
```typescript
// Complex file with dynamic imports
const result = await ucg.ensureLOD({
    path: 'plugin-loader.ts',
    minLOD: 1
});

// TopologyScanner confidence < 0.95
// Automatic fallback to ImportExtractor
console.log(result.fallbackUsed); // true
console.log(result.confidence); // 1.0 (AST is accurate)
console.log(result.durationMs); // 8ms (slower than regex, but correct)
```

### UCG Memory Limit
```typescript
// UCG has 5000 nodes (at limit)
// New file needs analysis
await ucg.ensureLOD({ path: 'new-file.ts', minLOD: 1 });

// LRU eviction triggered
// Least recently used node evicted
// Edges updated to maintain consistency
const stats = ucg.getStats();
console.log(stats.evictions); // 1
console.log(stats.nodes); // 5000 (still at limit)
```

### Feature Flag Disabled
```typescript
// Adaptive Flow disabled
FeatureFlags.set(FeatureFlags.ADAPTIVE_FLOW_ENABLED, false);

// All ensureLOD calls fall back to full AST
const result = await astManager.ensureLOD({ path: 'file.ts', minLOD: 1 });
console.log(result.currentLOD); // 3 (always promotes to full)
console.log(result.fallbackUsed); // true
```

---

## Example 4: Monitoring & Metrics

### Exporting Metrics
```typescript
import { AdaptiveFlowMetrics } from './utils/AdaptiveFlowMetrics';

// Record promotions automatically (done by UCG)
// ...after some usage...

// Export metrics
const metrics = AdaptiveFlowMetrics.getMetrics();
console.log(metrics);
/*
{
  lod_promotions: {
    l0_to_l1: 500,
    l1_to_l2: 100,
    l2_to_l3: 20
  },
  topology_scanner: {
    success_count: 475,
    fallback_count: 25,
    success_rate: 0.95,
    fallback_rate: 0.05,
    avg_duration_ms: 1.8
  },
  ucg: {
    node_count: 500,
    evictions: 10,
    cascade_invalidations: 15
  }
}
*/

// Export to file
AdaptiveFlowMetrics.exportToFile('logs/metrics.json');
```

### Setting Up Alerts
```typescript
import { AdaptiveFlowConfig } from './config/AdaptiveFlowConfig';

const config = AdaptiveFlowConfig.getInstance();
const thresholds = config.get().alertThresholds;

// Check metrics against thresholds
const metrics = AdaptiveFlowMetrics.getMetrics();

if (metrics.topology_scanner.success_rate < thresholds.topologyScannerSuccessRate) {
    console.error('[ALERT] TopologyScanner success rate below threshold!');
    // Send alert to monitoring system
}

if (ucg.getStats().memoryEstimateMB > thresholds.ucgMemoryMB) {
    console.error('[ALERT] UCG memory usage above threshold!');
    // Trigger manual eviction or increase limit
}
```
```

**Checklist:**
- [ ] Create comprehensive usage examples document
- [ ] Add code samples for all 3 pillars with LOD
- [ ] Show error handling and fallback scenarios
- [ ] Document metrics and monitoring setup
- [ ] Add performance comparison tables
- [ ] Include troubleshooting tips

---

### Performance Profiling Tools

**File: `src/utils/LODProfiler.ts`** (NEW FILE)
```typescript
import * as fs from 'fs';

/**
 * Profiler for LOD operations.
 * Tracks timing, memory, and LOD distribution.
 */
export class LODProfiler {
    private sessions: Map<string, ProfileSession> = new Map();
    private currentSessionId?: string;
    
    /**
     * Start a new profiling session.
     */
    startSession(name: string): string {
        const sessionId = `${name}-${Date.now()}`;
        const session: ProfileSession = {
            id: sessionId,
            name,
            startTime: performance.now(),
            endTime: 0,
            operations: [],
            lodDistribution: { l0: 0, l1: 0, l2: 0, l3: 0 },
            memorySnapshots: []
        };
        
        this.sessions.set(sessionId, session);
        this.currentSessionId = sessionId;
        
        // Initial memory snapshot
        this.recordMemory(sessionId);
        
        return sessionId;
    }
    
    /**
     * Record an LOD operation.
     */
    recordOperation(op: {
        type: 'promotion' | 'invalidation' | 'eviction';
        path: string;
        fromLOD?: number;
        toLOD?: number;
        durationMs: number;
        fallbackUsed?: boolean;
    }): void {
        if (!this.currentSessionId) return;
        
        const session = this.sessions.get(this.currentSessionId);
        if (!session) return;
        
        session.operations.push({
            ...op,
            timestamp: performance.now()
        });
        
        // Update LOD distribution
        if (op.toLOD !== undefined) {
            const key = `l${op.toLOD}` as keyof typeof session.lodDistribution;
            session.lodDistribution[key]++;
        }
    }
    
    /**
     * Record memory usage.
     */
    private recordMemory(sessionId: string): void {
        const session = this.sessions.get(sessionId);
        if (!session) return;
        
        const memUsage = process.memoryUsage();
        session.memorySnapshots.push({
            timestamp: performance.now(),
            heapUsedMB: memUsage.heapUsed / 1024 / 1024,
            heapTotalMB: memUsage.heapTotal / 1024 / 1024
        });
    }
    
    /**
     * End profiling session and generate report.
     */
    endSession(sessionId?: string): ProfileReport {
        const id = sessionId ?? this.currentSessionId;
        if (!id) throw new Error('No active session');
        
        const session = this.sessions.get(id);
        if (!session) throw new Error(`Session ${id} not found`);
        
        session.endTime = performance.now();
        this.recordMemory(id);
        
        // Generate report
        const totalDuration = session.endTime - session.startTime;
        const operations = session.operations;
        
        const promotions = operations.filter(op => op.type === 'promotion');
        const avgPromotionTime = promotions.reduce((sum, op) => sum + op.durationMs, 0) / promotions.length;
        
        const fallbackCount = promotions.filter(op => op.fallbackUsed).length;
        const fallbackRate = fallbackCount / promotions.length;
        
        const memoryDelta = session.memorySnapshots.length > 1
            ? session.memorySnapshots[session.memorySnapshots.length - 1].heapUsedMB - session.memorySnapshots[0].heapUsedMB
            : 0;
        
        const report: ProfileReport = {
            sessionId: id,
            name: session.name,
            totalDurationMs: totalDuration,
            operations: {
                total: operations.length,
                promotions: promotions.length,
                invalidations: operations.filter(op => op.type === 'invalidation').length,
                evictions: operations.filter(op => op.type === 'eviction').length
            },
            timing: {
                avgPromotionMs: avgPromotionTime,
                fallbackRate
            },
            lodDistribution: session.lodDistribution,
            memory: {
                startMB: session.memorySnapshots[0]?.heapUsedMB ?? 0,
                endMB: session.memorySnapshots[session.memorySnapshots.length - 1]?.heapUsedMB ?? 0,
                deltaMB: memoryDelta
            }
        };
        
        this.currentSessionId = undefined;
        return report;
    }
    
    /**
     * Export report to file.
     */
    exportReport(report: ProfileReport, filePath: string): void {
        fs.writeFileSync(filePath, JSON.stringify(report, null, 2));
        console.log(`[LODProfiler] Report exported to: ${filePath}`);
    }
}

interface ProfileSession {
    id: string;
    name: string;
    startTime: number;
    endTime: number;
    operations: Array<{
        type: 'promotion' | 'invalidation' | 'eviction';
        path: string;
        fromLOD?: number;
        toLOD?: number;
        durationMs: number;
        fallbackUsed?: boolean;
        timestamp: number;
    }>;
    lodDistribution: {
        l0: number;
        l1: number;
        l2: number;
        l3: number;
    };
    memorySnapshots: Array<{
        timestamp: number;
        heapUsedMB: number;
        heapTotalMB: number;
    }>;
}

interface ProfileReport {
    sessionId: string;
    name: string;
    totalDurationMs: number;
    operations: {
        total: number;
        promotions: number;
        invalidations: number;
        evictions: number;
    };
    timing: {
        avgPromotionMs: number;
        fallbackRate: number;
    };
    lodDistribution: {
        l0: number;
        l1: number;
        l2: number;
        l3: number;
    };
    memory: {
        startMB: number;
        endMB: number;
        deltaMB: number;
    };
}
```

**Usage:**
```typescript
import { LODProfiler } from './utils/LODProfiler';

const profiler = new LODProfiler();

// Start profiling
const sessionId = profiler.startSession('explore-workflow');

// ... perform operations ...
await ucg.ensureLOD({ path: 'file.ts', minLOD: 1 });
profiler.recordOperation({
    type: 'promotion',
    path: 'file.ts',
    fromLOD: 0,
    toLOD: 1,
    durationMs: 1.5,
    fallbackUsed: false
});

// End profiling
const report = profiler.endSession();
profiler.exportReport(report, 'logs/profile-explore.json');

// Analyze report
console.log(`Total time: ${report.totalDurationMs}ms`);
console.log(`Promotions: ${report.operations.promotions}`);
console.log(`Fallback rate: ${(report.timing.fallbackRate * 100).toFixed(1)}%`);
console.log(`Memory delta: ${report.memory.deltaMB.toFixed(2)}MB`);
```

**Checklist:**
- [ ] Create LODProfiler.ts for performance tracking
- [ ] Integrate profiler with UCG operations
- [ ] Add profiler to benchmarks
- [ ] Generate reports for each phase validation
- [ ] Use profiler in production (optional, behind feature flag)

---

## Complete Implementation Checklist

### Pre-Implementation
- [ ] **Read entire ADR**: Understand all 4 phases
- [ ] **Review existing codebase**: Familiarize with AstManager, OrchestrationEngine, Pillars
- [ ] **Set up development environment**: Node.js 18+, TypeScript 5+, Jest
- [ ] **Create feature branch**: `git checkout -b feat/adaptive-flow-lod`
- [ ] **Install dependencies**: `npm install chokidar @types/chokidar`

### Phase 1: Foundation (Week 1-2)
- [ ] **1.1 LOD Types & Metadata**
  - [ ] Add LOD types to `src/types.ts` (exact insertion point: after line 50)
  - [ ] Extend `FileRecord` interface with LOD fields
  - [ ] Compile: `npm run build` (must succeed)
  - [ ] Test: `npm test` (all existing tests must pass)
  - [ ] Commit: "feat(lod): Add LOD type definitions"

- [ ] **1.2 Interface Definition**
  - [ ] Create `src/ast/AdaptiveAstManager.ts`
  - [ ] Create `src/config/FeatureFlags.ts`
  - [ ] Modify `src/ast/AstManager.ts` to implement interface
  - [ ] Add stub implementations (throw "not implemented")
  - [ ] Test feature flags: `SMART_CONTEXT_ADAPTIVE_FLOW_ENABLED=true npm start`
  - [ ] Commit: "feat(lod): Add AdaptiveAstManager interface and feature flags"

- [ ] **1.3 Test Infrastructure**
  - [ ] Create `src/tests/AdaptiveAstManager.test.ts` (15+ tests)
  - [ ] Create `benchmarks/lod-comparison.ts`
  - [ ] Add `benchmark:lod` script to `package.json`
  - [ ] Run: `npm test -- AdaptiveAstManager` (backward compat tests must pass)
  - [ ] Run: `npm run benchmark:lod` (capture baseline metrics)
  - [ ] Document baseline: `benchmarks/reports/lod-baseline-$(date +%s).md`
  - [ ] Commit: "feat(lod): Add test infrastructure and LOD benchmark"

- [ ] **Phase 1 Validation**
  - [ ] All TypeScript compiles
  - [ ] All tests pass (100% backward compatibility)
  - [ ] Feature flags functional
  - [ ] Benchmark captures baseline
  - [ ] Code review completed
  - [ ] Git tag: `v0.1.0-lod-phase1`

### Phase 2: TopologyScanner & UCG (Week 3-5)
- [ ] **2.1 TopologyScanner**
  - [ ] Create `src/ast/topology/` directory
  - [ ] Implement `TopologyScanner.ts` (800+ lines, all regex patterns)
  - [ ] Implement comment removal logic
  - [ ] Implement confidence calculation
  - [ ] Implement AST fallback
  - [ ] Create `src/tests/TopologyScanner.test.ts` (25+ tests)
  - [ ] Test all regex patterns with edge cases
  - [ ] Verify <2ms extraction time
  - [ ] Verify 95%+ accuracy vs ImportExtractor
  - [ ] Commit: "feat(lod): Implement TopologyScanner with regex extraction"

- [ ] **2.2 UnifiedContextGraph**
  - [ ] Create `src/orchestration/context/ContextNode.ts`
  - [ ] Create `src/orchestration/context/UnifiedContextGraph.ts` (500+ lines)
  - [ ] Implement LOD promotion logic (L0→L1, L1→L2, L2→L3)
  - [ ] Implement dependency edge management
  - [ ] Implement cascade invalidation
  - [ ] Implement LRU eviction
  - [ ] Create `src/tests/UnifiedContextGraph.test.ts` (20+ tests)
  - [ ] Test promotion scenarios
  - [ ] Test invalidation cascade
  - [ ] Test eviction maintains graph consistency
  - [ ] Commit: "feat(lod): Implement UnifiedContextGraph"

- [ ] **2.3 Cache Integration & Dual-Write**
  - [ ] Complete `ensureLOD()` implementation in AstManager
  - [ ] Add UCG lazy initialization
  - [ ] Implement dual-write validation logic
  - [ ] Update LOD promotion stats
  - [ ] Test UCG + legacy cache side-by-side
  - [ ] Commit: "feat(lod): Complete AstManager UCG integration"

- [ ] **Phase 2 Validation**
  - [ ] TopologyScanner: <2ms, 95%+ accuracy
  - [ ] UCG: All promotions work
  - [ ] Dependency edges correct
  - [ ] Cascade invalidation works
  - [ ] LRU eviction maintains consistency
  - [ ] Dual-write validation functional
  - [ ] All tests pass
  - [ ] Benchmark shows expected gains
  - [ ] Git tag: `v0.2.0-lod-phase2`

### Phase 3: Pillar Integration (Week 6-7)
- [ ] **3.1 ExplorePillar**
  - [ ] Add UCG initialization
  - [ ] Modify search result processing (use LOD 1)
  - [ ] Add topology metadata enrichment
  - [ ] Create tests: `src/tests/ExplorePillar-LOD.test.ts`
  - [ ] Benchmark: Verify 6x improvement
  - [ ] Test backward compatibility (flag disabled)
  - [ ] Commit: "feat(lod): Integrate UCG into ExplorePillar"

- [ ] **3.2 UnderstandPillar**
  - [ ] Implement mixed-LOD strategy (L3 core, L2 deps, L1 transitive)
  - [ ] Test token savings (60-70% for large graphs)
  - [ ] Verify semantic analysis still accurate
  - [ ] Commit: "feat(lod): Implement mixed-LOD in UnderstandPillar"

- [ ] **3.3 ChangePillar**
  - [ ] Use UCG reverse edges for impact discovery
  - [ ] Promote impacted files to LOD 2 (not LOD 3)
  - [ ] Implement cascade invalidation on change
  - [ ] Test complex dependency chains
  - [ ] Commit: "feat(lod): Implement UCG impact analysis in ChangePillar"

- [ ] **3.4 OrchestrationEngine**
  - [ ] Centralize UCG initialization
  - [ ] Verify UCG shared across pillars
  - [ ] Test multi-pillar workflows
  - [ ] Commit: "feat(lod): Centralize UCG in OrchestrationEngine"

- [ ] **Phase 3 Validation**
  - [ ] All 3 pillars use UCG
  - [ ] Mixed-LOD strategies implemented
  - [ ] Token savings verified
  - [ ] Performance improvements verified
  - [ ] Backward compatibility maintained
  - [ ] Git tag: `v0.3.0-lod-phase3`

### Phase 4: Validation & Rollout (Week 8-10)
- [ ] **4.1 Performance Validation**
  - [ ] Update `benchmarks/lod-comparison.ts`
  - [ ] Add LOD 1 vs Full AST comparison
  - [ ] Run full benchmark suite
  - [ ] Verify all performance targets met:
    - [ ] LOD 1 extraction <2ms
    - [ ] Promotion latency <100ms (L1→L2), <500ms (L2→L3)
    - [ ] Memory <500MB for 10k files
  - [ ] Document results: `benchmarks/reports/lod-final-$(date +%s).md`

- [ ] **4.2 Gradual Rollout**
  - [ ] **Week 8: Canary**
    - [ ] Enable for internal users
    - [ ] Enable all logging
    - [ ] Collect metrics: `logs/adaptive-flow-canary.json`
    - [ ] Monitor for 48 hours
  - [ ] **Week 9: Beta (10%)**
    - [ ] Enable dual-write validation
    - [ ] Set up alerts (consistency >1%, latency >20%)
    - [ ] Monitor for 1 week
  - [ ] **Week 10: Full (100%)**
    - [ ] Enable for all users
    - [ ] Disable dual-write
    - [ ] Remove legacy code paths (if stable)
    - [ ] Archive old caches

- [ ] **4.3 Monitoring Setup**
  - [ ] Implement `AdaptiveFlowMetrics.ts`
  - [ ] Add metrics recording to all components
  - [ ] Set up alert thresholds
  - [ ] Create metrics dashboard
  - [ ] Export metrics daily

- [ ] **Phase 4 Validation**
  - [ ] All performance targets met
  - [ ] Rollout completed successfully
  - [ ] Metrics operational
  - [ ] No critical bugs (7 days)
  - [ ] Documentation complete
  - [ ] Git tag: `v1.0.0-adaptive-flow`

### Additional Components (Optional but Recommended)
- [ ] **File Watcher**
  - [ ] Install chokidar
  - [ ] Create `FileWatcher.ts`
  - [ ] Integrate with UCG
  - [ ] Test file change detection
  - [ ] Commit: "feat(lod): Add file watcher for auto-invalidation"

- [ ] **Module Resolver**
  - [ ] Create `ModuleResolver.ts`
  - [ ] Support tsconfig.json path mappings
  - [ ] Handle multiple extensions
  - [ ] Test with real tsconfig
  - [ ] Commit: "feat(lod): Add enhanced module resolver"

- [ ] **Configuration System**
  - [ ] Create `AdaptiveFlowConfig.ts`
  - [ ] Support .adaptiveflowrc.json
  - [ ] Document all options
  - [ ] Create example configs
  - [ ] Commit: "feat(lod): Add configuration system"

- [ ] **Usage Examples**
  - [ ] Create `docs/examples/adaptive-flow-usage.md`
  - [ ] Add 4 end-to-end examples
  - [ ] Include performance comparisons
  - [ ] Document monitoring setup
  - [ ] Commit: "docs(lod): Add comprehensive usage examples"

- [ ] **Performance Profiler**
  - [ ] Create `LODProfiler.ts`
  - [ ] Integrate with benchmarks
  - [ ] Generate profiling reports
  - [ ] Commit: "feat(lod): Add LOD performance profiler"

### Post-Implementation
- [ ] **Documentation**
  - [ ] Update README.md with Adaptive Flow overview
  - [ ] Update API documentation
  - [ ] Create migration guide for users
  - [ ] Add troubleshooting guide to docs
  - [ ] Record demo video (optional)

- [ ] **Final Validation**
  - [ ] Full integration test suite passes
  - [ ] Performance benchmarks show expected improvements
  - [ ] Memory usage within limits
  - [ ] No regressions in existing functionality
  - [ ] Code coverage >80%

- [ ] **Release Preparation**
  - [ ] Update CHANGELOG.md
  - [ ] Bump version in package.json
  - [ ] Create release notes
  - [ ] Tag release: `git tag v1.0.0`
  - [ ] Publish to npm (if applicable)

---

## Verification Commands

Run these commands at each phase to verify correctness:

```bash
# TypeScript compilation
npm run build

# All tests
npm test

# Specific test suites
npm test -- AdaptiveAstManager
npm test -- TopologyScanner
npm test -- UnifiedContextGraph
npm test -- ExplorePillar-LOD

# Benchmarks
npm run benchmark:lod

# Type checking only
npx tsc --noEmit

# Linting
npm run lint

# Coverage
npm test -- --coverage

# Feature flags test
SMART_CONTEXT_ADAPTIVE_FLOW_ENABLED=true npm start
SMART_CONTEXT_TOPOLOGY_SCANNER_ENABLED=true npm start

# Metrics export
node -e "require('./src/utils/AdaptiveFlowMetrics').exportToFile('logs/test-metrics.json')"

# Profile a workflow
node --inspect benchmarks/lod-comparison.ts
```

---

## Key Files Summary

| File | Lines | Purpose | Phase |
|------|-------|---------|-------|
| `src/types.ts` | +120 | LOD types, interfaces | 1.1 |
| `src/ast/AdaptiveAstManager.ts` | ~100 | Interface definition | 1.2 |
| `src/config/FeatureFlags.ts` | ~80 | Feature toggle system | 1.2 |
| `src/ast/AstManager.ts` | +150 | Implementation | 1.2, 2.3 |
| `src/tests/AdaptiveAstManager.test.ts` | ~200 | Unit tests | 1.3 |
| `benchmarks/lod-comparison.ts` | ~150 | Performance benchmark | 1.3 |
| `src/ast/topology/TopologyScanner.ts` | ~800 | Regex extraction | 2.1 |
| `src/tests/TopologyScanner.test.ts` | ~400 | Scanner tests | 2.1 |
| `src/orchestration/context/ContextNode.ts` | ~150 | Graph node | 2.2 |
| `src/orchestration/context/UnifiedContextGraph.ts` | ~500 | UCG core | 2.2 |
| `src/tests/UnifiedContextGraph.test.ts` | ~300 | UCG tests | 2.2 |
| `src/orchestration/context/FileWatcher.ts` | ~200 | Auto-invalidation | Optional |
| `src/ast/resolution/ModuleResolver.ts` | ~250 | Import resolution | Optional |
| `src/config/AdaptiveFlowConfig.ts` | ~200 | Configuration | Optional |
| `src/utils/AdaptiveFlowMetrics.ts` | ~150 | Metrics tracking | 4.3 |
| `src/utils/LODProfiler.ts` | ~250 | Performance profiling | Optional |
| `docs/examples/adaptive-flow-usage.md` | ~600 | Usage examples | Optional |

**Total New Code**: ~4,500 lines
**Total Test Code**: ~900 lines
**Documentation**: ~1,200 lines

---

## Dependencies

### Required (Install Immediately)
```bash
npm install chokidar
npm install -D @types/chokidar
```

### Optional (For Enhanced Features)
```bash
# Schema validation (for AdaptiveFlowConfig)
npm install zod

# Performance monitoring (advanced)
npm install prom-client
```

---

## Common Pitfalls to Avoid

1. **DON'T**: Forget to enable feature flags in tests
   ```typescript
   // BAD: Feature flag disabled, test uses fallback
   const result = await astManager.ensureLOD({ path: 'file.ts', minLOD: 1 });
   
   // GOOD: Enable flag first
   FeatureFlags.set(FeatureFlags.ADAPTIVE_FLOW_ENABLED, true);
   const result = await astManager.ensureLOD({ path: 'file.ts', minLOD: 1 });
   ```

2. **DON'T**: Clear UCG on every test (use beforeEach properly)
   ```typescript
   // BAD: UCG persists across tests
   describe('UCG tests', () => {
       const ucg = new UnifiedContextGraph(rootPath);
       it('test 1', () => { /* ... */ });
       it('test 2', () => { /* ... */ }); // Fails due to state from test 1
   });
   
   // GOOD: Clear state between tests
   describe('UCG tests', () => {
       let ucg: UnifiedContextGraph;
       beforeEach(() => {
           ucg = new UnifiedContextGraph(rootPath);
       });
       afterEach(() => {
           ucg.clear();
       });
   });
   ```

3. **DON'T**: Forget to update edges when removing nodes
   ```typescript
   // BAD: Leaves dangling edges
   this.nodes.delete(path);
   
   // GOOD: Clean up edges first
   const node = this.nodes.get(path);
   for (const dep of node.dependencies) {
       this.nodes.get(dep)?.removeDependent(path);
   }
   this.nodes.delete(path);
   ```

4. **DON'T**: Use `any` types (TypeScript will complain)
   ```typescript
   // BAD
   const node: any = ucg.getNode(path);
   
   // GOOD
   const node = ucg.getNode(path);
   if (node && node.lod >= 1) {
       // Type-safe access
   }
   ```

5. **DON'T**: Forget to handle file not found errors
   ```typescript
   // BAD: Will crash if file doesn't exist
   const content = fs.readFileSync(filePath, 'utf-8');
   
   // GOOD: Check existence first
   if (!fs.existsSync(filePath)) {
       throw new Error(`File not found: ${filePath}`);
   }
   const content = fs.readFileSync(filePath, 'utf-8');
   ```

---

## Debug Tips

### Enable Verbose Logging
```bash
DEBUG=smart-context:* npm start
```

### Inspect UCG State
```typescript
// In dev console or test
const ucg = context.getState<UnifiedContextGraph>('ucg');
console.log(ucg.getStats());
console.log('Nodes:', Array.from(ucg.getNode.keys()));
```

### Profile a Specific Operation
```typescript
import { LODProfiler } from './utils/LODProfiler';

const profiler = new LODProfiler();
const sessionId = profiler.startSession('debug-promotion');

// ... operation ...

const report = profiler.endSession();
console.log(JSON.stringify(report, null, 2));
```

### Test Regex Patterns
```typescript
// Quick test in Node REPL
const pattern = /import\s+{([^}]+)}\s+from\s+['"]([^'"]+)['"]/g;
const content = `import { foo, bar } from 'module';`;
const matches = Array.from(content.matchAll(pattern));
console.log(matches);
```

---

## Success Metrics

Track these metrics to validate success:

| Metric | Target | Measurement |
|--------|--------|-------------|
| TopologyScanner accuracy | ≥95% | Compare with ImportExtractor results |
| LOD 1 extraction time | <2ms (p95) | Benchmark 1000 files |
| Explore initial scan improvement | 6x faster | Before/after comparison |
| Understand token savings | 60-70% | Token count for dependency graph |
| UCG memory usage | <500MB for 10k files | `ucg.getStats().memoryEstimateMB` |
| Fallback rate | <5% | `metrics.topology_scanner.fallback_rate` |
| Test coverage | >80% | `npm test -- --coverage` |
| Zero regressions | 100% | All existing tests pass |

---

## Final Notes

**This is a LARGE refactoring** (4,500+ lines of new code). Take it slowly and methodically:

1. **Do NOT skip tests**: Every component needs comprehensive tests
2. **Commit frequently**: Small, atomic commits with clear messages
3. **Benchmark early**: Capture baselines before making changes
4. **Feature flags are your friend**: Always have a fallback
5. **Document as you go**: Don't leave docs for the end
6. **Ask for code reviews**: Fresh eyes catch issues
7. **Monitor in production**: Metrics are critical for success

**Estimated Timeline:**
- Phase 1: 1-2 weeks
- Phase 2: 2-3 weeks  
- Phase 3: 1-2 weeks
- Phase 4: 1-2 weeks
- **Total**: 5-9 weeks for full implementation

**Good luck! 🚀**
**Goal:** Implement LOD 1 extraction and centralized graph state.

2.1 **TopologyScanner Implementation**
*   Create `src/ast/topology/TopologyScanner.ts`
    *   Regex patterns for `import`/`export` extraction (inspiration: `PatternExtractor`)
    *   Confidence scoring: Track match quality (0.0-1.0)
    *   AST fallback: Delegate to `ImportExtractor`/`ExportExtractor` if confidence <0.95
*   Performance target: <2ms per file (measure with `benchmarks/main.ts`)
*   Test coverage: 90%+ with edge case validation (compare against full AST results)

2.2 **UnifiedContextGraph Implementation**
*   Create `src/orchestration/context/UnifiedContextGraph.ts`
    *   In-memory graph: `Map<FilePath, ContextNode>` with LOD state tracking
    *   Node structure: `{ path, lod, imports, exports, dependents }`
    *   Eviction policy: LRU with configurable limit (default: 5000 nodes)
*   Integration with existing caches:
    *   `SkeletonCache`: Add LOD 1 tier for topology-only data
    *   `SymbolIndex`: Remain as LOD 2+ data provider
    *   `DependencyGraph`: Transition to UCG edge provider role

2.3 **Cache Invalidation Strategy**
*   Implement cascade invalidation: File change → downgrade dependent nodes to LOD 1
*   Add file watcher integration: Auto-invalidate on `mtime` change
*   Dual-write validation (optional, for migration safety):
    *   Write to both UCG and legacy caches
    *   Compare results, log inconsistencies

### Phase 3: Pillar Integration (Week 6-7)
**Goal:** Refactor pillars to use UCG and LOD-based analysis.

3.1 **ExplorePillar LOD 1 Adoption**
*   Modify `ExplorePillar` (src/orchestration/pillars/ExplorePillar.ts):
    *   Use `ucg.ensureLOD({ path, minLOD: 1 })` for search results
    *   Build topology-based clusters instead of text-only matching
    *   Only promote to LOD 2 on user file selection (lazy promotion)
*   Expected improvement: 6x faster initial scan

3.2 **UnderstandPillar Mixed-LOD Strategy**
*   Modify `UnderstandPillar` (src/orchestration/pillars/UnderstandPillar.ts):
    *   Core target file → LOD 3 (full semantic)
    *   Direct dependencies → LOD 2 (structure/skeleton)
    *   Transitive dependencies (depth 2+) → LOD 1 (topology only)
*   Token savings: Estimated 60-70% for large dependency graphs

3.3 **ChangePillar Impact Analysis**
*   Modify `ChangePillar` (src/orchestration/pillars/ChangePillar.ts):
    *   Use UCG reverse edges for impact discovery
    *   Promote impacted files to LOD 2 for signature verification
    *   Avoid full re-parse of unchanged dependents

3.4 **OrchestrationContext Integration**
*   Inject UCG into `OrchestrationContext.sharedState`:
    ```typescript
    const ucg = context.getState<UnifiedContextGraph>('ucg') ?? new UnifiedContextGraph();
    context.setState('ucg', ucg);
    ```
*   Eliminate per-pillar `SymbolIndex` instantiation (reuse shared UCG)

### Phase 4: Validation & Rollout (Week 8-10)
**Goal:** Ensure production readiness and gradual rollout.

4.1 **Performance Validation**
*   Run benchmarks: Compare old vs new approach with `benchmarks/scenarios/*.json`
*   Measure:
    *   LOD 1 extraction time (target: <2ms)
    *   Promotion latency (target: <100ms for LOD 1→2, <500ms for LOD 2→3)
    *   Memory usage (target: <500MB for 10,000 files)
*   Success criteria: Meet or exceed all performance targets

4.2 **Gradual Rollout**
*   **Week 8:** Internal testing (feature flag = `canary`)
    *   Scope: Developer opt-in only
    *   Collect metrics: Promotion patterns, fallback rates, memory usage
*   **Week 9:** Beta users (10% traffic)
    *   Enable dual-write validation
    *   Monitor: Consistency errors, performance regressions
    *   Rollback trigger: >1% consistency errors or >20% latency increase
*   **Week 10:** Full rollout (100% traffic)
    *   Disable dual-write mode
    *   Remove legacy code paths (if stable)
    *   Archive old caches: Migrate `SkeletonCache` → UCG LOD 2 tier

4.3 **Monitoring Setup**
*   Add metrics to `src/utils/metrics.ts`:
    ```typescript
    interface AdaptiveFlowMetrics {
        lod_promotions: { l0_to_l1: number; l1_to_l2: number; l2_to_l3: number };
        topology_scanner: { success_rate: number; avg_duration_ms: number; fallback_rate: number };
        ucg: { node_count: number; memory_mb: number; eviction_rate: number };
    }
    ```
*   Alert conditions:
    *   `topology_scanner.success_rate < 0.95` → Regex pattern needs improvement
    *   `ucg.memory_mb > 500` → Eviction policy too conservative
    *   `lod_promotions.l1_to_l3 > 50%` → LOD 1 not effective, redesign needed

## Related ADRs

### Aligned With
*   **ADR-040 (Five Pillars Consolidation):** Builds on the pillar-centric architecture, enhancing inter-pillar coordination
*   **ADR-041 (Integrity Audit Modes):** LOD 1 topology scanning can accelerate integrity checks
*   **ADR-042-001 (P0 Observability):** Adaptive flow addresses cold start performance goals
*   **ADR-042-002 (P1 Hybrid ANN):** LOD 1 can provide fast candidate filtering before vector search

### Potential Conflicts
*   **ADR-033 (Six Pillars - Stateless Design):** 
    *   **Conflict:** ADR-033 designed pillars to be stateless with centralized orchestration
    *   **Resolution:** UCG is managed by OrchestrationEngine (centralized), not individual pillars. Pillars remain stateless consumers of UCG.
    *   **Compatibility:** UCG stored in `OrchestrationContext.sharedState` maintains centralization principle

## References

### Performance Data
*   `benchmarks/reports/full-report-1767430513134.md`: Baseline AST parsing metrics
*   `benchmarks/main.ts`: Benchmark infrastructure for LOD comparison tests

### Existing Components
*   `src/ast/skeleton/SkeletonCache.ts`: L1/L2 cache with mtime tracking (LOD 2 equivalent)
*   `src/ast/skeleton/SkeletonGenerator.ts`: Configurable detail levels (inspiration for LOD)
*   `src/indexing/dependency-graph/DependencyGraph.ts`: File-level dependency edges
*   `src/indexing/search/SymbolIndex.ts`: Symbol search with LRU cache
*   `src/ast/extractors/ImportExtractor.ts`: Full AST import extraction (fallback target)
*   `src/ast/extractors/ExportExtractor.ts`: Full AST export extraction (fallback target)

### Orchestration Infrastructure
*   `src/orchestration/OrchestrationEngine.ts`: Pillar registry and execution
*   `src/orchestration/context/OrchestrationContext.ts`: Shared state management
*   `src/orchestration/caching/CachingStrategy.ts`: LRU caching patterns
*   `src/orchestration/pillars/ExplorePillar.ts`: Evidence pack generation (LOD 1 target)
*   `src/orchestration/pillars/UnderstandPillar.ts`: Dependency analysis (mixed-LOD target)
*   `src/orchestration/pillars/ChangePillar.ts`: Impact analysis (UCG reverse edge target)

### Migration Patterns
*   `docs/adr/ADR-021-enterprise-core-enhancements.md`: Constructor injection pattern
*   `docs/adr/ADR-033-Six-Pillars-Architecture.md`: Stateless pillar design, deprecation strategy

## Appendix: Code Examples

### Example 1: ExplorePillar LOD 1 Usage

**Before (Full AST):**
```typescript
// ExplorePillar.ts
const results = await searchEngine.search(query);
for (const result of results) {
  const skeleton = await readTool({ filePath: result.path, view: 'skeleton' });
  // 8-9ms per file, full AST parsing
}
```

**After (LOD 1):**
```typescript
const ucg = context.getState<UnifiedContextGraph>('ucg');
const results = await searchEngine.search(query);

// Fast topology scan for all results
await Promise.all(
  results.map(r => ucg.ensureLOD({ path: r.path, minLOD: 1 }))
);

// Build topology-based clusters
const clusters = buildClusters(results.map(r => ucg.getNode(r.path)));
// 1-2ms per file (6x faster)

// Promote to LOD 2 only on user selection
const selectedFile = await userSelection(clusters);
await ucg.ensureLOD({ path: selectedFile, minLOD: 2 });
```

### Example 2: UnderstandPillar Mixed-LOD Strategy

**Before (All Full AST):**
```typescript
const deps = await dependencyGraph.getDependencies(filePath, 'both');
for (const dep of deps) {
  const skeleton = await readTool({ filePath: dep.to, view: 'skeleton' });
  // Expensive for transitive dependencies
}
```

**After (Staged LOD):**
```typescript
const ucg = context.getState<UnifiedContextGraph>('ucg');

// Core file: LOD 3 (full semantic analysis)
await ucg.ensureLOD({ path: filePath, minLOD: 3 });

// Direct dependencies: LOD 2 (structure for signatures)
const directDeps = await ucg.getEdges(filePath, 'outgoing');
await Promise.all(directDeps.map(d => ucg.ensureLOD({ path: d.to, minLOD: 2 })));

// Transitive dependencies: LOD 1 (topology only)
const transitiveDeps = await ucg.getTransitiveDependencies(filePath, { maxDepth: 2 });
await Promise.all(transitiveDeps.map(d => ucg.ensureLOD({ path: d, minLOD: 1 })));

// Token savings: 60-70% compared to full AST for all dependencies
```

### Example 3: TopologyScanner with Fallback

```typescript
// src/ast/topology/TopologyScanner.ts
export class TopologyScanner {
  async extract(filePath: string, content: string): Promise<TopologyInfo> {
    try {
      // Primary: Regex-based fast extraction
      const topology = this.regexExtractor.extract(content);
      
      if (topology.confidence > 0.95) {
        return { ...topology, fallbackUsed: false };
      }
      
      console.warn(`[TopologyScanner] Low confidence (${topology.confidence}) for ${filePath}`);
    } catch (error) {
      console.warn(`[TopologyScanner] Regex failed for ${filePath}: ${error.message}`);
    }
    
    // Fallback: Use existing ImportExtractor/ExportExtractor (full AST)
    const imports = await this.importExtractor.extract(filePath);
    const exports = await this.exportExtractor.extract(filePath);
    
    return {
      imports,
      exports,
      topLevelSymbols: exports.map(e => e.name),
      confidence: 1.0,
      fallbackUsed: true
    };
  }
}
```

### Example 4: UCG Cascade Invalidation

```typescript
// src/orchestration/context/UnifiedContextGraph.ts
export class UnifiedContextGraph {
  invalidate(path: string, cascade: boolean = true): void {
    const node = this.nodes.get(path);
    if (!node) return;
    
    // 1. Downgrade the changed file to LOD 0 (registry only)
    node.lod = 0;
    node.lastModified = Date.now();
    
    // 2. Cascade: Downgrade dependent files
    if (cascade) {
      for (const dependent of node.dependents) {
        if (dependent.lod >= 2) {
          // Keep structure, but invalidate semantic analysis
          dependent.lod = 1;
        }
      }
    }
    
    // 3. Invalidate legacy caches for compatibility during migration
    this.skeletonCache?.invalidate(path);
    this.symbolIndex?.invalidateFile(path);
  }
}
