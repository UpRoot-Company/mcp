import { describe, it, expect } from "@jest/globals";
import { InternalToolRegistry } from "../../orchestration/InternalToolRegistry.js";
import { OrchestrationContext } from "../../orchestration/OrchestrationContext.js";
import { ExplorePillar } from "../../orchestration/pillars/ExplorePillar.js";

const makeIntent = (constraints: Record<string, unknown>) => ({
  category: "explore",
  action: "execute",
  targets: [],
  originalIntent: "",
  constraints,
  confidence: 1
});

describe("ExplorePillar", () => {
  it("returns invalid_args when query and paths are missing", async () => {
    const registry = new InternalToolRegistry();
    const pillar = new ExplorePillar(registry);
    const context = new OrchestrationContext();

    const response = await pillar.execute(makeIntent({}) as any, context);

    expect(response.success).toBe(false);
    expect(response.status).toBe("invalid_args");
  });

  it("returns docs + code for query searches", async () => {
    const registry = new InternalToolRegistry();
    registry.register("doc_search", async () => ({
      results: [
        {
          filePath: "docs/guide.md",
          preview: "Guide preview",
          scores: { final: 0.9 },
          range: { startLine: 1, endLine: 3 }
        }
      ],
      pack: { packId: "pack-1", hit: false, createdAt: Date.now() }
    }));
    registry.register("search_project", async () => ({
      results: [
        { path: "src/main.ts", context: "main content", score: 0.8, line: 12, type: "file" }
      ]
    }));

    const pillar = new ExplorePillar(registry);
    const context = new OrchestrationContext();
    const response = await pillar.execute(makeIntent({ query: "install" }) as any, context);

    expect(response.status).toBe("ok");
    expect(response.data.docs).toHaveLength(1);
    expect(response.data.code).toHaveLength(1);
    expect(response.data.docs[0]?.kind).toBe("document_section");
    expect(response.data.code[0]?.kind).toBe("file_preview");
    expect(response.pack?.packId).toBe("pack-1");
  });

  it("reads full content for explicit paths when view=full", async () => {
    const registry = new InternalToolRegistry();
    registry.register("list_files", async () => ([
      { path: "docs/guide.md", mtime: 1, size: 1200 },
      { path: "src/main.ts", mtime: 2, size: 400 }
    ]));
    registry.register("doc_section", async () => ({
      content: "Doc full content",
      section: { range: { startLine: 1, endLine: 5 } }
    }));
    registry.register("read_code", async () => "console.log('ok');");

    const pillar = new ExplorePillar(registry);
    const context = new OrchestrationContext();
    const response = await pillar.execute(makeIntent({ paths: ["docs"], view: "full" }) as any, context);

    expect(response.status).toBe("ok");
    const docItem = response.data.docs.find((item) => item.filePath === "docs/guide.md");
    const codeItem = response.data.code.find((item) => item.filePath === "src/main.ts");
    expect(docItem?.kind).toBe("file_full");
    expect(docItem?.content).toContain("Doc full content");
    expect(codeItem?.kind).toBe("file_full");
    expect(codeItem?.content).toContain("console.log");
  });

  it("filters to code_comment when include.docs=false and include.comments=true", async () => {
    let includeCommentsFlag = false;
    const registry = new InternalToolRegistry();
    registry.register("doc_search", async (args) => {
      includeCommentsFlag = args?.includeComments === true;
      return {
        results: [
          { filePath: "docs/guide.md", preview: "Guide", kind: "markdown", scores: { final: 0.8 } },
          { filePath: "src/main.ts", preview: "Comment", kind: "code_comment", scores: { final: 0.7 } }
        ]
      };
    });
    registry.register("search_project", async () => ({ results: [] }));

    const pillar = new ExplorePillar(registry);
    const context = new OrchestrationContext();
    const response = await pillar.execute(
      makeIntent({ query: "auth", include: { docs: false, comments: true } }) as any,
      context
    );

    expect(includeCommentsFlag).toBe(true);
    expect(response.data.docs).toHaveLength(1);
    expect(response.data.docs[0]?.filePath).toBe("src/main.ts");
    expect(response.data.docs[0]?.metadata).toEqual({ kind: "code_comment" });
  });

  it("blocks full reads for sensitive files unless allowSensitive is true", async () => {
    const registry = new InternalToolRegistry();
    registry.register("list_files", async () => ([
      { path: ".env", mtime: 1, size: 32 }
    ]));

    const pillar = new ExplorePillar(registry);
    const context = new OrchestrationContext();
    const response = await pillar.execute(makeIntent({ paths: ["."], view: "full" }) as any, context);

    expect(response.success).toBe(false);
    expect(response.status).toBe("blocked");
  });

  it("blocks full reads when maxChars is exceeded", async () => {
    const registry = new InternalToolRegistry();
    registry.register("list_files", async () => ([
      { path: "src/main.ts", mtime: 2, size: 100 }
    ]));
    registry.register("read_code", async () => "a".repeat(50));

    const pillar = new ExplorePillar(registry);
    const context = new OrchestrationContext();
    const response = await pillar.execute(
      makeIntent({ paths: ["src"], view: "full", limits: { maxChars: 10 } }) as any,
      context
    );

    expect(response.success).toBe(false);
    expect(response.status).toBe("blocked");
  });

  it("degrades preview results when maxChars budget is exceeded", async () => {
    const registry = new InternalToolRegistry();
    registry.register("list_files", async () => ([
      { path: "src/a.ts", mtime: 3, size: 40 },
      { path: "src/b.ts", mtime: 2, size: 40 }
    ]));
    registry.register("read_code", async () => "x".repeat(20));

    const pillar = new ExplorePillar(registry);
    const context = new OrchestrationContext();
    const response = await pillar.execute(
      makeIntent({ paths: ["src"], view: "preview", limits: { maxChars: 30 } }) as any,
      context
    );

    expect(response.success).toBe(true);
    expect(response.degraded).toBe(true);
    expect(response.reasons).toContain("budget_exceeded");
    expect(response.data.code.length).toBeGreaterThanOrEqual(1);
  });
});
