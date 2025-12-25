import { describe, it, expect } from "@jest/globals";
import { NavigatePillar } from "../../orchestration/pillars/NavigatePillar.js";
import { OrchestrationContext } from "../../orchestration/OrchestrationContext.js";
import { InternalToolRegistry } from "../../orchestration/InternalToolRegistry.js";

describe("NavigatePillar budget behavior", () => {
  it("prefers filename search for weak queries and returns budget metadata", async () => {
    const registry = new InternalToolRegistry();
    const searchCalls: any[] = [];
    registry.register("project_stats", async () => ({ fileCount: 500 } as any));
    registry.register("search_project", async (args: any) => {
      searchCalls.push(args);
      return { results: [{ path: "src/demo.ts", context: "preview", score: 1 }] } as any;
    });
    registry.register("file_profiler", async () => ({
      metadata: { filePath: "src/demo.ts" },
      structure: { symbols: [] }
    } as any));
    registry.register("read_code", async () => "SKELETON" as any);

    const pillar = new NavigatePillar(registry);
    const result = await pillar.execute({
      category: "navigate",
      action: "find",
      targets: ["x"],
      originalIntent: "find x",
      constraints: {},
      confidence: 1
    } as any, new OrchestrationContext());

    expect(searchCalls[0]?.type).toBe("filename");
    expect(result.degraded).toBe(false);
    expect(result.budget).toBeDefined();
  });

  it("escalates to content search for strong queries and preserves degrade signals", async () => {
    const registry = new InternalToolRegistry();
    const searchCalls: any[] = [];
    registry.register("project_stats", async () => ({ fileCount: 5000 } as any));
    registry.register("search_project", async (args: any) => {
      searchCalls.push(args);
      if (args.type === "file") {
        return {
          results: [{ path: "src/alpha.ts", context: "match", score: 0.5 }],
          degraded: true,
          budget: { maxFilesRead: 1, used: { filesRead: 1, bytesRead: 10, parseTimeMs: 1 }, profile: "safe" }
        } as any;
      }
      return { results: [] } as any;
    });
    registry.register("file_profiler", async () => ({
      metadata: { filePath: "src/alpha.ts" },
      structure: { symbols: [] }
    } as any));
    registry.register("read_code", async () => "SKELETON" as any);

    const pillar = new NavigatePillar(registry);
    const result = await pillar.execute({
      category: "navigate",
      action: "find",
      targets: ["UniqueNeedleToken"],
      originalIntent: "find UniqueNeedleToken",
      constraints: {},
      confidence: 1
    } as any, new OrchestrationContext());

    expect(searchCalls.some(call => call.type === "file")).toBe(true);
    expect(result.degraded).toBe(true);
    expect(result.refinement?.reason).toBe("budget_exceeded");
  });
});
