import { EmbeddingConfig, EmbeddingProvider } from "../types.js";

const DEFAULT_LOCAL_MODEL = "multilingual-e5-small";
const DEFAULT_LOCAL_DIMS = 384;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_CONCURRENCY = 1;

export function resolveEmbeddingConfigFromEnv(): EmbeddingConfig {
    const providerRaw = process.env.SMART_CONTEXT_EMBEDDING_PROVIDER;
    const provider = normalizeProvider(providerRaw);
    const normalize = process.env.SMART_CONTEXT_EMBEDDING_NORMALIZE !== "false";
    const batchSize = parseOptionalInt(process.env.SMART_CONTEXT_EMBEDDING_BATCH_SIZE);
    const timeoutMs = parseOptionalInt(process.env.SMART_CONTEXT_EMBEDDING_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS;
    const concurrency = parseOptionalInt(process.env.SMART_CONTEXT_EMBEDDING_CONCURRENCY) ?? DEFAULT_CONCURRENCY;
    const maxQueueSize = parseOptionalInt(process.env.SMART_CONTEXT_EMBEDDING_MAX_QUEUE_SIZE);
    const modelCacheDir = process.env.SMART_CONTEXT_MODEL_CACHE_DIR?.trim() || undefined;
    const modelDir = process.env.SMART_CONTEXT_MODEL_DIR?.trim() || undefined;
    const localModelRaw = process.env.SMART_CONTEXT_EMBEDDING_MODEL ?? process.env.SMART_CONTEXT_LOCAL_EMBEDDING_MODEL;
    const localModel = normalizeLocalModel(providerRaw, localModelRaw) ?? DEFAULT_LOCAL_MODEL;
    const localDims = parseOptionalInt(process.env.SMART_CONTEXT_LOCAL_EMBEDDING_DIMS) ?? DEFAULT_LOCAL_DIMS;

    return {
        provider,
        normalize,
        batchSize,
        timeoutMs,
        concurrency,
        maxQueueSize,
        modelCacheDir,
        modelDir,
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
    if (normalized === "local") return "local";
    if (normalized === "hash") return "local";
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
    if (provider === "disabled") return { provider: "disabled" };
    return { provider: "local" };
}

function normalizeLocalModel(providerRaw: string | undefined, localModelRaw: string | undefined): string | undefined {
    const provider = providerRaw?.trim().toLowerCase() ?? "";
    if (provider === "hash") return "hash";
    const raw = localModelRaw?.trim();
    if (!raw) return undefined;
    if (raw.toLowerCase().startsWith("bundled:")) {
        return raw.slice("bundled:".length).trim();
    }
    return raw;
}
