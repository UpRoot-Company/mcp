import { describe, it, expect } from "@jest/globals";
import { resolveEmbeddingConfigFromEnv } from "../embeddings/EmbeddingConfig.js";

describe("EmbeddingConfig", () => {
    it("normalizes bundled model prefix", () => {
        const originalModel = process.env.SMART_CONTEXT_EMBEDDING_MODEL;
        process.env.SMART_CONTEXT_EMBEDDING_MODEL = "bundled:multilingual-e5-small";

        const config = resolveEmbeddingConfigFromEnv();
        expect(config.local?.model).toBe("multilingual-e5-small");

        if (originalModel === undefined) {
            delete process.env.SMART_CONTEXT_EMBEDDING_MODEL;
        } else {
            process.env.SMART_CONTEXT_EMBEDDING_MODEL = originalModel;
        }
    });

    it("forces hash model when provider=hash", () => {
        const originalProvider = process.env.SMART_CONTEXT_EMBEDDING_PROVIDER;
        const originalModel = process.env.SMART_CONTEXT_EMBEDDING_MODEL;
        process.env.SMART_CONTEXT_EMBEDDING_PROVIDER = "hash";
        process.env.SMART_CONTEXT_EMBEDDING_MODEL = "multilingual-e5-small";

        const config = resolveEmbeddingConfigFromEnv();
        expect(config.local?.model).toBe("hash");

        if (originalProvider === undefined) {
            delete process.env.SMART_CONTEXT_EMBEDDING_PROVIDER;
        } else {
            process.env.SMART_CONTEXT_EMBEDDING_PROVIDER = originalProvider;
        }
        if (originalModel === undefined) {
            delete process.env.SMART_CONTEXT_EMBEDDING_MODEL;
        } else {
            process.env.SMART_CONTEXT_EMBEDDING_MODEL = originalModel;
        }
    });
});
