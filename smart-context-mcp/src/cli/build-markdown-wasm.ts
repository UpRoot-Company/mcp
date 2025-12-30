import * as fs from "fs";
import * as path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const WASM_NAME = "tree-sitter-markdown.wasm";

function usage(): void {
    console.log(`smart-context-mcp markdown wasm builder

Usage:
  smart-context-build-markdown-wasm --source <localPath> [--out <dir>] [--root <projectRoot>] [--force]

Options:
  --source  Local path to tree-sitter-markdown grammar repo
  --out     Output directory for wasm (default: <projectRoot>/wasm)
  --root    Project root (default: inferred from script location)
  --force   Overwrite existing wasm in output directory
`);
}

function getArg(args: string[], flag: string): string | undefined {
    const idx = args.indexOf(flag);
    if (idx === -1 || idx + 1 >= args.length) return undefined;
    return args[idx + 1];
}

function resolveProjectRoot(): string {
    const moduleDir = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(moduleDir, "..", "..");
}

function ensureDir(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

function resolveGrammarDir(sourcePath: string): string {
    if (fs.existsSync(path.join(sourcePath, "grammar.js"))) {
        return sourcePath;
    }

    const entries = fs.readdirSync(sourcePath, { withFileTypes: true });
    const candidates = entries
        .filter(entry => entry.isDirectory())
        .map(entry => path.join(sourcePath, entry.name))
        .filter(dirPath => fs.existsSync(path.join(dirPath, "grammar.js")));

    if (candidates.length === 0) {
        return sourcePath;
    }

    const preferred = candidates.find(candidate => path.basename(candidate) === "tree-sitter-markdown");
    if (preferred) return preferred;

    if (candidates.length === 1) {
        return candidates[0];
    }

    throw new Error(`Multiple grammar directories found: ${candidates.map(candidate => path.basename(candidate)).join(", ")}`);
}

function supportsWasmFlag(): boolean {
    const result = spawnSync("tree-sitter", ["build", "--help"], {
        encoding: "utf-8"
    });
    if (result.error) return false;
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    return output.includes("--wasm");
}

function runBuild(sourcePath: string, outFile: string, env: NodeJS.ProcessEnv): void {
    if (supportsWasmFlag()) {
        const result = spawnSync("tree-sitter", ["build", "--wasm", "--output", outFile], {
            cwd: sourcePath,
            stdio: "inherit",
            env
        });
        if (result.error) {
            throw result.error;
        }
        if (result.status !== 0) {
            throw new Error(`tree-sitter build --wasm failed with exit code ${result.status ?? "unknown"}`);
        }
        return;
    }

    const fallback = spawnSync("tree-sitter", ["build-wasm"], {
        cwd: sourcePath,
        stdio: "inherit",
        env
    });
    if (fallback.error) {
        throw fallback.error;
    }
    if (fallback.status !== 0) {
        throw new Error(`tree-sitter build-wasm failed with exit code ${fallback.status ?? "unknown"}`);
    }
}

function findWasmFile(sourcePath: string): string | null {
    const candidates = [
        path.join(sourcePath, WASM_NAME),
        path.join(sourcePath, "dist", WASM_NAME),
        path.join(sourcePath, "build", WASM_NAME),
        path.join(sourcePath, "out", WASM_NAME)
    ];
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return searchWasmRecursive(sourcePath, 2);
}

function searchWasmRecursive(root: string, depth: number): string | null {
    if (depth < 0) return null;
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
        return null;
    }
    for (const entry of entries) {
        if (entry.isFile() && entry.name === WASM_NAME) {
            return path.join(root, entry.name);
        }
    }
    for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        const found = searchWasmRecursive(path.join(root, entry.name), depth - 1);
        if (found) return found;
    }
    return null;
}

function main(): void {
    const args = process.argv.slice(2);
    if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
        usage();
        process.exit(args.length === 0 ? 1 : 0);
    }

    const sourceArg = getArg(args, "--source");
    if (!sourceArg) {
        usage();
        process.exit(1);
    }
    const sourcePath = path.resolve(sourceArg);
    if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isDirectory()) {
        console.error(`Source path not found or not a directory: ${sourcePath}`);
        process.exit(2);
    }

    let grammarPath = sourcePath;
    try {
        grammarPath = resolveGrammarDir(sourcePath);
    } catch (error) {
        console.error((error as Error).message);
        console.error("Please point --source to a specific grammar directory.");
        process.exit(2);
    }

    const rootPath = path.resolve(getArg(args, "--root") ?? resolveProjectRoot());
    const outDir = path.resolve(getArg(args, "--out") ?? path.join(rootPath, "wasm"));
    const outFile = path.join(outDir, WASM_NAME);
    const force = args.includes("--force");
    const cacheDir = (process.env.XDG_CACHE_HOME || "").trim() || path.join(rootPath, ".cache");
    ensureDir(cacheDir);
    const buildEnv = {
        ...process.env,
        XDG_CACHE_HOME: cacheDir
    };

    if (fs.existsSync(outFile) && !force) {
        console.error(`Output already exists at ${outFile}. Use --force to overwrite.`);
        process.exit(3);
    }

    console.log(`Building wasm from ${grammarPath}...`);
    ensureDir(outDir);
    runBuild(grammarPath, outFile, buildEnv);

    if (!fs.existsSync(outFile)) {
        const builtWasm = findWasmFile(grammarPath);
        if (!builtWasm) {
            console.error(`Failed to locate ${WASM_NAME} under ${grammarPath}.`);
            process.exit(4);
        }
        fs.copyFileSync(builtWasm, outFile);
    }

    console.log(`Wrote ${WASM_NAME} to ${outFile}`);
    console.log(`You can also set SMART_CONTEXT_WASM_DIR=${outDir} if needed.`);
}

main();
