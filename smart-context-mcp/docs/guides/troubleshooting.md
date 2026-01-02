# Troubleshooting

## MCP host timeouts / slow first run

- Increase the host timeout (many hosts default to 30s).
- Increase `SMART_CONTEXT_QUERY_TIMEOUT` (ms).
- Give Node more heap for indexing: `NODE_OPTIONS=--max-old-space-size=4096`.

## “My MCP host can’t parse responses / protocol errors”

Stdout must be reserved for MCP protocol frames. Keep stdout logging disabled:
- do **not** set `SMART_CONTEXT_ALLOW_STDOUT_LOGS=true` when running under an MCP host
- prefer file logging via `SMART_CONTEXT_LOG_TO_FILE=true` if you need logs

## Markdown parser / `tree-sitter-markdown.wasm`

If you want `tree-sitter`-based Markdown parsing and you have a local `tree-sitter-markdown` grammar checkout:

```bash
npm run build
node dist/cli/build-markdown-wasm.js --source /path/to/tree-sitter-markdown
```

Default output: `smart-context-mcp/wasm/tree-sitter-markdown.wasm`.
