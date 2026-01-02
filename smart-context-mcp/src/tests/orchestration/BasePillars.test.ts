import { describe, it, expect } from "@jest/globals";
import { ReadPillar, WritePillar } from "../../orchestration/pillars/BasePillars.js";
import { OrchestrationContext } from "../../orchestration/OrchestrationContext.js";
import { InternalToolRegistry } from "../../orchestration/InternalToolRegistry.js";

const buildIntent = (overrides: Partial<any> = {}) => ({
  category: "read",
  action: "execute",
  targets: ["src/demo.ts"],
  originalIntent: "read demo",
  constraints: {},
  confidence: 1,
  ...overrides
});

describe("BasePillars Read", () => {
  it("avoids extra reads when view=full and hash not requested", async () => {
    const registry = new InternalToolRegistry();
    const calls: Array<{ tool: string; view?: string }> = [];

    registry.register("read_code", async (args: any) => {
      calls.push({ tool: "read_code", view: args.view });
      return "full content" as any;
    });
    registry.register("file_profiler", async () => ({
      metadata: { filePath: "src/demo.ts", lineCount: 1, language: "ts" },
      structure: { symbols: [] }
    } as any));

    const pillar = new ReadPillar(registry);
    const result = await pillar.execute(buildIntent({
      constraints: { view: "full", includeProfile: false, includeHash: false }
    }) as any, new OrchestrationContext());

    expect(result.content).toBe("full content");
    expect(calls).toEqual([{ tool: "read_code", view: "full" }]);
  });

  it("loads full content when hash requested in skeleton mode", async () => {
    const registry = new InternalToolRegistry();
    const calls: Array<{ tool: string; view?: string }> = [];

    registry.register("read_code", async (args: any) => {
      calls.push({ tool: "read_code", view: args.view });
      return args.view === "full" ? "full content" : "skeleton";
    });
    registry.register("file_profiler", async () => ({
      metadata: { filePath: "src/demo.ts", lineCount: 2, language: "ts" },
      structure: { symbols: [] }
    } as any));

    const pillar = new ReadPillar(registry);
    const result = await pillar.execute(buildIntent({
      constraints: { view: "skeleton", includeProfile: false, includeHash: true }
    }) as any, new OrchestrationContext());

    expect(result.content).toBe("skeleton");
    expect(calls).toEqual([
      { tool: "read_code", view: "skeleton" },
      { tool: "read_code", view: "full" }
    ]);
  });

  it("uses doc_section preview mode for document section reads by default", async () => {
    const registry = new InternalToolRegistry();
    const calls: Array<{ tool: string; args: any }> = [];

    const originalMax = process.env.SMART_CONTEXT_DOC_SECTION_MAX_CHARS;
    process.env.SMART_CONTEXT_DOC_SECTION_MAX_CHARS = "1234";

    registry.register("doc_section", async (args: any) => {
      calls.push({ tool: "doc_section", args });
      return { success: true, content: "preview", section: { id: "s1" } } as any;
    });
    registry.register("file_profiler", async () => ({
      metadata: { filePath: "docs/guide.md", lineCount: 10, language: "md" },
      structure: { symbols: [] }
    } as any));

    const pillar = new ReadPillar(registry);
    const result = await pillar.execute(buildIntent({
      targets: ["docs/guide.md"],
      constraints: { view: "skeleton", headingPath: ["Guide", "Install"] }
    }) as any, new OrchestrationContext());

    expect(result.content).toBe("preview");
    expect(calls.length).toBe(1);
    expect(calls[0].tool).toBe("doc_section");
    expect(calls[0].args.mode).toBe("preview");
    expect(calls[0].args.maxChars).toBe(1234);

    if (originalMax === undefined) delete process.env.SMART_CONTEXT_DOC_SECTION_MAX_CHARS;
    else process.env.SMART_CONTEXT_DOC_SECTION_MAX_CHARS = originalMax;
  });
});

describe("BasePillars Write", () => {
  it("creates empty file when target missing and content empty", async () => {
    const registry = new InternalToolRegistry();
    const calls: Array<{ tool: string }> = [];

    registry.register("read_code", async () => { throw new Error("missing"); });
    registry.register("write_file", async () => { calls.push({ tool: "write_file" }); return {}; });

    const pillar = new WritePillar(registry);
    const result = await pillar.execute({
      category: "write",
      action: "execute",
      targets: ["src/new.ts"],
      originalIntent: "create file",
      constraints: { targetPath: "src/new.ts", content: "" },
      confidence: 1
    } as any, new OrchestrationContext());

    expect(result.success).toBe(true);
    expect(calls).toEqual([{ tool: "write_file" }]);
  });
});
