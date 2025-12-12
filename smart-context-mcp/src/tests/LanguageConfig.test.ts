import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { LanguageConfigLoader } from "../config/LanguageConfig.js";

describe("LanguageConfigLoader", () => {
    let tempDir: string;
    let configDir: string;
    let configPath: string;

    beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "smart-context-langcfg-"));
        configDir = path.join(tempDir, ".smart-context");
        fs.mkdirSync(configDir, { recursive: true });
        configPath = path.join(configDir, "languages.json");
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    it("merges user mappings with builtins", () => {
        fs.writeFileSync(
            configPath,
            JSON.stringify({
                version: 1,
                mappings: {
                    ".foo": { languageId: "foo", parserBackend: "web-tree-sitter" }
                }
            })
        );

        const loader = new LanguageConfigLoader(tempDir);
        expect(loader.getLanguageMapping(".foo")?.languageId).toBe("foo");
        expect(loader.getLanguageMapping(".ts")?.languageId).toBe("typescript");
        loader.dispose();
    });

    it("reload picks up on-disk updates", () => {
        fs.writeFileSync(
            configPath,
            JSON.stringify({ version: 1, mappings: {} })
        );
        const loader = new LanguageConfigLoader(tempDir);
        expect(loader.getLanguageMapping(".bar")).toBeUndefined();

        fs.writeFileSync(
            configPath,
            JSON.stringify({
                version: 1,
                mappings: {
                    ".bar": { languageId: "bar", parserBackend: "web-tree-sitter" }
                }
            })
        );
        loader.reload();
        expect(loader.getLanguageMapping(".bar")?.languageId).toBe("bar");
        loader.dispose();
    });

    it("falls back to builtins when user config is invalid", () => {
        fs.writeFileSync(configPath, "{ invalid json");
        const loader = new LanguageConfigLoader(tempDir);
        expect(loader.getLanguageMapping(".ts")?.languageId).toBe("typescript");
        loader.dispose();
    });
});

