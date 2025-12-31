import { describe, it, expect } from "@jest/globals";
import { buildDeterministicPreview, buildDeterministicSummary } from "../../documents/summary/DeterministicSummarizer.js";

describe("DeterministicSummarizer", () => {
    it("prefers lines matching query tokens and keeps output under maxChars", () => {
        const text = [
            "# Guide",
            "",
            "This section explains how to set up the project.",
            "- Install: run npm install",
            "- Usage: run npm start",
            "Unrelated long long long long long long long long long long long long long long long.",
            ""
        ].join("\n");

        const { preview } = buildDeterministicPreview({
            text,
            query: "install",
            kind: "markdown",
            maxChars: 80
        });

        expect(preview.length).toBeLessThanOrEqual(80);
        expect(preview.toLowerCase()).toContain("install");
    });

    it("handles code_comment kind heuristics", () => {
        const text = [
            "Installs the widget.",
            "@param mode offline|online",
            "@returns boolean",
            "misc",
            ""
        ].join("\n");

        const { preview } = buildDeterministicPreview({
            text,
            query: "returns",
            kind: "code_comment",
            maxChars: 120
        });

        expect(preview).toContain("@returns");
    });

    it("builds a shorter summary variant", () => {
        const text = [
            "# Guide",
            "- Install: run npm install",
            "- Usage: run npm start",
            "- Notes: clear cache if it fails",
            ""
        ].join("\n");

        const { summary } = buildDeterministicSummary({
            text,
            query: "install",
            kind: "markdown",
            maxChars: 60
        });

        expect(summary.length).toBeLessThanOrEqual(60);
        expect(summary.toLowerCase()).toContain("install");
    });
});
