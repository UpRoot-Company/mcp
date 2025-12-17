# ADR-010: Smart Semantic Analysis & Structural Navigation

## Status
Proposed

## Context
Following the stabilization of the `EditorEngine` (Text/Regex layer) in ADR-009, we identify significant limitations in how agents interact with the codebase:

1.  **Context Waste**: Agents often read entire files just to verify a function signature or check imports, wasting valuable context window tokens.
2.  **Blind Navigation**: Without a "map" of the project, agents rely on brute-force file listing (`ls -R`) and guessing filenames, leading to inefficient exploration loops.
3.  **Fragile Parsing**: Regex-based understanding of code structure (e.g., finding the end of a function block) is error-prone, especially with nested scopes or complex syntax.

## Decision
We will introduce a **Semantic Layer** on top of the existing Text Layer, powered by **AST (Abstract Syntax Tree)** parsing. This will enable "Smart Reading" and "Project Mapping".

### 1. Technology Selection: `tree-sitter`
We verify `web-tree-sitter` (WASM-based) as the parsing engine.
*   **Pros**:
    *   Incremental parsing (fast).
    *   Robust error recovery (can parse files with syntax errors).
    *   WASM binding ensures cross-platform compatibility without native compilation (`node-gyp`) issues.
*   **WASM Delivery Strategy (Validated via PoC)**:
    *   We will use the npm package `tree-sitter-wasms` which bundles pre-built WASM binaries for major languages.
    *   This eliminates the need for manual download scripts or external CDNs, ensuring offline capability and reproducibility.

### 2. New Component: `AstManager`
A singleton service responsible for:
*   Initializing the `web-tree-sitter` parser.
*   Resolving WASM paths from `node_modules/tree-sitter-wasms`.
*   Caching loaded languages to minimize filesystem I/O.
*   Parsing file content into ASTs.

### 3. Feature 1: Project Skeleton (The Map)
We will implement a tool `get_file_skeleton` (or `read_structure`) that returns a summarized view of a file.

**Input:** `src/engine/Editor.ts`
**Output (Skeleton):**
```typescript
class AmbiguousMatchError extends Error {
  constructor(message: string, details: { conflictingLines: number[] })
}
class EditorEngine {
  private rootPath: string
  constructor(rootPath: string)
  private _createTimestampedBackup(originalFilePath: string, content: string): Promise<void>
  public applyEdits(filePath: string, edits: Edit[], dryRun: boolean): Promise<EditResult>
}
```
*   **Benefit**: Compresses 500 lines of code into ~20 lines of structure. The agent can "see" the API surface without reading the implementation.
*   **Implementation**: Use `tree-sitter` queries (S-expressions) to select relevant nodes (`class_declaration`, `method_definition`) and a custom formatter to reconstruct the signature.

### 4. Feature 2: Symbol-Based Reading
We will implement `read_symbol` (or augment `read_fragment`) to verify precise code blocks using AST range.
*   **Logic**: Find node type `function_declaration` with name `myFunc`, return exact `startPosition` and `endPosition`.
*   **Benefit**: Eliminates the need for agents to guess line numbers (`lineRanges`) for reading.

## Architecture Diagram (Conceptual)

```
[MCP Client/Agent]
      |
      v
[Smart Context MCP]
      |
      +--- 1. EditorEngine (Text Layer / ADR-009)
      |         - File I/O
      |         - LineCounter
      |         - Regex/Fuzzy Matching
      |
      +--- 2. AstEngine (Semantic Layer / ADR-010)  <-- NEW
                - web-tree-sitter (WASM)
                - tree-sitter-wasms (Grammar Asset Bundle)
                - Skeleton Generator (Visitor/Query)
```

## Implementation Plan

### Phase 1: Infrastructure Setup
1.  Install `web-tree-sitter` and `tree-sitter-wasms`.
2.  Implement `AstManager` class.
    *   `init()`: Initialize parser.
    *   `getParserForFile(filePath)`: Detect language, load WASM, return parser.

### Phase 2: Skeleton Generator
1.  Define Tree-sitter queries for extracting high-level constructs.
    *   Typescript: `(class_declaration) @class`, `(function_declaration) @function`, `(method_definition) @method`.
    *   Use `new Query(language, source)` API (as `Language.query` is deprecated).
2.  Implement `generateSkeleton(source: string): string`.

### Phase 3: Tool Integration
1.  Expose `read_structure` tool.
2.  (Optional) Integrate into `read_fragment` to allow `symbol: "ClassName"` parameter.

## Consequences

### Positive
- **Token Efficiency**: massive reduction in token usage for code exploration.
- **Accuracy**: 100% accurate block extraction compared to regex.
- **Reliability**: Validated PoC confirms `web-tree-sitter` + `tree-sitter-wasms` works seamlessly in the target environment.

### Negative
- **Bundle Size**: WASM binaries will increase the package size (~5-10MB).
- **Startup Time**: Slight overhead to load WASM grammars on first use (~50-100ms).

## References
- [tree-sitter documentation](https://tree-sitter.github.io/tree-sitter/)
- [web-tree-sitter npm](https://www.npmjs.com/package/web-tree-sitter)
- [tree-sitter-wasms npm](https://www.npmjs.com/package/tree-sitter-wasms)
