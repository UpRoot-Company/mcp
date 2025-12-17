# ADR-011: Robustness, Format Flexibility, and Advanced Analysis (Revised)

**Status:** Proposed  
**Date:** 2024-12-07  
**Author:** Architecture Team  
**Reviewer:** Senior Engineer (Feedback Incorporated)

## Context
The AST infrastructure (`AstManager`, `SkeletonGenerator`) established in ADR-010 has successfully enabled semantic code masking. However, technical review identified critical gaps for production readiness:

1.  **Fragile Language Detection**: `.js` files often contain JSX, which the standard `javascript` parser fails on. The proposed "try-catch fallback" is inefficient and unreliable because tree-sitter error nodes don't always throw exceptions.
2.  **Startup Latency**: First-request parsing incurs WASM loading overhead (~50-100ms).
3.  **Underspecified JSON Output**: The original proposal lacked a schema for structured output, making it useless for programmatic analysis.
4.  **Scalability Risks**: "Symbol Search" without an indexing strategy would cause O(N) parsing on every query, freezing the server on large repositories.

## Decision

We will implement a 3-phase enhancement plan with strict performance and schema guarantees.

### 1. Robust Language Strategy (Phase 1)
-   **Policy**: "Always use TSX for JS".
-   **Rationale**: `tree-sitter-tsx` is a superset grammar that correctly parses TypeScript, JSX, and standard JavaScript. Using it for `.js`, `.jsx`, `.ts`, and `.tsx` eliminates the need for expensive runtime fallback logic.
-   **Implementation**: Update `AstManager`'s `EXT_TO_LANG` map to point `.js`, `.jsx`, `.mjs`, `.cjs` to `tsx`.

### 2. Server Warm-up (Phase 1)
-   **Logic**: Asynchronously load common language WASMs (`tsx`, `python`, `json`) during server startup.
-   **Safety**: Must be non-blocking (Promise.all without await in constructor) and swallow errors silently (logging warnings only).

### 3. Structured JSON Skeleton (Phase 2)
We will introduce a `SymbolExtractor` alongside the `SkeletonGenerator`.

-   **New Tool Option**: `read_file_skeleton(filePath, format: "text" | "json")`.
-   **JSON Schema**:
    ```typescript
    interface SymbolInfo {
        type: 'class' | 'function' | 'method' | 'interface' | 'variable';
        name: string;
        // 0-based range for accurate text extraction
        range: { startLine: number; endLine: number; startByte: number; endByte: number };
        container?: string; // Parent class/namespace name
        signature?: string; // e.g. "(a: number, b: number): void"
        parameters?: string[]; // ["a", "b"]
    }
    ```
-   **Implementation**: Requires distinct Tree-sitter queries per language (e.g., `(class_declaration name: (_) @name) @def`).

### 4. Scalable Symbol Search (Phase 3)
-   **Tool**: `search_symbol_definitions(query)`
-   **Strategy**: **Timestamp-based In-Memory Caching**.
    -   Maintain `Map<filePath, { mtime: number, symbols: SymbolInfo[] }>`.
    -   On search:
        1.  Scan directory (using `SearchEngine` to respect `.gitignore`).
        2.  For each file, check `fs.stat(mtime)`.
        3.  If changed or not cached, re-parse and update cache.
        4.  If unchanged, use cached symbols.
-   **Limit**: Max 100 results to prevent context overflow.

## Implementation Plan

### Phase 1: Infrastructure Hardening (Immediate)
1.  **Refactor `AstManager`**: Update `EXT_TO_LANG` to map JS variants to `tsx`.
2.  **Implement Warm-up**: Add `warmup()` method and call it in `index.ts`.

### Phase 2: JSON Extraction Logic
1.  Create `src/ast/SymbolExtractor.ts`.
2.  Define capture queries for TS/TSX (`@name`, `@container`).
3.  Update `read_file_skeleton` handler to support `format` arg.

### Phase 3: Symbol Search (Future)
1.  Implement `SymbolIndex` class with `mtime` caching.
2.  Integrate with `SearchEngine` for file discovery.
3.  Expose `search_symbol_definitions` tool.

## Consequences

### Positive
- **Stability**: JS/JSX parsing becomes robust immediately.
- **Performance**: Warm-up hides initialization cost; Caching makes search usable (sub-second after first run).
- **Usability**: Agents get precise, structured data for complex analysis.

### Negative
- **Memory**: Symbol cache grows with project size. (Mitigation: LRU eviction if needed later).
- **Complexity**: Maintaining two sets of queries (Folding vs Extraction).

## References
- [tree-sitter-tsx](https://github.com/tree-sitter/tree-sitter-typescript)
- [LSP Symbol Information](https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/#symbolInformation)
