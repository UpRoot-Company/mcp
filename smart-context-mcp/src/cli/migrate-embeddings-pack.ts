#!/usr/bin/env node

import * as fs from "fs";
import * as path from "path";
import { PathManager } from "../utils/PathManager.js";
import { resolveEmbeddingConfigFromEnv, resolveEmbeddingProviderEnv } from "../embeddings/EmbeddingConfig.js";
import { EmbeddingPackManager, resolveEmbeddingPackConfigFromEnv, type EmbeddingPackFormat } from "../storage/EmbeddingPack.js";

type LegacyEmbedding = {
    provider: string;
    model: string;
    dims: number;
    vector: string;
    norm?: number;
};

function decodeVector(encoded: string): Float32Array {
    const buffer = Buffer.from(encoded, "base64");
    return new Float32Array(buffer.buffer, buffer.byteOffset, buffer.byteLength / 4);
}

function parseFormatArg(argv: string[]): EmbeddingPackFormat | null {
    const idx = argv.findIndex(arg => arg === "--format");
    if (idx === -1) return null;
    const value = (argv[idx + 1] ?? "").trim().toLowerCase();
    if (value === "q8") return "q8";
    if (value === "both") return "both";
    if (value === "float32" || value === "f32") return "float32";
    return null;
}

function hasFlag(argv: string[], flag: string): boolean {
    return argv.includes(flag);
}

async function main(): Promise<void> {
    const argv = process.argv.slice(2);
    const formatArg = parseFormatArg(argv);
    const force = hasFlag(argv, "--force");

    const rootPath = process.env.SMART_CONTEXT_ROOT ?? process.cwd();
    PathManager.setRoot(rootPath);

    if (!process.env.SMART_CONTEXT_EMBEDDING_PACK_FORMAT) {
        process.env.SMART_CONTEXT_EMBEDDING_PACK_FORMAT = formatArg ?? "float32";
    } else if (formatArg) {
        process.env.SMART_CONTEXT_EMBEDDING_PACK_FORMAT = formatArg;
    }

    const embeddingConfig = resolveEmbeddingConfigFromEnv();
    const provider = resolveEmbeddingProviderEnv(embeddingConfig).provider;
    const model = embeddingConfig.local?.model;
    if (provider === "disabled" || !model || model === "hash") {
        console.error("[embeddings-pack] Embeddings are disabled or unsupported; set SMART_CONTEXT_EMBEDDING_MODEL.");
        process.exit(1);
    }

    const legacyPath = path.join(PathManager.getStorageDir(), "embeddings.json");
    if (!fs.existsSync(legacyPath)) {
        console.error(`[embeddings-pack] Legacy embeddings file not found: ${legacyPath}`);
        process.exit(1);
    }

    const config = resolveEmbeddingPackConfigFromEnv();
    if (!config.enabled) {
        console.error("[embeddings-pack] Pack is disabled; set SMART_CONTEXT_EMBEDDING_PACK_FORMAT=float32|q8|both.");
        process.exit(1);
    }

    const pack = new EmbeddingPackManager({ provider, model }, config);

    if (!force && pack.hasPackOnDisk()) {
        console.error("[embeddings-pack] Pack already exists; pass --force to overwrite.");
        process.exit(1);
    }

    if (force) {
        const dir = path.join(PathManager.getStorageDir(), "v1", "embeddings", provider, model);
        fs.rmSync(dir, { recursive: true, force: true });
    }

    const raw = fs.readFileSync(legacyPath, "utf8");
    const legacy = JSON.parse(raw) as Record<string, Record<string, LegacyEmbedding>>;

    let written = 0;
    for (const [chunkId, variants] of Object.entries(legacy)) {
        for (const [variantKey, payload] of Object.entries(variants ?? {})) {
            const [p, m] = variantKey.split("::", 2);
            if (p !== provider || m !== model) continue;
            if (!payload?.vector || !payload?.dims) continue;
            const vector = decodeVector(payload.vector);
            pack.upsertEmbedding(chunkId, { dims: payload.dims, vector, norm: payload.norm });
            written++;
        }
    }

    pack.markReady();
    pack.close();
    console.log(`[embeddings-pack] Migrated ${written} embeddings for ${provider}/${model} (${config.format}).`);
}

void main().catch((err) => {
    console.error("[embeddings-pack] Failed:", err);
    process.exit(1);
});
