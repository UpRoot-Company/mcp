# Smart Context MCP

Smart Context MCP is a Model Context Protocol (MCP) server for AI-assisted code understanding and safe code changes.

## Quickstart (repo)

```bash
cd smart-context-mcp
npm ci
npm run build
node dist/index.js
```

## VS Code / Copilot MCP root path

Some MCP hosts may launch the server with an unexpected working directory (e.g. `~` or a parent folder). If that happens, Smart Context may try to index *everything under that directory*.

Pin the project root explicitly:

- Env (preferred): `SMART_CONTEXT_ROOT_PATH=/absolute/path/to/your/project`
- CLI: `node dist/index.js --root /absolute/path/to/your/project`

## Memory tuning (search)

The project search uses an in-memory trigram index for fast candidate selection. On very large repos this can consume multiple GB of RAM.

- Disable trigram indexing (lowest memory, slower candidate selection):
	- `SMART_CONTEXT_TRIGRAM_INDEX=disabled` (or `SMART_CONTEXT_TRIGRAM_ENABLED=false`)
- Reduce per-file indexing cost:
	- `SMART_CONTEXT_TRIGRAM_MAX_FILE_BYTES=131072` (example: 128KB)
- Restrict indexed extensions (comma-separated):
	- `SMART_CONTEXT_TRIGRAM_INCLUDE_EXTENSIONS=.ts,.tsx,.js,.jsx,.py,.md`


## Five Pillars (agent-facing API)

Per `smart-context-mcp/docs/adr/ADR-040-five-pillars-explore-consolidation.md`, the primary interface is:

- `explore` — unified discovery (search + preview/section + optional full reads)
- `understand` — synthesize structure/relationships
- `change` — plan/apply safe edits (dry-run first)
  - **Layer 3 AI Features** (ADR-042-006):
    - Smart fuzzy match: Intent-based symbol search with embeddings
    - Symbol-level impact analysis: AST diff + auto-repair suggestions
    - Quick code generation: Style inference + template generation
- `write` — create/scaffold files
  - **Layer 3 AI Features**:
    - Pattern-based generation: Extracts project patterns for consistent code
    - Smart write: VectorSearch → PatternExtractor → TemplateGenerator pipeline
- `manage` — status/undo/redo/reindex/history

**AI-Enhanced Capabilities** (Layer 3):
- **Smart Fuzzy Match**: Embedding-based symbol search when exact matches fail
- **AST Impact Analysis**: Symbol-level change impact with repair suggestions
- **Code Generation**: Infers project style and generates matching code
- **Pattern Extraction**: Learns from similar files to maintain consistency

ENV Controls:
```bash
# Layer 3 AI Features (all default to false)
SMART_CONTEXT_LAYER3_SMART_MATCH=true        # Enable smart fuzzy symbol matching
SMART_CONTEXT_LAYER3_SYMBOL_IMPACT=true     # Enable symbol-level impact analysis
SMART_CONTEXT_LAYER3_CODE_GEN=true           # Enable code generation features
```

Legacy tool names (e.g. `search_project`, `read_code`, `edit_code`) are opt-in; see `smart-context-mcp/docs/compat/README.md`.

## Docs

- `smart-context-mcp/docs/README.md` — entry point
- `smart-context-mcp/docs/agent/AGENT_PLAYBOOK.md` — usage patterns
- `smart-context-mcp/docs/agent/TOOL_REFERENCE.md` — pillar reference
- `smart-context-mcp/docs/guides/getting-started.md` — setup + first flows (Node v22)

## Markdown WASM (tree-sitter)

The Markdown parser can use a custom `tree-sitter-markdown.wasm`. A helper CLI builds and installs it from a local grammar repo:

```bash
npm run build
node dist/cli/build-markdown-wasm.js --source /path/to/tree-sitter-markdown
```

Or via npm script:

```bash
npm run build:markdown-wasm -- --source /path/to/tree-sitter-markdown
```

Default output is `smart-context-mcp/wasm/tree-sitter-markdown.wasm`. Override with `--out` or `SMART_CONTEXT_WASM_DIR`.  
If you install the package globally or use `npm link`, the `smart-context-build-markdown-wasm` command will also be available.

**Last Updated:** 2025-12-31
