# ADR-014: Smart File Profile - Token-Efficient Default File Reading

**Status:** Proposed  
**Date:** 2025-12-09  
**Author:** Software Architecture Team

---

## Context

The current `read_file` tool returns raw file content, which presents several problems:

1. **Token Waste**: A 500-line file consumes ~2000+ tokens even when the agent only needs to understand the file's structure.
2. **Missing Context**: Raw content lacks metadata (file size, line count) and semantic information (dependencies, usages).
3. **AI Confusion Risk**: When agents see complete code, they often try to re-implement or modify logic unnecessarily instead of making surgical changes.

We already have the building blocks for a smarter approach:
- `SkeletonGenerator` - Generates AST-based signature-only views
- `DependencyGraph` - Tracks imports/exports between files
- `ReferenceFinder` - Finds symbol usages across the project

## Decision

**Redesign `read_file` to return a "Smart File Profile" by default**, providing a structured summary instead of raw content. Full content remains accessible via an explicit `raw: true` flag.

### Smart File Profile Structure

```typescript
interface SmartFileProfile {
  // Section 1: Metadata
  metadata: {
    filePath: string;
    relativePath: string;
    sizeBytes: number;
    lineCount: number;
    language: string | null;      // Detected from extension
    lastModified?: string;        // ISO timestamp
  };

  // Section 2: Code Structure (Skeleton)
  structure: {
    skeleton: string;             // Folded view with `{ ... }` placeholders
    symbols: DefinitionSymbol[];  // Classes, functions, methods with signatures
  };

  // Section 3: Dependencies
  dependencies: {
    imports: ImportSymbol[];      // What this file imports
    exports: ExportSymbol[];      // What this file exports
    outgoing: string[];           // Files this file depends on (resolved paths)
  };

  // Section 4: Usage Summary (Impact)
  usage: {
    incomingCount: number;        // Number of files that import this file
    incomingFiles: string[];      // First N file paths (truncated for token efficiency)
    // Note: Full reference details available via `find_symbol_references`
  };

  // Section 5: AI Guidance Prompt
  guidance: {
    bodyHidden: true;             // Explicit flag: bodies are HIDDEN, not empty
    readFullHint: string;         // "Use read_file with raw: true for full content"
    readFragmentHint: string;     // "Use read_fragment with lineRanges for specific sections"
  };
}
```

### Example Output

```json
{
  "metadata": {
    "filePath": "/project/src/engine/Editor.ts",
    "relativePath": "src/engine/Editor.ts",
    "sizeBytes": 12450,
    "lineCount": 324,
    "language": "typescript"
  },
  "structure": {
    "skeleton": "export class AmbiguousMatchError extends Error {\n  constructor(message: string, details: { ... }) { ... }\n}\n\nexport class EditorEngine {\n  private rootPath: string;\n  constructor(rootPath: string) { ... }\n  public applyEdits(filePath: string, edits: Edit[], dryRun: boolean): Promise<EditResult> { ... }\n  private _findMatch(content: string, edit: Edit): MatchResult { ... }\n}",
    "symbols": [
      { "type": "class", "name": "AmbiguousMatchError", "signature": "class AmbiguousMatchError extends Error" },
      { "type": "class", "name": "EditorEngine", "signature": "class EditorEngine" },
      { "type": "method", "name": "applyEdits", "container": "EditorEngine", "signature": "applyEdits(filePath: string, edits: Edit[], dryRun: boolean): Promise<EditResult>" }
    ]
  },
  "dependencies": {
    "imports": [
      { "type": "import", "name": "Edit, EditResult", "source": "../types.js", "importKind": "named" }
    ],
    "exports": [
      { "type": "export", "name": "AmbiguousMatchError", "exportKind": "named" },
      { "type": "export", "name": "EditorEngine", "exportKind": "named" }
    ],
    "outgoing": ["src/types.ts"]
  },
  "usage": {
    "incomingCount": 3,
    "incomingFiles": ["src/index.ts", "src/engine/EditCoordinator.ts", "src/tests/Editor.test.ts"]
  },
  "guidance": {
    "bodyHidden": true,
    "readFullHint": "Use read_file({ filePath: '...', raw: true }) for complete source code.",
    "readFragmentHint": "Use read_fragment({ filePath: '...', lineRanges: [{start: N, end: M}] }) for specific sections."
  }
}
```

---

## Architecture

### Component Interaction

```
┌─────────────────────────────────────────────────────────────────────┐
│                    read_file Tool Handler                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  Input: { filePath, raw?: boolean }                                 │
│                           │                                          │
│              ┌────────────┴────────────┐                            │
│              ▼                         ▼                            │
│         raw: true                  raw: false (default)             │
│              │                         │                            │
│              ▼                         ▼                            │
│     Return raw content         ┌──────────────────┐                 │
│                                │ SmartProfileBuilder │               │
│                                └──────────────────┘                 │
│                                         │                            │
│           ┌─────────────┬───────────────┼───────────────┬──────┐   │
│           ▼             ▼               ▼               ▼      ▼   │
│     ┌──────────┐ ┌──────────────┐ ┌──────────────┐ ┌────────┐     │
│     │ fs.stat  │ │SkeletonGen   │ │DependencyGraph│ │RefFinder│    │
│     │ (meta)   │ │ (structure)  │ │ (deps)        │ │(usage) │     │
│     └──────────┘ └──────────────┘ └──────────────┘ └────────┘     │
│           │             │               │               │           │
│           └─────────────┴───────────────┴───────────────┘           │
│                                   │                                  │
│                                   ▼                                  │
│                        SmartFileProfile JSON                         │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

### New Component: `SmartProfileBuilder`

```typescript
// src/engine/SmartProfileBuilder.ts
export class SmartProfileBuilder {
  constructor(
    private rootPath: string,
    private skeletonGenerator: SkeletonGenerator,
    private dependencyGraph: DependencyGraph,
    private referenceFinder: ReferenceFinder
  ) {}

  async buildProfile(absPath: string, content: string): Promise<SmartFileProfile> {
    // Parallel execution for performance
    const [metadata, structure, dependencies, usage] = await Promise.all([
      this.buildMetadata(absPath, content),
      this.buildStructure(absPath, content),
      this.buildDependencies(absPath),
      this.buildUsageSummary(absPath)  // Lightweight summary only
    ]);

    return {
      metadata,
      structure,
      dependencies,
      usage,
      guidance: this.buildGuidance(absPath)
    };
  }
}
```

---

## Constraint Solutions

### Constraint 1: Token Efficiency

**Problem**: Default output must be smaller than raw content.

**Solution**:
- Skeleton uses `{ ... }` folding, compressing 500-line files to ~20-50 lines
- Dependency info is already compact (just import/export statements)
- Usage is summarized (count + first N files), not detailed

**Measurement**:
| File Size | Raw Tokens | Profile Tokens | Reduction |
|-----------|-----------|----------------|-----------|
| 100 lines | ~400      | ~150           | 62%       |
| 500 lines | ~2000     | ~200           | 90%       |
| 1000 lines| ~4000     | ~250           | 94%       |

### Constraint 2: Performance (Reference Finding Cost)

**Problem**: `ReferenceFinder.findReferences()` scans multiple files and is O(N) where N = number of importing files.

**Solution**: **Deferred/Lazy Loading with Summary-Only Default**

```typescript
interface UsageSummary {
  incomingCount: number;        // From DependencyGraph - O(1) lookup
  incomingFiles: string[];      // From DependencyGraph - O(1) lookup, first 5 only
  // Detailed references NOT included by default
}

async buildUsageSummary(absPath: string): Promise<UsageSummary> {
  // This is CHEAP - just graph lookup, no file scanning
  const incoming = await this.dependencyGraph.getDependencies(absPath, 'incoming');
  
  return {
    incomingCount: incoming.length,
    incomingFiles: incoming.slice(0, 5)  // Truncate for token efficiency
  };
}
```

**Key Insight**: 
- `DependencyGraph.getDependencies('incoming')` returns files that import this file
- This is a **graph traversal** (fast), not symbol-level reference finding (slow)
- For detailed symbol references, agents use `find_symbol_references` tool explicitly

**Performance Guarantee**:
| Operation | Time Complexity | Typical Latency |
|-----------|-----------------|-----------------|
| Metadata (fs.stat) | O(1) | <1ms |
| Skeleton (AST parse) | O(N) | 10-50ms |
| Dependencies (graph lookup) | O(1) | <1ms |
| Usage Summary (graph lookup) | O(1) | <1ms |
| **Total** | | **15-60ms** |

### Constraint 3: AI Safety (Hidden vs Empty Bodies)

**Problem**: AI might see `{ ... }` and think the function is empty or broken.

**Solution**: Explicit `guidance` section with clear signals:

```json
{
  "guidance": {
    "bodyHidden": true,
    "note": "Function and class bodies are COLLAPSED for token efficiency. The implementations exist but are hidden.",
    "readFullHint": "Use read_file({ filePath: '...', raw: true }) for complete source code.",
    "readFragmentHint": "Use read_fragment({ filePath: '...', lineRanges: [...] }) for specific line ranges."
  }
}
```

**Additional Safeguard**: The skeleton replacement marker is `{ ... }` (with spaces), not `{}` (empty block), making it visually distinct from actual empty implementations.

### Constraint 4: Backward Compatibility

**Problem**: Existing integrations expect raw content.

**Solution**: Opt-in via `raw: true` flag:

```typescript
// New tool schema
{
  name: "read_file",
  description: "Reads a file. By default returns a Smart Profile (structure, deps, usage). Use raw: true for full content.",
  inputSchema: {
    type: "object",
    properties: {
      filePath: { type: "string" },
      raw: { type: "boolean", default: false }  // NEW
    },
    required: ["filePath"]
  }
}

// Handler logic
case "read_file": {
  const absPath = this._getAbsPathAndVerify(args.filePath);
  const content = await readFileAsync(absPath, 'utf-8');
  
  if (args.raw === true) {
    // Legacy behavior
    return { content: [{ type: "text", text: content }] };
  }
  
  // New default: Smart Profile
  const profile = await this.profileBuilder.buildProfile(absPath, content);
  return { content: [{ type: "text", text: JSON.stringify(profile, null, 2) }] };
}
```

### Constraint 5: Module Reuse

**Solution**: All components already exist and are initialized in `SmartContextServer`:

```typescript
// In constructor - already available
this.skeletonGenerator = new SkeletonGenerator();
this.dependencyGraph = new DependencyGraph(this.rootPath, this.symbolIndex, this.moduleResolver);
this.referenceFinder = new ReferenceFinder(...);

// New addition
this.profileBuilder = new SmartProfileBuilder(
  this.rootPath,
  this.skeletonGenerator,
  this.dependencyGraph,
  this.referenceFinder  // Only used if detailed refs requested
);
```

---

## Implementation Plan

### Phase 1: Core Profile Builder (Day 1)
1. Create `src/engine/SmartProfileBuilder.ts`
2. Implement metadata + structure sections (reuse SkeletonGenerator)
3. Implement dependencies section (reuse DependencyGraph)
4. Write unit tests

### Phase 2: Usage Summary Integration (Day 2)
1. Add `incomingCount` using DependencyGraph
2. Add truncated `incomingFiles` list
3. Ensure DependencyGraph is built/warm on first call

### Phase 3: Tool Integration (Day 2)
1. Update `read_file` handler in `index.ts`
2. Add `raw` parameter to schema
3. Wire up SmartProfileBuilder
4. Integration tests

### Phase 4: Documentation & Guidance (Day 3)
1. Update tool descriptions for AI clarity
2. Add guidance section with hints
3. Update README with examples

---

## Alternative Considered

### Alternative A: Separate `read_file_smart` Tool
- **Rejected**: Fragments the API, agents must learn when to use which tool
- Smart default is more intuitive and backwards-compatible via flag

### Alternative B: Lazy Profile (Return Skeleton, Fetch Rest on Demand)
- **Rejected**: Requires multiple round trips, increases latency
- With graph-based usage (not ReferenceFinder), everything is fast enough in one call

### Alternative C: Include Full Reference Details in Profile
- **Rejected**: Would defeat token efficiency goal for highly-used files
- Summary (count + files) is sufficient for most decisions

---

## Consequences

### Positive
- **90%+ token reduction** for large files by default
- **Faster agent comprehension** - structured data vs. wall of code
- **Safer editing** - AI understands file structure before modifying
- **Zero breaking changes** - `raw: true` preserves old behavior

### Negative
- **Slight latency increase** (~50ms) for initial read due to AST parsing
- **Dependency graph must be warm** - first profile call may be slower (200-500ms)
- **Non-code files** return degraded profile (metadata only, no skeleton)

### Mitigations
- **Warmup**: Call `dependencyGraph.build()` during server initialization
- **Language Detection**: Gracefully degrade for unsupported languages
- **Cache**: SkeletonGenerator already caches parsed queries

---

## Success Metrics

1. **Token Reduction**: Measure avg tokens before/after for sample files
2. **Agent Efficiency**: Track tool call count for common tasks (fewer read_file calls = better)
3. **Latency P95**: Profile generation < 100ms for files under 1000 lines
4. **Adoption**: Zero complaints about missing raw content (easy escape hatch)

---

## References

- ADR-010: Smart Semantic Analysis (SkeletonGenerator, AstManager)
- ADR-001: Smart Context Architecture (2-stage retrieval philosophy)
- Existing modules: `SkeletonGenerator`, `DependencyGraph`, `ReferenceFinder`
