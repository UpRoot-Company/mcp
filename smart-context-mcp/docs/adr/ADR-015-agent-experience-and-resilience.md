# ADR-015: Agent Experience and Resilience Enhancements

**Status:** Accepted (Phases 1–5 implemented as of 2025-12-09)
**Date:** 2025-12-09
**Author:** Software Architecture Team

---

## 1. Context

Gemini-based agents have validated that `smart-context-mcp` is a strong foundation for intelligent, context-aware codebase interaction, especially after the `read_file` → Smart File Profile redesign (ADR-014) and the reliability work in ADR-005 and ADR-008.

The latest feedback, however, highlights a few recurring pain points:

1.  **Environment Fragility:**
    -   `web-tree-sitter` WASM loading and Jest/CI environment quirks make tests and local experimentation brittle.
    -   Agents may see flaky behavior or missing AST features depending on how the host configures Node, Jest, and WASM.

2.  **Multi-line Edit Fragility:**
    -   `edit_file` can fail to find multi-line `targetString` blocks due to differences in line endings (LF/CRLF), whitespace, or indentation.
    -   Agents often fall back to `write_file`, losing the atomicity and safety features of the editor.

3.  **Limited Environment/Format Awareness:**
    -   Smart File Profiles provide structure and dependencies, but not enough information about newline style, indentation, or test relationships.
    -   Agents must infer these details manually, which is error-prone when generating multi-line edits.

4.  **Inconsistent Agent UX:**
    -   Error messages are structured, but they do not always tell the agent exactly what to do next.
    -   There is no canonical “playbook” describing the intended scouting → profiling → fragment → edit workflow.

5.  **Module/Index Limitations in Real Projects:**
    -   `ModuleResolver` currently focuses on Node/TypeScript-style resolution but does not fully embrace `tsconfig` aliases and common patterns like `@/components`.
    -   Agents cannot easily see “how complete” or “how reliable” the current project index is.

This ADR proposes a set of incremental, implementation-ready enhancements that build on ADR-001, ADR-005, ADR-008, ADR-009, ADR-012, and ADR-014 to make the system more robust and agent-friendly.

---

## 2. Decision

We will implement a coordinated set of improvements in five areas:

1.  **AST Backend Abstraction and Engine Profiles**  
    A pluggable AST backend interface for `AstManager`/`SkeletonGenerator`, with explicit “engine profiles” (`prod`/`ci`/`test`) to decouple parsing from environment quirks.

2.  **Robust Multi-line Edit Matching**  
    A normalization pipeline and structural anchors for `edit_file`, making multi-line edits resilient to line-ending and whitespace differences, and easier to debug when they fail.

3.  **Smart File Profile Enrichment**  
    Additional metadata in Smart File Profiles (newline style, indentation, encoding, basic complexity metrics, test impact hints) to guide agents in constructing safe edits.

4.  **Agent UX & Workflow Guidance**  
    A documented agent playbook, and error messages that consistently include next-action hints and example tool calls.

5.  **Module Resolution and Index Diagnostics**  
    Better support for TypeScript path aliases and an explicit “index status” tool so agents can gauge the reliability of dependency and reference data.

These changes are additive and backward-compatible, and they align with the existing reliability and semantic analysis roadmap.

---

## 3. Proposal 1: AST Backend Abstraction & Engine Profiles

### 3.1 Goals

-   Make `AstManager` and `SkeletonGenerator` robust across environments (Node, Jest, CI, constrained sandboxes).
-   Avoid coupling tests and runtime behavior to a single parser implementation (`web-tree-sitter` WASM).
-   Provide a clear, documented set of engine modes with guarantees and trade-offs.

### 3.2 Design

#### 3.2.1 AST Backend Interface

Introduce an explicit AST backend interface used by `AstManager` and dependent components:

```ts
interface AstBackend {
  name: string; // "web-tree-sitter", "js-parser", "snapshot", etc.
  capabilities: {
    supportsComments: boolean;
    supportsTypeAnnotations: boolean;
    nodeTypeNormalization: 'tree-sitter' | 'babel' | 'native';
  };
  initialize(): Promise<void>;

  parseFile(
    absPath: string,
    content: string,
    languageHint?: string
  ): Promise<AstDocument>;
}
```

Key points:

-   `AstManager` holds a reference to one `AstBackend`.
-   Different implementations can wrap:
    -   `web-tree-sitter` + WASM (production-quality ASTs).
    -   A JS parser (e.g., Babel/TypeScript compiler APIs) used in non-WASM environments.
    -   A “snapshot” backend for tests that replays stored AST JSON for deterministic unit tests.

#### 3.2.2 Engine Configuration Profiles

Add an `EngineConfig` (or similar) to `SmartContextServer`:

```ts
interface EngineConfig {
  mode: "prod" | "ci" | "test";
  parserBackend?: "wasm" | "js" | "snapshot" | "auto";
}
```

-   `mode` controls default behavior and expectations:
    -   `prod`: prefer full-featured `web-tree-sitter` backed ASTs; **fail loudly (no automatic fallback)** if critical parsing fails.
    -   `ci`: favor deterministic, fast ASTs; **fallback to JS parser for limited features (e.g., Skeleton only), then to degraded mode (no parsing, just metadata) if WASM is unavailable.**
    -   `test`: prioritize stability and minimal external dependencies; **snapshot backend is acceptable, stubs for external dependencies.**
-   `parserBackend` allows explicit override; `auto` selects the best available backend for the current environment.

`SmartContextServer` is responsible for:

-   Selecting and initializing the backend at startup.
-   Logging which backend is in use and any fallbacks applied.

#### 3.2.3 Snapshot Backend Design

For `test` mode, a "snapshot" backend can replay stored AST JSON for deterministic unit tests. This can be implemented by loading ASTs from fixture files.

```ts
class SnapshotBackend implements AstBackend {
  name: "snapshot";
  capabilities: { /* ... minimal ... */ }; // Define capabilities
  constructor(private fixtureDir: string) {}
  async initialize(): Promise<void> { /* ... */ }
  async parseFile(absPath: string, content: string): Promise<AstDocument> {
    const relativePath = path.relative(this.fixtureDir, absPath); // Adjust to get relevant snapshot path
    const snapshotPath = path.join(this.fixtureDir, relativePath + '.json'); // e.g., src/file.ts -> fixtures/src/file.ts.json
    try {
      return JSON.parse(await fs.promises.readFile(snapshotPath, 'utf-8'));
    } catch (e) {
      throw new Error(`Snapshot not found for ${absPath}: ${e.message}`);
    }
  }
}
```

### 3.3 Consequences

-   **Positive**
    -   Tests and CI no longer depend on fragile WASM loading paths.
    -   Environment-specific bugs are contained behind the `AstBackend` boundary.
    -   Future languages or parsing strategies can be added without changing higher-level engines.

-   **Negative**
    -   Slight complexity increase in initialization and configuration.
    -   Different backends may produce slightly different ASTs; documentation must clarify guarantees per mode.

---

## 4. Proposal 2: Robust Multi-line Edit Matching & Diagnostics

### 4.1 Goals

-   Make `edit_file` reliable for multi-line blocks across environments and editors.
-   Reduce “Target not found” surprises due to line endings or whitespace.
-   Provide diagnostic tools when a match cannot be found or is ambiguous.

### 4.2 Design

#### 4.2.1 Normalization Pipeline

Introduce a standardized normalization step applied before matching in `EditorEngine`:

```ts
type NormalizationLevel = "exact" | "whitespace" | "structural"; // Renamed from "none" | "whitespace" | "aggressive"

interface Edit {
  // existing fields...
  normalization?: NormalizationLevel;
}
```

Normalization behavior:

-   `exact` (default, preserves current behavior): No normalization.
-   `whitespace`:
    -   Normalize CRLF → LF.
    -   Collapse trailing whitespace; treat sequences of spaces/tabs equivalently.
    -   Preserve content characters and line structure.
-   `structural`:
    -   Includes `whitespace` behavior plus normalization of indentation (tabs vs spaces) and additional minor formatting differences. This aims to match based on code structure regardless of formatting style.

Matching uses normalized versions of both `content` and `edit.targetString` according to the chosen level, while still returning matches in original coordinates.

**Performance Concern:** Normalization adds overhead. Implement an early-exit optimization:
- If an exact match succeeds, skip further normalization.
- Only normalize if the exact match fails.

**Connection to Smart File Profile:** If Smart File Profile detects `newlineStyle: "crlf"`, auto-apply whitespace normalization for that file's edits (this would be an agent-side decision, or a hint).

#### 4.2.2 Structural Anchors

Extend `Edit` to support structural anchoring for multi-line operations:

```ts
interface LineRange {
  start: number;
  end: number;
}

interface Edit {
  // existing fields...
  lineRange?: LineRange;
  expectedHash?: {
    algorithm: 'sha256' | 'xxhash';  // xxhash recommended for speed in large files
    value: string;
  }; // hash of original fragment, optional
}
```

-   When `lineRange` is provided:
    -   Restrict matching to that segment of the file.
    -   If `expectedHash` is provided, compute a hash of the current content in that range using the specified `algorithm`; if the hash differs, return a clear error indicating that the file has drifted since the agent last read it, preventing TOCTOU (Time-of-Check to Time-of-Use) attacks.
-   This encourages the standard workflow: `read_fragment` → agent plans change → `edit_file` with the corresponding `lineRange` (and optionally a hash).

#### 4.2.3 Match Diagnostics Tool

Add a new tool (e.g., `debug_edit_match`) for use when an `edit_file` call fails:

Input:

```ts
{
  filePath: string;
  targetString: string;
  normalization?: NormalizationLevel;
  lineRange?: LineRange;
}
```

Output (text or structured JSON):

-   List of candidate matches with:
    -   Approximate line numbers.
    -   Snippets of surrounding content.
    -   Applied normalization steps.
-   A human- and machine-readable explanation of why no match was selected (e.g., “CRLF vs LF mismatch”, “whitespace-only differences”, “multiple candidates with equal score”).

### 4.3 Consequences

-   **Positive**
    -   Multi-line edits become much more robust across editors and platforms.
    -   Agents receive actionable explanations for failures and can adjust strategy (`lineRange`, normalization level) accordingly.

-   **Negative**
    -   Additional code paths in `EditorEngine` to handle normalization and structural anchors.
    -   Slight performance overhead from normalization and diagnostics (limited by configuration and only used on demand).

---

## 5. Proposal 3: Smart File Profile Enrichment

### 5.1 Goals

-   Enhance Smart File Profiles (ADR-014) with environment and complexity hints.
-   Help agents generate edits that match the file’s style and understand potential impact.

### 5.2 Design

Extend `SmartFileProfile.metadata` and add light-weight metrics:

```ts
interface SmartFileProfile {
  metadata: {
    filePath: string;
    relativePath: string;
    sizeBytes: number;
    lineCount: number;
    language: string | null;
    lastModified?: string;
    newlineStyle?: "lf" | "crlf" | "mixed";
    encoding?: string; // e.g., "utf-8", detected via 'chardet' or similar
    hasBOM?: boolean; // UTF-8 BOM detection
    usesTabs?: boolean;
    indentSize?: number | null;
    // New: Read-only detection for configuration files
    isConfigFile?: boolean;
    configType?: 'tsconfig' | 'package.json' | 'lintrc' | 'editorconfig' | 'other';
    configScope?: 'project' | 'directory' | 'file'; // e.g., tsconfig.json affects project
  };

  structure: {
    skeleton: string;
    symbols: DefinitionSymbol[];
    complexity?: {
      functionCount: number;
      linesOfCode: number; // Simplified from max/average function length for easier computation
      maxNestingDepth?: number; // Optional, might be complex to compute reliably cross-language
    };
  };

  usage: {
    incomingCount: number;
    incomingFiles: string[];
    testFiles?: string[]; // first N test files that depend on this file
  };

  guidance: {
    bodyHidden: true;
    readFullHint: string;
    readFragmentHint: string;
  };
}
```

Implementation notes:

-   `newlineStyle`, `encoding`, `hasBOM`, `usesTabs`, `indentSize` are computed via simple scans of the file content (e.g., using a library like `detect-character-encoding` or simple regexes).
-   `complexity` metrics are approximate and rely on AST structure where available; they are not intended to be as precise as a linter. Simpler proxies like `linesOfCode` and `functionCount` are preferred due to computational cost of deep AST analysis in `read_file`.
-   `testFiles` uses existing `DependencyGraph` and heuristic patterns (e.g., `*.test.*`, `*.spec.*`, `__tests__` directories, `tests/` directories) to highlight tests that are likely affected by changes. A configurable list of patterns will be maintained.
-   `isConfigFile`, `configType`, `configScope` provide immediate context for configuration-related files.

### 5.3 Consequences

-   **Positive**
    -   Agents can match newline and indentation style when constructing `targetString`, leading to fewer formatting-related `NO_MATCH` errors.
    -   Quick insight into “hot” or complex areas of code without loading full bodies.
    -   Test impact hints help agents design safer change and validation plans.
    -   Explicit awareness of configuration files and their scope.

-   **Negative**
    -   Slight extra computation cost on first profile generation per file.
    -   Heuristics for test detection and complexity may not be perfect; documentation should present them as best-effort.

---

## 6. Proposal 4: Agent UX & Workflow Guidance

### 6.1 Goals

-   Codify the intended usage pattern for `smart-context-mcp`.
-   Ensure errors always suggest the most useful next action for agents.

### 6.2 Design

#### 6.2.1 Agent Playbook Documentation

Add a new documentation page (e.g., `docs/agent-playbook.md`) describing the canonical workflow. This playbook will also be consumable programmatically via a new tool `get_workflow_guidance`.

**Machine-readable Playbook Format (JSON):**

```json
{
  "workflow": {
    "title": "Standard Agent Workflow for Code Modification",
    "description": "A step-by-step guide for agents to effectively interact with the codebase.",
    "steps": [
      {
        "name": "Scout & Discover",
        "description": "Identify relevant files or code sections.",
        "tools": ["search_files", "list_directory"],
        "hint": "Use keywords or glob patterns to narrow down search results."
      },
      {
        "name": "Profile & Understand",
        "description": "Gain a high-level understanding of file structure, metadata, and dependencies.",
        "tools": ["read_file"],
        "tool_args": { "full": false },
        "hint": "Analyze the 'Smart File Profile' to grasp context and potential impact."
      },
      {
        "name": "Fragment & Detail",
        "description": "Read specific, precise sections of code for detailed context.",
        "tools": ["read_fragment"],
        "hint": "Always use `lineRange` to specify the exact region of interest."
      },
      {
        "name": "Plan Edits",
        "description": "Based on gathered context, formulate the exact code changes.",
        "hint": "Consider file style (indentation, newlines) and potential side-effects."
      },
      {
        "name": "Edit & Modify",
        "description": "Apply atomic, safe changes to the codebase.",
        "tools": ["edit_file", "batch_edit"],
        "best_practice": "Prefer `edit_file` with `lineRange` and `normalization` for multi-line changes. Use `expectedHash` for drift detection."
      },
      {
        "name": "Validate & Verify",
        "description": "Confirm changes are correct and haven't introduced regressions.",
        "tools": ["read_file", "run_shell_command (for tests)"],
        "hint": "Re-read affected fragments/profiles. Run relevant tests."
      }
    ]
  }
}
```

This document should emphasize:

-   Avoid using `read_file(raw: true)` unless absolutely necessary.
-   Prefer `lineRange` + `expectedHash` for multi-line edits to ensure atomicity and detect file drift.
-   Use diagnostics (`debug_edit_match`, structured error details) before falling back to `write_file` for complex multi-line modifications.

#### 6.2.2 Error Messages with Next-Action Hints

Extend structured errors (ADR-008) with:

-   A `suggestion` field that:
    -   Names the most relevant tool to use next.
    -   Includes a short example of a follow-up call.
-   Standardized `ErrorCode` taxonomy for common failure modes.

**Standardized Error Code Taxonomy:**

| Code              | Meaning                  | Primary Recovery Action (Tool) |
|-------------------|--------------------------|--------------------------------|
| `NO_MATCH`        | Target string not found  | `debug_edit_match` / `read_fragment` |
| `AMBIGUOUS_MATCH` | Multiple matching targets| `edit_file` (with `lineRange`) / `debug_edit_match` |
| `HASH_MISMATCH`   | File changed unexpectedly| `read_file` (Smart Profile) / `read_fragment` |
| `PARSE_ERROR`     | AST parsing failed       | `read_file` (full) / `debug_syntax` (new tool) |
| `INDEX_STALE`     | Project index out of date| `rebuild_index` (new tool)     |
| `ENVIRONMENT_ISSUE`| WASM/Runtime error       | Manual inspection / `get_env_status` (new tool) |

**Structured Error Response Format:**

```ts
interface AgentError {
  code: ErrorCode;       // e.g., "NO_MATCH"
  message: string;       // Human-readable description
  suggestion?: {
    toolName: string;
    exampleArgs?: Record<string, unknown>; // Example arguments for the suggested tool
    rationale: string;   // Why this tool is suggested
  };
  relatedContext?: {
    lineRange?: LineRange; // Relevant lines for context
    similarMatches?: Array<{ line: number; snippet: string }>; // For ambiguous matches
    details?: Record<string, unknown>; // Additional diagnostic info
  };
}
```

### 6.3 Consequences

-   **Positive**
    -   Agents have a documented, shared mental model for how to use the system.
    -   Clear, consistent recovery paths when operations fail, significantly reducing agent "flailing".
    -   Structured errors enable programmatic error handling by agents.

-   **Negative**
    -   Requires ongoing discipline to keep documentation and error messages aligned with implementation as new tools are added.
    -   Implementing structured errors and suggestions across all tools will be a significant effort.

---

## 7. Proposal 5: Module Resolution & Index Diagnostics

### 7.1 Goals

-   Improve the fidelity of `DependencyGraph` and `ReferenceFinder` in modern TypeScript projects using `tsconfig` aliases.
-   Make the “health” of the project index observable to agents.

### 7.2 Design

#### 7.2.1 tsconfig-aware Module Resolution

Extend `ModuleResolver` (ADR-012) to:

-   Read `tsconfig.json` (and, optionally, `jsconfig.json`) from the project root.
-   Respect `compilerOptions.baseUrl` and `compilerOptions.paths`.
-   Support common alias patterns (e.g., `@/*`, `@components/*`) by mapping them to absolute paths under the project root.
-   Support **multiple `tsconfig` files** (e.g., in monorepos or with `extends` directives).

**`ModuleResolverConfig` for Robustness:**

```ts
interface ModuleResolverConfig {
  rootPath: string;
  tsconfigPaths?: string[];  // Paths to tsconfig.json files to load (e.g., ['tsconfig.json', 'packages/my-lib/tsconfig.json'])
  fallbackResolution?: 'node' | 'bundler'; // Strategy if tsconfig resolution fails
}
```

Behavior:

-   When resolving an import specifier:
    -   Apply existing Node/TS rules.
    -   If not resolved, attempt alias-based resolution using the configured paths from one or more `tsconfig.json` files.
    -   If still unresolved, mark the import as “unresolved” but include the alias information in `ImportSymbol` for transparency.

#### 7.2.2 Index Status Tool

Add a tool (e.g., `get_index_status`) to expose the state of project analysis:

**Enhanced `IndexStatus` Output:**

```ts
interface IndexStatus {
  global: {
    totalFiles: number;
    indexedFiles: number;
    unresolvedImports: number;
    resolutionErrors: Array<{ filePath: string; importSpecifier: string; error: string; }>; // Detailed errors
    lastRebuiltAt: string; // ISO date string
    confidence: 'high' | 'medium' | 'low'; // Qualitative assessment of index reliability
    isMonorepo: boolean; // Heuristic based on multiple package.json/tsconfig.json
  };
  perFile?: Record<string, { // Optional: detailed status per file
    resolved: boolean;
    unresolvedImports: string[];
    incomingDependenciesCount: number; // How many files depend on this one
    outgoingDependenciesCount: number; // How many files this one depends on
  }>;
}
```

Agents can call this tool:

-   Before relying heavily on `DependencyGraph`/`ReferenceFinder`.
-   After large changes or when index drift is suspected.

**Cache Invalidation Strategy:**

Implement explicit tools for index management:

```ts
interface IndexManager {
  invalidateFile(path: string): Promise<void>; // Remove a single file from index cache
  invalidateDirectory(path: string): Promise<void>; // Remove all files in a directory from index cache
  rebuild(options?: { incremental?: boolean }): Promise<void>; // Rebuild full or incrementally
}
```

This would be exposed via new tools like `invalidate_index_file`, `rebuild_index`.

### 7.3 Consequences

-   **Positive**
    -   Higher quality dependency and usage information in TS/alias-heavy codebases.
    -   Agents can judge whether project intelligence is trustworthy at any given moment.
    -   Improved debugging and maintenance of the project index.

-   **Negative**
    -   Slightly more complex configuration and parsing logic in `ModuleResolver`.
    -   Need to handle multiple `tsconfig` files or non-standard layouts gracefully.
    -   Implementing and maintaining cache invalidation strategies can be complex.

---

## 8. Cross-Cutting Concerns

This section outlines aspects that cut across multiple proposals.

#### 8.1 Performance Budget

To maintain responsiveness for agents, we establish clear performance targets:

| Operation              | P50 Target (ms) | P95 Target (ms) |
|------------------------|-----------------|-----------------|
| Smart File Profile     | 30              | 100             |
| Edit with normalization| 50              | 200             |
| Index Status Query     | 5               | 20              |
| `debug_edit_match`     | 100             | 500             |
| `rebuild_index` (full) | 500             | 2000            |
| `rebuild_index` (incr.)| 10              | 50              |

#### 8.2 Backward Compatibility Matrix

All proposed changes are designed to be additive and backward-compatible.

| Feature                           | Breaking Change? | Migration Path                         |
|-----------------------------------|------------------|----------------------------------------|
| AST Backend abstraction           | No               | Internal refactor; no API changes      |
| Normalization levels for `edit_file`| No               | New optional field `normalization`     |
| Profile enrichment                | No               | Additive fields to `SmartFileProfile`  |
| Error suggestions/taxonomy        | No               | Additive fields to error responses     |
| New tools (`debug_edit_match`, `get_index_status` etc.)| No               | New tools, existing tools unchanged    |
| `ModuleResolver` `tsconfig` support| No               | Enhanced resolution, existing behavior maintained for non-aliases |

#### 8.3 Testing Strategy

-   **AST Backends:** Add integration tests that run the same parsing/skeleton generation suite against all implemented backends (`wasm`, `js`, `snapshot`) to ensure consistent output.
-   **Multi-line Edits:** Create a comprehensive corpus of problematic edit cases (LF/CRLF, various indentations, trailing whitespace, subtle context changes) to rigorously test normalization and structural anchoring.
-   **Playbook:** Add E2E tests that simulate an agent's canonical workflow (scout → profile → fragment → edit → validate) to ensure a smooth end-to-end experience.
-   **Index Integrity:** Develop integration tests for `ModuleResolver` and `DependencyGraph` that cover complex `tsconfig` alias scenarios, monorepo setups, and cache invalidation.
-   **Performance:** Integrate performance benchmarks for critical operations (`read_file`, `edit_file`, `rebuild_index`) into CI to prevent regressions against the defined budget.

---

## 9. Implementation Plan (High-Level - Revised)

This ADR is intentionally incremental. The suggested sequencing prioritizes quick wins and agent usability before tackling foundational infrastructure changes.

1.  **Smart File Profile Enrichment (Proposal 3)**
    -   Low risk, immediate agent benefit.
    -   Add formatting and complexity metadata to `SmartProfileBuilder`.
    -   Wire new fields into `read_file` smart profile output.

2.  **Agent UX & Documentation (Proposal 4)**
    -   Documentation + error improvements provide immediate value.
    -   Write the agent playbook and update error messages with structured suggestions.
    -   Implement `get_workflow_guidance` tool.

3.  **Robust Multi-line Edits (Proposal 2)**
    -   Addresses a core pain point for agents using `edit_file`.
    -   Implement normalization levels and line-range anchoring in `EditorEngine`.
    -   Add `debug_edit_match` tool and corresponding tests.

4.  **Module Resolver and Index Status (Proposal 5)**
    -   Improves core project intelligence reliability.
    -   Extend `ModuleResolver` to read `tsconfig` aliases.
    -   Implement `get_index_status` and cache invalidation tools.

5.  **AST Backend & Engine Profiles (Proposal 1)**
    -   Foundational, but highest risk due to parser environment interaction.
    -   Introduce `AstBackend` interface and `EngineConfig`.
    -   Implement at least `web-tree-sitter` and a minimal JS-based backend.

Each step should be backed by unit and integration tests, especially around:

-   Backend selection and fallbacks.
-   Multi-line edit matching under different normalization levels.
-   Smart File Profile token size and latency.
-   tsconfig-based resolution correctness.

_Implementation status (December 2025):_ Phases 1–5 are now part of `smart-context-mcp`. The server selects between WASM, JS, and snapshot AST backends via `SMART_CONTEXT_*` env vars, `edit_file` enforces structural anchors + hash guards, Smart File Profiles include formatting + complexity + test hints, and `get_workflow_guidance` returns the structured playbook alongside enhanced error suggestions.

---

## 10. Additional Suggestions (Cross-Cutting)

#### 10.1 Observability

-   Establish clear logging standards for debugging agent failures and tracking tool usage.
-   Implement metrics collection for key performance indicators (e.g., latency of `read_file`, success rate of `edit_file`) and agent success criteria.
-   Structured logging (`JSON` format) for critical events to allow easier aggregation and analysis.

#### 10.2 Deprecation Plan

-   Formally document the deprecation timeline for `read_file(raw: true)` usage. Encourage agents to transition to Smart File Profile and `read_fragment`.
-   Provide clear warning messages in tool output when deprecated patterns are used.

#### 10.3 Security Considerations

-   For any new tools or parameters introduced (e.g., `expectedHash` for drift detection), ensure robust validation to prevent Injection or Privilege Escalation risks.
-   Re-evaluate path traversal checks for any new file access patterns introduced by `ModuleResolver` or AST backends.

---

## 11. References

- ADR-001: Smart Context MCP Server Architecture
- ADR-005: Reliability and Transactional Editing
- ADR-008: Pragmatic Reliability Enhancements
- ADR-009: EditorEngine String Matching Improvements
- ADR-010: Smart Semantic Analysis
- ADR-012: Project Intelligence (Enhanced Static Analysis)
- ADR-014: Smart File Profile - Token-Efficient Default File Reading
