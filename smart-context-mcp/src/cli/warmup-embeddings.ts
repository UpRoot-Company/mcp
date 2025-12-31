import { resolveEmbeddingConfigFromEnv } from "../embeddings/EmbeddingConfig.js";
import { EmbeddingProviderFactory } from "../embeddings/EmbeddingProviderFactory.js";

function parseArgs(argv: string[]) {
    const args = new Map<string, string | boolean>();
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (!a) continue;
        if (a === "--help" || a === "-h") args.set("help", true);
        else if (a === "--count") args.set("count", argv[i + 1] ?? "");
        else if (a === "--text") args.set("text", argv[i + 1] ?? "");
    }
    return args;
}

function usage(): string {
    return [
        "Usage: smart-context-warmup-embeddings [--count N] [--text \"...\"]",
        "",
        "Notes:",
        "- Uses SMART_CONTEXT_* embedding env config (provider/model/cache/timeout/concurrency).",
        "- Intended to download/initialize local embedding models ahead of first MCP call."
    ].join("\n");
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.get("help") === true) {
        console.log(usage());
        return;
    }

    const countRaw = args.get("count");
    const count = typeof countRaw === "string" && countRaw.trim() ? Number.parseInt(countRaw, 10) : 3;
    const textRaw = args.get("text");
    const baseText = typeof textRaw === "string" && textRaw.trim() ? textRaw : "Warmup embedding request.";

    const texts = Array.from({ length: Math.max(1, Math.min(16, Number.isFinite(count) ? count : 3)) }, (_, i) => `${baseText} (#${i + 1})`);
    const config = resolveEmbeddingConfigFromEnv();
    const factory = new EmbeddingProviderFactory(config);
    const provider = await factory.getProvider();

    const startedAt = Date.now();
    const vectors = await provider.embed(texts);
    const elapsed = Date.now() - startedAt;

    console.log(JSON.stringify({
        ok: true,
        provider: provider.provider,
        model: provider.model,
        dims: provider.dims,
        normalize: provider.normalize,
        count: vectors.length,
        elapsedMs: elapsed
    }));
}

main().catch((err) => {
    console.error(JSON.stringify({
        ok: false,
        error: String(err?.message ?? err)
    }));
    process.exitCode = 1;
});

