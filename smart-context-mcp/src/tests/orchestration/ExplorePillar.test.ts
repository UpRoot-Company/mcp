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
    expect(typeof response.pack?.packId).toBe("string");
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

  it("reuses pack results and paginates via cursor", async () => {
    const registry = new InternalToolRegistry();
    let docCalls = 0;
    let codeCalls = 0;
    registry.register("doc_search", async () => {
      docCalls += 1;
      return {
        results: [
          { filePath: "docs/one.md", preview: "One", scores: { final: 0.9 } },
          { filePath: "docs/two.md", preview: "Two", scores: { final: 0.8 } },
          { filePath: "docs/three.md", preview: "Three", scores: { final: 0.7 } }
        ]
      };
    });
    registry.register("search_project", async () => {
      codeCalls += 1;
      return {
        results: [
          { path: "src/one.ts", context: "One", score: 0.9 },
          { path: "src/two.ts", context: "Two", score: 0.8 },
          { path: "src/three.ts", context: "Three", score: 0.7 }
        ]
      };
    });

    const pillar = new ExplorePillar(registry);
    const first = await pillar.execute(
      makeIntent({ query: "auth", limits: { maxResults: 1 } }) as any,
      new OrchestrationContext()
    );

    expect(first.pack?.packId).toBeTruthy();
    expect(first.data.docs).toHaveLength(1);
    expect(first.data.code).toHaveLength(1);
    expect(first.next?.itemsCursor).toBeTruthy();

    const second = await pillar.execute(
      makeIntent({
        query: "auth",
        packId: first.pack?.packId,
        cursor: { items: first.next?.itemsCursor },
        limits: { maxResults: 1 }
      }) as any,
      new OrchestrationContext()
    );

    expect(docCalls).toBe(1);
    expect(codeCalls).toBe(1);
    expect(second.pack?.hit).toBe(true);
    expect(second.data.docs[0]?.filePath).toBe("docs/two.md");
    expect(second.data.code[0]?.filePath).toBe("src/two.ts");
  });

  it("expands content using contentCursor without re-running searches", async () => {
    const registry = new InternalToolRegistry();
    let docCalls = 0;
    let sectionCalls = 0;
    registry.register("doc_search", async () => {
      docCalls += 1;
      return {
        results: [
          {
            filePath: "docs/guide.md",
            preview: "Guide preview",
            sectionPath: ["Guide"],
            scores: { final: 0.9 }
          }
        ]
      };
    });
    registry.register("search_project", async () => ({ results: [] }));
    registry.register("doc_section", async () => {
      sectionCalls += 1;
      return { content: "Expanded content" };
    });

    const pillar = new ExplorePillar(registry);
    const first = await pillar.execute(
      makeIntent({ query: "guide", limits: { maxResults: 1 } }) as any,
      new OrchestrationContext()
    );

    const second = await pillar.execute(
      makeIntent({
        query: "guide",
        packId: first.pack?.packId,
        cursor: { content: JSON.stringify({ docs: 0, code: 0 }) },
        limits: { maxResults: 1 }
      }) as any,
      new OrchestrationContext()
    );

    expect(docCalls).toBe(1);
    expect(sectionCalls).toBe(1);
    expect(second.data.docs[0]?.content).toContain("Expanded content");
  });
});
