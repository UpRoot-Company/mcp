import { describe, it, expect } from "@jest/globals";
import { DocumentProfiler } from "../../documents/DocumentProfiler.js";

const content = `
# Title

Inline mention: \`FooService\` and \`src/app.ts\`.

Import mention:
import { FooBar } from "./foo/bar";

JSX mention: <MyWidget /> and {useState}

Plain text mention: See FooClient and config.yaml for details.

\`\`\`ts
// code block should be ignored
const HiddenSymbol = true;
\`\`\`
`;

describe("DocumentProfiler mentions", () => {
    it("extracts mentions from markdown without code blocks", () => {
        const profiler = new DocumentProfiler(process.cwd());
        const profile = profiler.profile({
            filePath: "docs/guide.md",
            content,
            kind: "markdown"
        });

        const mentions = profile.mentions ?? [];
        const texts = new Set(mentions.map(item => item.text));

        expect(texts.has("FooService")).toBe(true);
        expect(texts.has("src/app.ts")).toBe(true);
        expect(texts.has("./foo/bar")).toBe(true);
        expect(texts.has("MyWidget")).toBe(true);
        expect(texts.has("useState")).toBe(true);
        expect(texts.has("FooClient")).toBe(true);
        expect(texts.has("config.yaml")).toBe(true);
        expect(texts.has("HiddenSymbol")).toBe(false);
    });
});
