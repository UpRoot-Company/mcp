import * as path from "path";
import { MemoryFileSystem } from "../platform/FileSystem.js";
import { SearchEngine, SymbolMetadataProvider } from "../engine/Search.js";
import { SymbolInfo } from "../types.js";

const joinLines = (lines: string[]): string => lines.join("\n");

describe("SearchEngine trigram index integration", () => {
    const rootPath = path.join(process.cwd(), "__search_workspace__");
    const alphaPath = path.join(rootPath, "src", "utils", "alpha.ts");
    const betaPath = path.join(rootPath, "src", "utils", "beta.ts");

    let fileSystem: MemoryFileSystem;
    let searchEngine: SearchEngine;

    beforeEach(async () => {
        fileSystem = new MemoryFileSystem(rootPath);
        await fileSystem.createDir(path.dirname(alphaPath));
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
