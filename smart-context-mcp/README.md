# Smart Context MCP

Smart Context MCP is a Model Context Protocol (MCP) server for AI-assisted code understanding and safe code changes.

## Six Pillars (agent-facing API)

Per `smart-context-mcp/docs/adr/ADR-033-Six-Pillars-Architecture.md`, the primary interface is:

- `navigate` — locate symbols/files
- `read` — read content efficiently (skeleton/fragment/full)
- `understand` — synthesize structure/relationships
- `change` — plan/apply safe edits (dry-run first)
- `write` — create/scaffold files
- `manage` — status/undo/redo/reindex/history

Legacy tool names (e.g. `search_project`, `read_code`, `edit_code`) are opt-in; see `smart-context-mcp/docs/legacy/README.md`.

## Docs

- `smart-context-mcp/docs/README.md` — entry point
- `smart-context-mcp/docs/agent/AGENT_PLAYBOOK.md` — usage patterns
- `smart-context-mcp/docs/agent/TOOL_REFERENCE.md` — pillar reference
- `smart-context-mcp/docs/guides/getting-started.md` — setup + first flows

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

**Last Updated:** 2025-12-30
