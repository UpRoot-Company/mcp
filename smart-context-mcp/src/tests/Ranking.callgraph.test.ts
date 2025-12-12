import { describe, it, expect } from "@jest/globals";
import { BM25FRanking } from "../engine/Ranking.js";
import { Document } from "../types.js";
import { CallGraphSignals } from "../engine/CallGraphMetricsBuilder.js";

describe("BM25FRanking call graph boosts", () => {
    it("prefers entry point symbols when content scores tie", () => {
        const ranking = new BM25FRanking();
        const docs: Document[] = [
            {
                id: "a.ts:1",
                text: "foo bar",
                score: 0,
                filePath: "a.ts",
                fieldType: "symbol-definition",
                symbolId: "a.ts::foo"
            },
            {
                id: "b.ts:1",
                text: "foo bar",
                score: 0,
                filePath: "b.ts",
                fieldType: "symbol-definition",
                symbolId: "b.ts::foo"
            }
        ];

        const signals = new Map<string, CallGraphSignals>([
            [
                "a.ts::foo",
                { symbolId: "a.ts::foo", depth: 0, inDegree: 10, outDegree: 5, isEntryPoint: true }
            ],
            [
                "b.ts::foo",
                { symbolId: "b.ts::foo", depth: 3, inDegree: 0, outDegree: 1, isEntryPoint: false }
            ]
        ]);

        const ranked = ranking.rank(docs, "foo", signals);
        expect(ranked[0].filePath).toBe("a.ts");
        expect(ranked[0].scoreDetails?.callGraphBoost).toBeGreaterThan(1);
    });
});

