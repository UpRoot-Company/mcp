# Getting Started (Smart Context MCP)

Smart Context MCP is an MCP server that communicates over **stdio**. Your MCP host (Codex/Claude/etc.) launches it and applies timeouts/permissions.

## Requirements

- Node.js **v22**
- `npm`


## Run from this repo

```bash
cd smart-context-mcp
npm ci
npm run build
node dist/index.js
```

## Use as an MCP server (example config)

Point your MCP host at the built entry:

```json
{
  "command": "node",
  "args": ["/absolute/path/to/smart-context-mcp/dist/index.js"],
  "timeout": 300000,
  "env": {
    "NODE_OPTIONS": "--max-old-space-size=4096",
    "SMART_CONTEXT_ENGINE_PROFILE": "production",
    "SMART_CONTEXT_QUERY_TIMEOUT": "240000",
    "SMART_CONTEXT_MAX_RESULTS": "25"
  }
}
```

If your MCP host runs the server from a different working directory, set `SMART_CONTEXT_ROOT` to your project root.

## First calls

- `explore({ query: "entrypoint" })`
- `explore({ paths: ["README.md"], view: "preview" })`
- `understand({ goal: "Explain the project architecture" })`
- `change({ intent: "…", options: { dryRun: true } })`

See `smart-context-mcp/docs/agent/TOOL_REFERENCE.md`.

## Next

- Configuration: `smart-context-mcp/docs/guides/configuration.md`
- Permissions patterns: `smart-context-mcp/docs/guides/permissions.md`
- Common failures: `smart-context-mcp/docs/guides/troubleshooting.md`
