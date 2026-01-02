import { TrigramIndex } from "../../engine/TrigramIndex.js";

describe("TrigramIndex.normalizeQuery", () => {
    it("preserves unicode letters and digits", () => {
        const input = "\uD55C\uAD6D\uC5B4 \uD14C\uC2A4\uD2B8 123!";
        const expected = "\uD55C\uAD6D\uC5B4 \uD14C\uC2A4\uD2B8 123";
        expect(TrigramIndex.normalizeQuery(input)).toBe(expected);
    });

    it("lowercases ascii and strips punctuation", () => {
        expect(TrigramIndex.normalizeQuery("Hello-World!")).toBe("hello world");
    });
});
