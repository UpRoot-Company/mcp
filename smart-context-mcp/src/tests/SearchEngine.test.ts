import * as path from "path";
import { performance } from "perf_hooks";
import { MemoryFileSystem } from "../platform/FileSystem.js";
import { SearchEngine, SymbolMetadataProvider } from "../engine/Search.js";
import { SymbolInfo } from "../types.js";

const joinLines = (lines: string[]): string => lines.join("\n");

describe("SearchEngine trigram index integration", () => {
    const rootPath = path.join(process.cwd(), "__search_workspace__");
    const alphaPath = path.join(rootPath, "src", "utils", "alpha.ts");
    const betaPath = path.join(rootPath, "src", "utils", "beta.ts");
    const camelPath = path.join(rootPath, "src", "models", "UserAccount.ts");

    let fileSystem: MemoryFileSystem;
    let searchEngine: SearchEngine;

    beforeEach(async () => {
        fileSystem = new MemoryFileSystem(rootPath);
        await fileSystem.createDir(path.dirname(alphaPath));
        await fileSystem.createDir(path.dirname(camelPath));
        await fileSystem.writeFile(alphaPath, joinLines([
            "export function alphaFunction() {",
            "  const message = 'alpha matches here';",
            "  return message;",
            "}",
        ]));
        await fileSystem.writeFile(betaPath, joinLines([
            "export const betaValue = () => {",
            "  return 42;",
            "};",
        ]));
        await fileSystem.writeFile(camelPath, joinLines([
            "export class UpdateUserPermission {",
            "  private userToken: string;",
            "  syncUserPermission() {",
            "    return this.userToken;",
            "  }",
            "}",
        ]));

        searchEngine = new SearchEngine(rootPath, fileSystem, []);
        await searchEngine.warmup();
    });

    it("returns file matches for keyword queries", async () => {
        const results = await searchEngine.scout({ keywords: ["alpha"], basePath: rootPath });
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].filePath).toBe("src/utils/alpha.ts");
        expect(results[0].lineNumber).toBeGreaterThan(0);
    });

    it("updates the trigram index when files change", async () => {
        let results = await searchEngine.scout({ keywords: ["gamma"], basePath: rootPath });
        expect(results).toHaveLength(0);

        await fileSystem.writeFile(betaPath, joinLines([
            "export const betaValue = () => {",
            "  const gammaRay = 100;",
            "  return gammaRay;",
            "};",
        ]));
        await searchEngine.invalidateFile(betaPath);

        results = await searchEngine.scout({ keywords: ["gamma"], basePath: rootPath });
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].filePath).toBe("src/utils/beta.ts");
    });

    it("supports regex lookups via runFileGrep", async () => {
        const lineNumbers = await searchEngine.runFileGrep("message\\s=", alphaPath);
        expect(lineNumbers).toContain(2);
    });

    it("matches CamelCase identifiers with smart-case defaults", async () => {
        const insensitive = await searchEngine.scout({ keywords: ["userpermission"], basePath: rootPath });
        const camelMatch = insensitive.find(result => result.filePath === "src/models/UserAccount.ts");
        expect(camelMatch).toBeDefined();

        const strict = await searchEngine.scout({ keywords: ["userpermission"], basePath: rootPath, caseSensitive: true });
        const strictMatch = strict.find(result => result.filePath === "src/models/UserAccount.ts");
        expect(strictMatch).toBeUndefined();

        const forced = await searchEngine.scout({ keywords: ["USERPERMISSION"], basePath: rootPath, smartCase: false });
        const forcedMatch = forced.find(result => result.filePath === "src/models/UserAccount.ts");
        expect(forcedMatch).toBeDefined();
    });

    it("locates needles inside large haystacks within budget", async () => {
        const fillerDir = path.join(rootPath, "packages");
        const fillerCount = 250;
        for (let index = 0; index < fillerCount; index++) {
            const fillerPath = path.join(fillerDir, `module-${index}.ts`);
            await fileSystem.createDir(path.dirname(fillerPath));
            await fileSystem.writeFile(fillerPath, joinLines([
                `export function filler${index}() {`,
                `  const token${index} = ${index};`,
                "  return token${index};",
                "}",
            ]));
        }

        const targetPath = path.join(rootPath, "src", "core", "needle.ts");
        await fileSystem.createDir(path.dirname(targetPath));
        await fileSystem.writeFile(targetPath, joinLines([
            "export function locateNeedle() {",
            "  const UniqueNeedleToken = 'needlePayload';",
            "  return UniqueNeedleToken;",
            "}",
        ]));

        const denseEngine = new SearchEngine(rootPath, fileSystem, []);
        await denseEngine.warmup();

        const start = performance.now();
        const results = await denseEngine.scout({ keywords: ["UniqueNeedleToken"], basePath: rootPath });
        const duration = performance.now() - start;

        expect(results.length).toBeGreaterThan(0);
        expect(results[0]?.filePath).toBe("src/core/needle.ts");
        expect(results[0]?.preview).toContain("UniqueNeedleToken");
        expect(duration).toBeLessThan(750);
    });

    it("prioritizes exported definitions via field weights", async () => {
        const stubProvider: SymbolMetadataProvider = {
            async getSymbolsForFile(filePath: string): Promise<SymbolInfo[]> {
                if (path.normalize(filePath) !== path.normalize(alphaPath)) {
                    return [];
                }
                return [{
                    name: "alphaMark",
                    type: "function",
                    range: { startLine: 0, endLine: 4, startByte: 0, endByte: 80 },
                    modifiers: ["export"],
                    content: "export function alphaMark() {}"
                } as SymbolInfo];
            }
        };

        await fileSystem.writeFile(alphaPath, joinLines([
            "export function alphaMark() {",
            "  return alphaMark;",
            "}",
            "// alphaMark documentation"
        ]));

        searchEngine = new SearchEngine(rootPath, fileSystem, [], { symbolMetadataProvider: stubProvider });
        await searchEngine.warmup();

        const results = await searchEngine.scout({ keywords: ["alphaMark"], basePath: rootPath });
        expect(results.length).toBeGreaterThanOrEqual(3);
        expect(results[0].lineNumber).toBe(1);
        expect(results[1].lineNumber).toBe(2);
        const commentMatch = results.find(result => result.lineNumber === 4);
        expect(commentMatch).toBeDefined();
        expect(results[0].score!).toBeGreaterThan(results[1].score!);
        expect(results[1].score!).toBeGreaterThan(commentMatch!.score!);
        expect(results[0].scoreDetails?.fieldType).toBe("symbol-definition");
        expect(commentMatch!.scoreDetails?.fieldType).toBe("comment");
    });
});
