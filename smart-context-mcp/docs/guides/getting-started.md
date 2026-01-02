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

## Prepare the local embedding model (offline)

Runtime downloads are disabled, so you must prepare a local model before bundling or running in a closed environment.

Recommended source: `Xenova/multilingual-e5-small` (ONNX + tokenizer files compatible with `@xenova/transformers`).

```bash
# On a machine with internet access (example using Hugging Face CLI)
huggingface-cli download Xenova/multilingual-e5-small \
  --local-dir /tmp/models/multilingual-e5-small \
  --local-dir-use-symlinks false

# Alternative (git-lfs)
# git lfs clone https://huggingface.co/Xenova/multilingual-e5-small /tmp/models/multilingual-e5-small
```

Copy the folder to your offline machine. The model directory should look like:

```
models/
  multilingual-e5-small/
    config.json
    tokenizer.json
    tokenizer_config.json
    special_tokens_map.json    (optional)
    onnx/
      model.onnx
      model_quantized.onnx     (recommended)
```

- The folder name must match `SMART_CONTEXT_EMBEDDING_MODEL` (default: `multilingual-e5-small`).
- If you use a different model, ensure it ships ONNX + tokenizer assets compatible with `@xenova/transformers`.

## Bundle the offline embedding model (packaging)

When creating a release artifact, bundle the local model into `dist/models`:

```bash
# Point to a local model folder (either the model root, or a parent containing it)
SMART_CONTEXT_MODEL_SOURCE=/path/to/models \
SMART_CONTEXT_EMBEDDING_MODEL=multilingual-e5-small \
npm run bundle:models
```

- `npm pack` / `npm publish` runs the bundling automatically via `prepack`.
- Set `SMART_CONTEXT_SKIP_MODEL_BUNDLE=true` to skip bundling (dev-only).
- If you override `SMART_CONTEXT_MODEL_DIR`, keep it inside `dist/models` so it ships with the package.

## Build the vector index (P1 optional)

When ANN is enabled and you want to avoid rebuild at startup, generate the vector index once:

```bash
SMART_CONTEXT_VECTOR_INDEX=hnsw \
SMART_CONTEXT_VECTOR_INDEX_REBUILD=manual \
smart-context-build-vector-index
```

- For large repos, consider sharding: `SMART_CONTEXT_VECTOR_INDEX_SHARDS=auto` (or a number like `4`).
- Default `SMART_CONTEXT_VECTOR_INDEX=auto` will fall back to brute-force if no index exists.
- The index is stored under `.smart-context/vector-index/<provider>/<model>/`.

## Build the embeddings pack (P2 optional)

For large repos, you can migrate legacy embedding persistence (`.smart-context/storage/embeddings.json`) into a binary pack:

```bash
# float32 (safe default)
SMART_CONTEXT_EMBEDDING_PACK_FORMAT=float32 \
smart-context-migrate-embeddings-pack

# or store both float32 + q8 (recommended for future scaling experiments)
SMART_CONTEXT_EMBEDDING_PACK_FORMAT=both \
smart-context-migrate-embeddings-pack
```

- Pass `--force` to overwrite an existing pack.
- Pack files are stored under `.smart-context/storage/v1/embeddings/<provider>/<model>/`.

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
