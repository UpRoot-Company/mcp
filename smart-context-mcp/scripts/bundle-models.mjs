import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_MODEL = "multilingual-e5-small";

const modelRaw = process.env.SMART_CONTEXT_EMBEDDING_MODEL || DEFAULT_MODEL;
const modelId = normalizeModelId(modelRaw);

if (!modelId || modelId === "hash") {
    console.log("[bundle-models] Hash embedding selected; skipping model bundle.");
    process.exit(0);
}

const sourceEnv = process.env.SMART_CONTEXT_MODEL_SOURCE
    || process.env.SMART_CONTEXT_MODEL_SOURCE_DIR
    || process.env.SMART_CONTEXT_MODEL_BUNDLE_SOURCE;
const sourceBase = sourceEnv
    ? path.resolve(sourceEnv)
    : path.join(ROOT_DIR, "models");

const skipBundle = process.env.SMART_CONTEXT_SKIP_MODEL_BUNDLE === "true";
const sourcePath = await resolveModelSource(sourceBase, modelId);
if (!sourcePath) {
    const message = `[bundle-models] Model source not found for "${modelId}". Set SMART_CONTEXT_MODEL_SOURCE or provide ./models/${modelId}.`;
    if (skipBundle) {
        console.warn(`${message} Skipping bundle because SMART_CONTEXT_SKIP_MODEL_BUNDLE=true.`);
        process.exit(0);
    }
    console.error(message);
    process.exit(1);
}

const destinationRoot = process.env.SMART_CONTEXT_MODEL_DIR
    ? path.resolve(process.env.SMART_CONTEXT_MODEL_DIR)
    : path.join(ROOT_DIR, "dist", "models");
const destinationPath = path.join(destinationRoot, modelId);

await fs.rm(destinationPath, { recursive: true, force: true });
await copyDir(sourcePath, destinationPath);

const required = ["config.json", "tokenizer.json", "tokenizer_config.json"];
const missing = await checkMissingFiles(destinationPath, required);
if (missing.length > 0) {
    console.warn(`[bundle-models] Bundled model missing expected files: ${missing.join(", ")}`);
}

console.log(`[bundle-models] Bundled "${modelId}" -> ${destinationPath}`);

function normalizeModelId(value) {
    const trimmed = String(value || "").trim();
    if (!trimmed) return "";
    if (trimmed.toLowerCase().startsWith("bundled:")) {
        return trimmed.slice("bundled:".length).trim();
    }
    return trimmed;
}

async function resolveModelSource(basePath, modelId) {
    if (await looksLikeModelRoot(basePath)) {
        return basePath;
    }
    const candidate = path.join(basePath, modelId);
    if (await looksLikeModelRoot(candidate)) {
        return candidate;
    }
    return null;
}

async function looksLikeModelRoot(candidate) {
    try {
        const stat = await fs.stat(candidate);
        if (!stat.isDirectory()) return false;
        const configPath = path.join(candidate, "config.json");
        const tokenizerPath = path.join(candidate, "tokenizer.json");
        await fs.access(configPath);
        await fs.access(tokenizerPath);
        return true;
    } catch {
        return false;
    }
}

async function copyDir(src, dest) {
    await fs.mkdir(dest, { recursive: true });
    const entries = await fs.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            await copyDir(srcPath, destPath);
        } else if (entry.isFile()) {
            await fs.copyFile(srcPath, destPath);
        }
    }
}

async function checkMissingFiles(root, files) {
    const missing = [];
    for (const file of files) {
        try {
            await fs.access(path.join(root, file));
        } catch {
            missing.push(file);
        }
    }
    return missing;
}
