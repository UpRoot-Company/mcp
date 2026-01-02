import { describe, it, expect } from "@jest/globals";
import { extractHtmlHeadings, extractHtmlReferences, extractHtmlTextPreserveLines } from "../../documents/html/HtmlTextExtractor.js";

describe("HtmlTextExtractor", () => {
    it("extracts visible text while preserving line count", () => {
        const html = [
            "<html>",
            "<head><title>Doc</title><style>.a{color:red}</style></head>",
            "<body>",
            "<h1>Title</h1>",
            "<p>Hello <b>world</b> &amp; others</p>",
            "<script>console.log('x')</script>",
            "</body>",
            "</html>",
            ""
        ].join("\n");

        const text = extractHtmlTextPreserveLines(html);
        expect(text.split(/\r?\n/)).toHaveLength(html.split(/\r?\n/).length);
        expect(text).toContain("Title");
        expect(text).toContain("Hello world & others");
        expect(text).not.toContain("<h1>");
        expect(text).not.toContain("console.log");
        expect(text).not.toContain(".a{color:red}");
    });

    it("extracts headings and references with approximate line numbers", () => {
        const html = [
            "<html>",
            "<body>",
            "<h2>Install</h2>",
            "<a href=\"/docs\">Docs</a>",
            "<img src=\"/img/logo.png\" />",
            "</body>",
            "</html>",
            ""
        ].join("\n");

        const headings = extractHtmlHeadings(html);
        expect(headings).toEqual([{ title: "Install", level: 2, line: 3 }]);

        const refs = extractHtmlReferences(html).map(r => ({ href: r.href, line: r.line }));
        expect(refs).toEqual([
            { href: "/docs", line: 4 },
            { href: "/img/logo.png", line: 5 }
        ]);
    });
});

