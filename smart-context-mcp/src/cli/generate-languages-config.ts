import * as fs from "fs";
import * as path from "path";
import { BUILTIN_LANGUAGE_MAPPINGS } from "../config/LanguageConfig.js";

function usage(): void {
    console.log(`smart-context-mcp languages config generator

Usage:
  smart-context-gen-languages --root <projectRoot> [--force]

Options:
  --root   Project root to write .smart-context/languages.json
  --force  Overwrite existing file
`);
}

function main(): void {
    const args = process.argv.slice(2);
    const rootIndex = args.indexOf("--root");
    if (rootIndex === -1 || rootIndex + 1 >= args.length) {
        usage();
        process.exit(1);
    }

    const rootPath = path.resolve(args[rootIndex + 1]);
    const force = args.includes("--force");
    const configDir = path.join(rootPath, ".smart-context");
    const configPath = path.join(configDir, "languages.json");

    if (!fs.existsSync(configDir)) {
        fs.mkdirSync(configDir, { recursive: true });
    }

    if (fs.existsSync(configPath) && !force) {
        console.error(`languages.json already exists at ${configPath}. Use --force to overwrite.`);
        process.exit(2);
    }

    const payload = {
        version: 1,
        mappings: BUILTIN_LANGUAGE_MAPPINGS
    };

    fs.writeFileSync(configPath, JSON.stringify(payload, null, 2), "utf-8");
    console.log(`Wrote default language mappings to ${configPath}`);
}

main();

