import { EmbeddingConfig, EmbeddingProvider } from "../types.js";

const DEFAULT_OPENAI_MODEL = "text-embedding-3-small";
const DEFAULT_LOCAL_MODEL = "Xenova/all-MiniLM-L6-v2";
const DEFAULT_LOCAL_DIMS = 384;

export function resolveEmbeddingConfigFromEnv(): EmbeddingConfig {
    const providerRaw = process.env.SMART_CONTEXT_EMBEDDING_PROVIDER;
    const provider = normalizeProvider(providerRaw);
    const normalize = process.env.SMART_CONTEXT_EMBEDDING_NORMALIZE !== "false";
    const batchSize = parseOptionalInt(process.env.SMART_CONTEXT_EMBEDDING_BATCH_SIZE);
    const openaiApiKeyEnv = process.env.SMART_CONTEXT_OPENAI_KEY_ENV ?? "OPENAI_API_KEY";
    const openaiModel = process.env.SMART_CONTEXT_OPENAI_MODEL ?? DEFAULT_OPENAI_MODEL;
    const localModel = process.env.SMART_CONTEXT_LOCAL_EMBEDDING_MODEL ?? DEFAULT_LOCAL_MODEL;
    const localDims = parseOptionalInt(process.env.SMART_CONTEXT_LOCAL_EMBEDDING_DIMS) ?? DEFAULT_LOCAL_DIMS;

    return {
        provider,
        normalize,
        batchSize,
        openai: {
            apiKeyEnv: openaiApiKeyEnv,
            model: openaiModel
        },
        local: {
            model: localModel,
            dims: localDims
        }
    };
}

function normalizeProvider(value: string | undefined): EmbeddingConfig["provider"] {
    if (!value) return "auto";
    const normalized = value.trim().toLowerCase();
    if (normalized === "auto") return "auto";
    if (normalized === "openai") return "openai";
    if (normalized === "local") return "local";
    if (normalized === "disabled") return "disabled";
    return "auto";
}

function parseOptionalInt(value: string | undefined): number | undefined {
    if (!value) return undefined;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : undefined;
}

export function resolveEmbeddingProviderEnv(config: EmbeddingConfig): { provider: EmbeddingProvider; apiKey?: string } {
    const provider = (config.provider ?? "auto") as EmbeddingConfig["provider"];
    if (provider === "openai") {
        const apiKey = resolveApiKey(config.openai?.apiKeyEnv);
        return { provider: apiKey ? "openai" : "disabled", apiKey };
    }
    if (provider === "local") return { provider: "local" };
    if (provider === "disabled") return { provider: "disabled" };

    const apiKey = resolveApiKey(config.openai?.apiKeyEnv);
    if (apiKey) {
        return { provider: "openai", apiKey };
    }
    return { provider: "local" };
}

function resolveApiKey(envName?: string): string | undefined {
    const keyName = envName ?? "OPENAI_API_KEY";
    const value = process.env[keyName];
    if (!value) return undefined;
    return value.trim() || undefined;
}
