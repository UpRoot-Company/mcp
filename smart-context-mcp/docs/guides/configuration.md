# Configuration (Minimal)

Smart Context MCP is configured via environment variables. Most users only need a few.

## Common env vars

| Variable | Purpose | Notes |
|---|---|---|
| `SMART_CONTEXT_ROOT` | Project root to analyze. | Defaults to process cwd; set this if your MCP host runs from a different cwd. |
| `SMART_CONTEXT_DIR` | Data directory. | Defaults to `.smart-context` (contains index/cache/history). |
| `SMART_CONTEXT_ENGINE_PROFILE` | Runtime profile. | Keep `production` for normal use; tests may use `test`. |
| `SMART_CONTEXT_QUERY_TIMEOUT` | Per-request timeout (ms). | Useful when hosts have aggressive timeouts. |
| `SMART_CONTEXT_MAX_RESULTS` | Search result cap. | Lower for token-efficiency; raise for recall. |
| `SMART_CONTEXT_LOG_LEVEL` | Structured logging level. | `debug|info|warn|error`. |
| `SMART_CONTEXT_LOG_TO_FILE` | Persist logs under `.smart-context`. | Prefer this in MCP hosts (keeps stdout clean). |
| `SMART_CONTEXT_ALLOW_STDOUT_LOGS` | Allow stdout logs. | Avoid in MCP hosts; stdout is reserved for MCP frames. |

## Documents / parsers

| Variable | Purpose |
|---|---|
| `SMART_CONTEXT_WASM_DIR` | Where tree-sitter WASM assets are resolved (including custom Markdown WASM). |

## Embeddings (optional)

| Variable | Purpose |
|---|---|
| `SMART_CONTEXT_EMBEDDING_PROVIDER` | Select embedding backend (`local`, `hash`, `disabled`). |
| `SMART_CONTEXT_EMBEDDING_MODEL` | Bundled/local model identifier (default: `multilingual-e5-small`). |
| `SMART_CONTEXT_MODEL_DIR` | Bundled model directory override (no remote downloads). |
| `SMART_CONTEXT_MODEL_CACHE_DIR` | Local model cache directory override. |
| `SMART_CONTEXT_EMBEDDING_E5_PREFIX` | Enable E5 `query:`/`passage:` prefixing (default: true). |

## Integrity audit (ADR-041)

| Variable | Purpose |
|---|---|
| `SMART_CONTEXT_INTEGRITY_MODE` | Default integrity behavior. |
| `SMART_CONTEXT_INTEGRITY_SCOPE` | Default scope (`docs` vs `project` vs `auto`). |
| `SMART_CONTEXT_INTEGRITY_BLOCK_POLICY` | Whether high-severity findings block apply. |

## Full list (source of truth)

Search the codebase: `rg "process\\.env\\.SMART_CONTEXT_" smart-context-mcp/src`.
