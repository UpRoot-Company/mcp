export type VectorIndexMode = "auto" | "off" | "bruteforce" | "hnsw";
export type VectorIndexRebuildPolicy = "auto" | "on_start" | "manual";
export type VectorIndexShardSetting = "off" | "auto" | number;

export interface VectorIndexConfig {
    mode: VectorIndexMode;
    rebuild: VectorIndexRebuildPolicy;
    maxPoints: number;
    m: number;
    efConstruction: number;
    efSearch: number;
    shards: VectorIndexShardSetting;
}

const DEFAULT_CONFIG: VectorIndexConfig = {
    mode: "auto",
    rebuild: "auto",
    maxPoints: 200000,
    m: 16,
    efConstruction: 200,
    efSearch: 64,
    shards: "off"
};

export function resolveVectorIndexConfigFromEnv(): VectorIndexConfig {
    const mode = normalizeMode(process.env.SMART_CONTEXT_VECTOR_INDEX) ?? DEFAULT_CONFIG.mode;
    const rebuild = normalizeRebuild(process.env.SMART_CONTEXT_VECTOR_INDEX_REBUILD) ?? DEFAULT_CONFIG.rebuild;
    const maxPoints = parseNumber(process.env.SMART_CONTEXT_VECTOR_INDEX_MAX_POINTS, DEFAULT_CONFIG.maxPoints);
    const m = parseNumber(process.env.SMART_CONTEXT_VECTOR_INDEX_M, DEFAULT_CONFIG.m);
    const efConstruction = parseNumber(process.env.SMART_CONTEXT_VECTOR_INDEX_EF_CONSTRUCTION, DEFAULT_CONFIG.efConstruction);
    const efSearch = parseNumber(process.env.SMART_CONTEXT_VECTOR_INDEX_EF_SEARCH, DEFAULT_CONFIG.efSearch);
    const shards = normalizeShards(process.env.SMART_CONTEXT_VECTOR_INDEX_SHARDS) ?? DEFAULT_CONFIG.shards;
    return { mode, rebuild, maxPoints, m, efConstruction, efSearch, shards };
}

function normalizeMode(value: string | undefined): VectorIndexMode | undefined {
    if (!value) return undefined;
    const normalized = value.trim().toLowerCase();
    if (normalized === "auto") return "auto";
    if (normalized === "off") return "off";
    if (normalized === "bruteforce") return "bruteforce";
    if (normalized === "hnsw") return "hnsw";
    return undefined;
}

function normalizeRebuild(value: string | undefined): VectorIndexRebuildPolicy | undefined {
    if (!value) return undefined;
    const normalized = value.trim().toLowerCase();
    if (normalized === "auto") return "auto";
    if (normalized === "on_start") return "on_start";
    if (normalized === "manual") return "manual";
    return undefined;
}

function parseNumber(raw: string | undefined, fallback: number): number {
    if (!raw) return fallback;
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeShards(value: string | undefined): VectorIndexShardSetting | undefined {
    if (!value) return undefined;
    const normalized = value.trim().toLowerCase();
    if (normalized === "off") return "off";
    if (normalized === "auto") return "auto";
    const parsed = Number.parseInt(normalized, 10);
    if (Number.isFinite(parsed) && parsed >= 1) return parsed;
    return undefined;
}
