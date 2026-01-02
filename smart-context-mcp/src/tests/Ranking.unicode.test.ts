import { BM25FRanking } from "../engine/Ranking.js";

describe("BM25FRanking unicode tokenization", () => {
    it("scores non-ascii tokens", () => {
        const ranking = new BM25FRanking();
        const docs = [
            {
                id: "a",
                text: "\uD14C\uC2A4\uD2B8 \uBB38\uC7A5",
                score: 0,
                filePath: "a.txt"
            },
            {
                id: "b",
                text: "other text",
                score: 0,
                filePath: "b.txt"
            }
        ];

        const results = ranking.rank(docs, "\uD14C\uC2A4\uD2B8");
        expect(results[0].id).toBe("a");
        expect(results[0].score ?? 0).toBeGreaterThan(0);
    });
});
