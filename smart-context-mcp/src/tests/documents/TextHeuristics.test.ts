import { describe, it, expect } from "@jest/globals";
import { inferTextHeadings } from "../../documents/text/TextHeuristics.js";

describe("TextHeuristics", () => {
    it("infers headings from underline, numbering, and all-caps", () => {
        const content = [
            "PROJECT OVERVIEW",
            "",
            "Getting Started",
            "===============",
            "",
            "1. Install",
            "Run npm install",
            "",
            "2) Usage",
            "Run npm start",
            ""
        ].join("\n");

        const headings = inferTextHeadings(content);
        expect(headings).toEqual([
            { title: "PROJECT OVERVIEW", level: 2, line: 1 },
            { title: "Getting Started", level: 1, line: 3 },
            { title: "Install", level: 2, line: 6 },
            { title: "Usage", level: 2, line: 9 }
        ]);
    });
});

