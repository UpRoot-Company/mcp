#!/usr/bin/env node

import { IndexDatabase } from "../indexing/IndexDatabase.js";
import { EmbeddingRepository } from "../indexing/EmbeddingRepository.js";
import { resolveEmbeddingConfigFromEnv, resolveEmbeddingProviderEnv } from "../embeddings/EmbeddingConfig.js";
import { VectorIndexManager } from "../vector/VectorIndexManager.js";
import { PathManager } from "../utils/PathManager.js";

async function main(): Promise<void> {
    const rootPath = process.env.SMART_CONTEXT_ROOT ?? process.cwd();
    PathManager.setRoot(rootPath);

    const indexDb = new IndexDatabase(rootPath);
    const embeddingRepository = new EmbeddingRepository(indexDb);
    const manager = new VectorIndexManager(rootPath, embeddingRepository);

    const embeddingConfig = resolveEmbeddingConfigFromEnv();
    const provider = resolveEmbeddingProviderEnv(embeddingConfig).provider;
    const model = embeddingConfig.local?.model;
    if (provider === "disabled" || !model || model === "hash") {
        console.error("[vector-index] Embeddings are disabled or unsupported; set SMART_CONTEXT_EMBEDDING_MODEL.");
        process.exit(1);
    }

    await manager.rebuildFromRepository(provider, model);
    console.log(`[vector-index] Rebuilt index for ${provider}/${model}.`);
}

void main().catch((err) => {
    console.error("[vector-index] Failed to rebuild:", err);
    process.exit(1);
});
