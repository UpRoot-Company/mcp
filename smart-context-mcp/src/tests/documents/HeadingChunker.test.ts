import { describe, it, expect } from "@jest/globals";
import { HeadingChunker } from "../../documents/chunking/HeadingChunker.js";
import { DocumentSection } from "../../types.js";

const content = `# Title
Line one
Line two
Line three
Line four
Line five
Line six
Line seven
Line eight
Line nine
Line ten
`;

const outline: DocumentSection[] = [
    {
        id: "section-1",
        filePath: "docs/sample.md",
        kind: "markdown",
        title: "Title",
        level: 1,
        path: ["Title"],
        range: { startLine: 1, endLine: 11, startByte: 0, endByte: content.length }
    }
];

describe("HeadingChunker", () => {
    it("splits fixed chunks by target size", () => {
        const chunker = new HeadingChunker();
        const chunks = chunker.chunk("docs/sample.md", "markdown", outline, content, {
            chunkStrategy: "fixed",
            targetChunkChars: 40,
            maxBlockChars: 40
        });
        expect(chunks.length).toBeGreaterThan(1);
    });

    it("splits structural chunks by maxBlockChars", () => {
        const chunker = new HeadingChunker();
        const chunks = chunker.chunk("docs/sample.md", "markdown", outline, content, {
            chunkStrategy: "structural",
            maxBlockChars: 50
        });
        expect(chunks.length).toBeGreaterThan(1);
    });
});
