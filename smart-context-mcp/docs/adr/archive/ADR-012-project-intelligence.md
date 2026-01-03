# ADR-012: Project Intelligence (Enhanced Static Analysis)

## Status
Proposed (Revised v2)

## Context
Initial reviews of "Lightweight Static Analysis" revealed critical gaps in module resolution and symbol handling. To provide actionable intelligence (Find References, Dependency Graph), we must handle real-world complexities like aliased imports, directory indexes, and re-exports, while maintaining the "Zero-Config" philosophy.

## Decision
We will implement a **Best-Effort Static Analysis Engine** that prioritizes speed and robustness over 100% type accuracy.

### 1. Enhanced Data Structures
We extend the AST extraction to capture precise import/export semantics.

```typescript
// Extended SymbolInfo
interface ImportSymbol extends SymbolInfo {
    type: 'import';
    source: string; // Original specifier (e.g. "./utils")
    resolvedPath?: string; // Absolute path (after resolution)
    importKind: 'named' | 'namespace' | 'default' | 'side-effect';
    // For named imports: import { a as b }
    imports?: Array<{ name: string; alias?: string }>; 
    // For namespace/default: import * as ns / import foo
    alias?: string;
    isTypeOnly: boolean;
}

interface ExportSymbol extends SymbolInfo {
    type: 'export';
    exportKind: 'named' | 'default' | 'namespace' | 're-export';
    source?: string; // For re-exports: export ... from "./bar"
    exports?: Array<{ name: string; alias?: string }>;
    isTypeOnly: boolean;
}
```

### 2. Robust Module Resolution (`ModuleResolver`)
We will implement a custom resolver that mimics Node.js/TypeScript resolution without external heavy libraries.

-   **Priority**: 
    1.  Relative/Absolute paths.
    2.  Exact match (extensionless files).
    3.  Extensions: `.ts`, `.tsx`, `.d.ts`, `.js`, `.jsx`, `.json`.
    4.  Directory Indexes: `index.ts`, `index.tsx`, etc.
-   **Caching**:
    -   `statCache`: `Map<path, fs.Stats>` to reduce syscalls.
    -   `resolutionCache`: `Map<context+specifier, result>` to memoize lookups.
-   **Limitations**:
    -   Webpack aliases (`@/components`) are NOT supported in MVP (marked as "Unresolved").
    -   `node_modules` are resolved to the package root, not deep traversal.

### 3. Dependency Graph with Cycle Detection
-   **Structure**: Directed Graph stored in `SymbolIndex`.
    -   `Map<FilePath, Set<DependencyPath>>` (Outgoing)
    -   `Map<FilePath, Set<ConsumerPath>>` (Incoming/Reverse)
-   **Safety**: Graph traversal algorithms (for "Impact Analysis") MUST implement **Cycle Detection** (visited set) to handle circular dependencies (`A -> B -> A`).

### 4. Advanced Tree-sitter Queries
We will update `SkeletonGenerator` with comprehensive queries to handle edge cases.

**TypeScript Example:**
```scheme
; Named imports
(import_statement
  (import_clause 
    (named_imports (import_specifier name: (identifier) @name alias: (identifier)? @alias)))
  source: (string) @source) @import

; Namespace imports
(import_statement
  (import_clause (namespace_import (identifier) @alias))
  source: (string) @source) @import

; Default imports
(import_statement
  (import_clause (identifier) @alias)
  source: (string) @source) @import
```

## Implementation Plan

### Phase 1: Symbol Extraction Upgrade (Refactor SkeletonGenerator)
1.  Define new `SymbolInfo` subtypes in `types.ts`.
2.  Implement detailed Tree-sitter queries for TS/JS and Python imports/exports.
3.  Refactor `generateStructureJson` to parse and populate these fields.

### Phase 2: Resolver & Graph (New Components)
1.  Implement `src/analysis/ModuleResolver.ts` with caching logic.
2.  Implement `src/analysis/DependencyGraph.ts` to manage edges.
3.  Integrate into `SymbolIndex` (resolve imports *after* extraction).

### Phase 3: Tools & Optimization
1.  Expose `get_file_dependencies(file, direction)` tool.
2.  Implement `search_symbol_references(symbol)` using the graph + text search.
3.  Add `warmup` logic for the resolver cache.

## Performance Targets
-   **Resolution**: < 1ms per import (amortized with cache).
-   **Graph Build**: Lazy / Incremental. Only resolve dependencies when requested or during background indexing.

## References
- [Node.js Module Resolution Algorithm](https://nodejs.org/api/modules.html#all-together)
- [Tree-sitter TypeScript Grammar](https://github.com/tree-sitter/tree-sitter-typescript)
