# ADR-013: Serena Feature Analysis & Strategic Enhancement Plan

**Status:** Proposed  
**Date:** 2024-12-08  
**Author:** Architecture Team  

## Context

We are evaluating the `oraios/serena` MCP server (16K+ GitHub stars) to identify high-value features that could enhance `smart-context-mcp` while maintaining our "Static Analysis Lite" philosophy—zero external dependencies, in-memory caching, and tree-sitter-based parsing.

### Current `smart-context-mcp` Capabilities
| Feature | Implementation |
|---------|---------------|
| AST Parsing | `web-tree-sitter` (WASM) |
| Symbol Index | In-memory `Map<string, SymbolInfo[]>` with mtime cache |
| Dependency Graph | Import/export tracking via `DependencyGraph.ts` |
| Module Resolution | Best-effort TypeScript/JS path aliasing |
| File Search | BM25 ranking, ripgrep integration |
| Skeleton Generation | Tree-sitter queries for structure extraction |

### Serena's Architecture (from codebase analysis)

Serena delegates semantic analysis to **Language Servers** (LSP) via their `solidlsp` library (fork of Microsoft's `multilspy`). Key characteristics:

1. **External Process Dependency**: Requires running language servers (`tsserver`, `pyright`, etc.)
2. **30+ Language Support**: Via LSP implementations
3. **Rich Semantic Tools**:
   - `find_symbol` / `find_referencing_symbols` (via LSP `textDocument/references`)
   - `rename_symbol` (via LSP `textDocument/rename`)
   - `replace_symbol_body` / `insert_before/after_symbol`
4. **Project-Based Workflow**: Persistent project sessions with memory/lessons learned storage

## Decision

We will adopt a **selective enhancement strategy** that ports high-value Serena patterns without introducing LSP dependencies.

### Feature Comparison Matrix

| Feature | Serena | smart-context-mcp | Gap Analysis |
|---------|--------|-------------------|--------------|
| Symbol Search | LSP `workspace/symbol` | Tree-sitter index | ✅ Equivalent capability |
| Find References | LSP `textDocument/references` | ❌ Missing | 🔴 HIGH PRIORITY |
| Rename Symbol | LSP `textDocument/rename` | ❌ Missing | 🟡 MEDIUM (via find refs) |
| Go to Definition | LSP `textDocument/definition` | ❌ Missing | 🟢 LOW (cross-file) |
| Type Inference | LSP `textDocument/hover` | ❌ Missing | ⛔ OUT OF SCOPE |
| Doc Extraction | JSDoc/TSDoc parsing | ❌ Missing | 🟡 MEDIUM |
| Skeleton View | Tree-sitter queries | ✅ Implemented | N/A |
| Dependency Graph | Built-in | ✅ Implemented | N/A |

### Enhancement Plan

#### Phase 1: Reference Finder (HIGH PRIORITY)
**Problem**: Agents cannot answer "Who calls this function?" without reading entire files.

**Serena Approach**: Delegates to `textDocument/references` LSP call.

**Static Analysis Lite Approach**:
```typescript
// New tool: find_symbol_references
interface ReferenceResult {
  filePath: string;
  line: number;
  column: number;
  context: string; // ~3 lines around reference
  kind: 'call' | 'assignment' | 'import' | 'type' | 'unknown';
}
```

**Implementation Strategy**:
1. Leverage existing `DependencyGraph.incomingEdges` for import-level references
2. Add identifier matching via tree-sitter:
   - Parse all files importing the target module
   - Query for `identifier` nodes matching symbol name
   - Filter by scope (avoid false positives from local variables)

**Complexity**: Medium. Tree-sitter queries can find identifier uses, but distinguishing local shadowing from actual references requires scope analysis.

**Recommendation**: Implement "import-aware reference search":
```
1. Get files that import the target file (DependencyGraph.incomingEdges)
2. Parse those files, find all imports from target
3. For each imported name, find all identifier usages in the importing file
4. Return structured results with context
```

This sidesteps complex scope analysis by restricting search to explicitly imported symbols.

---

#### Phase 2: Documentation Extraction (MEDIUM PRIORITY)
**Problem**: Agents waste tokens reading code to understand function purpose.

**Serena Approach**: Relies on LSP `textDocument/hover` which extracts doc comments.

**Static Analysis Lite Approach**:

Extend `SkeletonGenerator` to extract JSDoc/TSDoc:

```typescript
interface EnrichedSymbolInfo extends DefinitionSymbol {
  documentation?: {
    description?: string;
    params?: { name: string; type?: string; description?: string }[];
    returns?: { type?: string; description?: string };
    example?: string;
  };
}
```

**Implementation**: Tree-sitter query for `comment` nodes immediately preceding symbol declarations, with JSDoc tag parsing.

**Complexity**: Low-Medium. JSDoc has well-defined structure.

---

#### Phase 3: Safe Rename (MEDIUM PRIORITY)
**Problem**: Renaming requires manual find/replace across files.

**Serena Approach**: LSP `textDocument/rename` workspace edit.

**Static Analysis Lite Approach**:

Build on Phase 1 reference finder:

```typescript
// Tool: preview_rename
{
  filePath: string;
  symbolName: string;
  newName: string;
  previewOnly: true; // Default: never auto-apply
}

// Returns: List of edits that WOULD be applied
// Agent must explicitly confirm via apply_edits with batch ID
```

**Safety Constraint**: ALWAYS preview-only. Never auto-apply renames. This matches `smart-context-mcp`'s philosophy of agent-assisted, human-confirmed changes.

**Complexity**: High (depends on Phase 1 accuracy).

---

### Features Explicitly NOT Porting

| Feature | Reason |
|---------|--------|
| **Full LSP Integration** | Violates "zero external dependencies" principle |
| **Type Inference** | Requires TypeScript compiler API or LSP; too heavy |
| **Semantic Highlighting** | Editor concern, not agent concern |
| **JetBrains Plugin Integration** | Proprietary, not portable |
| **Project Memory/Lessons Learned** | Interesting but orthogonal to analysis tools |

---

### Architectural Refinements

#### 1. Unified Symbol Coordinate System
Serena uses `name_path` (e.g., `MyClass/myMethod[0]` for overloads). We should adopt this:

```typescript
// types.ts enhancement
interface SymbolCoordinate {
  namePath: string;        // e.g., "MyClass/myMethod"
  filePath: string;        // Relative path
  overloadIndex?: number;  // For languages with overloading
}
```

This allows stable, human-readable symbol references in tool calls.

#### 2. Reference Index (Inverted Index for Identifiers)
For performant reference search, cache identifier locations:

```typescript
class ReferenceIndex {
  // identifier name -> locations using it
  private index: Map<string, Set<SymbolCoordinate>>;
  
  async build(rootPath: string): Promise<void>;
  findReferences(symbolName: string, sourceFile: string): SymbolCoordinate[];
}
```

Invalidation: Same mtime strategy as `SymbolIndex`.

#### 3. Cross-File Impact Analysis Enhancement
Currently `DependencyGraph` only tracks file-level dependencies. Enhance to track symbol-level:

```typescript
interface SymbolDependency {
  sourceSymbol: SymbolCoordinate;
  targetSymbol: SymbolCoordinate;
  kind: 'uses' | 'extends' | 'implements' | 'imports';
}
```

---

## Implementation Roadmap

| Phase | Feature | Effort | Dependencies |
|-------|---------|--------|--------------|
| 1.1 | Symbol coordinate system | 2d | None |
| 1.2 | Import-aware reference search | 5d | DependencyGraph |
| 1.3 | `find_symbol_references` tool | 2d | 1.2 |
| 2.1 | JSDoc/TSDoc extraction | 3d | SkeletonGenerator |
| 2.2 | Enrich `read_file_skeleton` output | 1d | 2.1 |
| 3.1 | Reference-based rename preview | 3d | 1.3 |
| 3.2 | `preview_rename` tool | 2d | 3.1 |

**Total Estimated Effort**: ~18 developer-days

---

## Consequences

### Positive
- **Token Efficiency**: Reference search avoids "grep for symbol name across entire codebase" pattern
- **Agent Confidence**: Structured rename preview enables safer refactoring
- **Competitive Parity**: Matches ~70% of Serena's value with 0% of its operational complexity
- **Philosophy Alignment**: Maintains static-analysis-only, zero-runtime-dependency approach

### Negative
- **Accuracy Limitations**: Without true type system integration, we may have false positives (e.g., identically named variables in different scopes)
- **Language Coverage**: Tree-sitter queries need per-language tuning; initially focus on TS/JS/Python
- **Performance**: Full-project reference search will be slower than LSP (which maintains live index)

### Mitigation for Accuracy
- Document known limitations in tool descriptions
- Encourage agents to validate references before acting
- Implement confidence scoring based on import chain strength

---

## References
- [Serena GitHub](https://github.com/oraios/serena) - Main source for feature analysis
- [LSP Specification](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/)
- [tree-sitter Query Documentation](https://tree-sitter.github.io/tree-sitter/using-parsers#pattern-matching-with-queries)
- ADR-010: Smart Semantic Analysis
- ADR-011: Robustness and Advanced Analysis
