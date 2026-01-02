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
| `SMART_CONTEXT_STORAGE_MODE` | Storage backend. | `file` (default) or `memory` (non-persistent). |

## Documents / parsers

| Variable | Purpose |
|---|---|
| `SMART_CONTEXT_WASM_DIR` | Where tree-sitter WASM assets are resolved (including custom Markdown WASM). |

## Skeleton (large files)

| Variable | Purpose |
|---|---|
| `SMART_CONTEXT_SKELETON_AUTO_MINIMAL_LINES` | Auto-switch to `detailLevel=minimal` when line count exceeds threshold (0 disables). |

## Embeddings (optional)

| Variable | Purpose |
|---|---|
| `SMART_CONTEXT_EMBEDDING_PROVIDER` | Select embedding backend (`local`, `hash`, `disabled`). |
| `SMART_CONTEXT_EMBEDDING_MODEL` | Bundled/local model identifier (default: `multilingual-e5-small`). |
| `SMART_CONTEXT_MODEL_DIR` | Bundled model directory override (no remote downloads). |
| `SMART_CONTEXT_MODEL_CACHE_DIR` | Local model cache directory override. |
| `SMART_CONTEXT_EMBEDDING_E5_PREFIX` | Enable E5 `query:`/`passage:` prefixing (default: true). |

The local model folder name must match `SMART_CONTEXT_EMBEDDING_MODEL`. See `docs/guides/getting-started.md` for download/prep steps.

## Embeddings pack (P2 optional)

For large repos, persisting embeddings as a binary pack reduces restore time and disk footprint (vs legacy JSON+base64).

| Variable | Purpose |
|---|---|
| `SMART_CONTEXT_EMBEDDING_PACK_FORMAT` | Enable pack persistence: `float32`, `q8`, or `both` (unset = disabled/legacy). |
| `SMART_CONTEXT_EMBEDDING_PACK_REBUILD` | Policy: `auto`, `on_start`, `manual` (migration/rollout control). |
| `SMART_CONTEXT_EMBEDDING_PACK_INDEX` | Index format: `json` (default) or `bin` (reserved). |
| `SMART_CONTEXT_VECTOR_CACHE_MB` | Max MB for the on-demand embedding vector cache. |

Use `smart-context-migrate-embeddings-pack` to migrate legacy `.smart-context/storage/embeddings.json` into `.smart-context/storage/v1/embeddings/<provider>/<model>/`.

## Vector index (P1)

| Variable | Purpose |
|---|---|
| `SMART_CONTEXT_VECTOR_INDEX` | Vector index backend (`auto`, `off`, `bruteforce`, `hnsw`). |
| `SMART_CONTEXT_VECTOR_INDEX_REBUILD` | Rebuild policy (`auto`, `on_start`, `manual`). |
| `SMART_CONTEXT_VECTOR_INDEX_SHARDS` | Shard count for large repos (`off`, `auto`, or a number). |
| `SMART_CONTEXT_VECTOR_INDEX_MAX_POINTS` | Index size cap for ANN builds. |
| `SMART_CONTEXT_VECTOR_INDEX_M` | HNSW M parameter. |
| `SMART_CONTEXT_VECTOR_INDEX_EF_CONSTRUCTION` | HNSW build parameter. |
| `SMART_CONTEXT_VECTOR_INDEX_EF_SEARCH` | HNSW search parameter. |

When `SMART_CONTEXT_VECTOR_INDEX_REBUILD=manual`, use the CLI `smart-context-build-vector-index`.

## Trigram memory guard rails (P1)

| Variable | Purpose |
|---|---|
| `SMART_CONTEXT_TRIGRAM_MAX_DOC_FREQ` | Drop trigrams above document frequency threshold (0-1). |
| `SMART_CONTEXT_TRIGRAM_MAX_TERMS_PER_FILE` | Per-file trigram cap to limit memory. |

## Packaging (model bundle)

| Variable | Purpose |
|---|---|
| `SMART_CONTEXT_MODEL_SOURCE` | Source directory used by `npm run bundle:models` (model root or parent). |
| `SMART_CONTEXT_SKIP_MODEL_BUNDLE` | Skip bundling in `prepack` (`true` to skip). |

## Integrity audit (ADR-041)

| Variable | Purpose |
|---|---|
| `SMART_CONTEXT_INTEGRITY_MODE` | Default integrity behavior. |
| `SMART_CONTEXT_INTEGRITY_SCOPE` | Default scope (`docs` vs `project` vs `auto`). |
| `SMART_CONTEXT_INTEGRITY_BLOCK_POLICY` | Whether high-severity findings block apply. |

## Full list (source of truth)

Search the codebase: `rg "process\\.env\\.SMART_CONTEXT_" smart-context-mcp/src`.
