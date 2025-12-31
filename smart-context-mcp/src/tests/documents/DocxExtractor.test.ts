import { describe, it, expect } from "@jest/globals";
import { postProcessDocxHtml } from "../../documents/extractors/DocxExtractor.js";

describe("DocxExtractor", () => {
    it("replaces embedded images with text placeholders", () => {
        const html = [
            "<p>Intro</p>",
            "<img src=\"data:image/png;base64,AAA\" alt=\"Architecture Diagram\">",
            "<p>More</p>",
            "<img src=\"data:image/png;base64,BBB\">"
        ].join("");

        const result = postProcessDocxHtml(html);
        expect(result.html).toContain("[image: Architecture Diagram]");
        expect(result.html).toContain("[image]");
        expect(result.warnings).toContain("docx_embedded_images_ignored");
    });
});
