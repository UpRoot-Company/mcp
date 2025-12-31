import { describe, it, expect } from "@jest/globals";
import { DocumentProfiler } from "../../documents/DocumentProfiler.js";

const sample = `---
title: Sample Doc
---
# Intro
## Setup
### Details
## Usage
`;

describe("DocumentProfiler options", () => {
    it("respects maxDepth and frontmatter flag", () => {
        const profiler = new DocumentProfiler(process.cwd());
        const profile = profiler.profile({
            filePath: "docs/sample.md",
            content: sample,
            kind: "markdown",
            options: { maxDepth: 2, includeFrontmatter: false }
        });

        expect(profile.frontmatter).toBeUndefined();
        expect(profile.outline.map(section => section.title)).toEqual(["Intro", "Setup", "Usage"]);
    });
});
