import { describe, it, expect } from "@jest/globals";
import { EagerLoadingStrategy } from "../../orchestration/EagerLoadingStrategy.js";
import { OrchestrationContext } from "../../orchestration/OrchestrationContext.js";
import { InternalToolRegistry } from "../../orchestration/InternalToolRegistry.js";

const makeContextWithSearch = () => {
  const context = new OrchestrationContext();
  context.addStep({
    id: "search",
    tool: "search_project",
    args: { query: "demo" },
    output: { results: [{ path: "src/demo.ts" }] },
    status: "success",
    duration: 1
  });
  return context;
};

describe("EagerLoadingStrategy", () => {
  it("loads hotspots, dependencies, and calls for understand", async () => {
    const registry = new InternalToolRegistry();
    const calls: string[] = [];
    registry.register("hotspot_detector", async () => {
      calls.push("hotspot_detector");
      return [] as any;
    });
    registry.register("analyze_relationship", async (args: any) => {
      calls.push(`analyze_relationship:${args.mode}`);
      return { nodes: [], edges: [] } as any;
    });

    const strategy = new EagerLoadingStrategy();
    const context = makeContextWithSearch();

    await strategy.execute({
      category: "understand",
      action: "analyze",
      targets: ["src/demo.ts"],
      originalIntent: "understand demo",
      constraints: { depth: "deep", include: { callGraph: true, dependencies: true } },
      confidence: 1
    } as any, context, registry);

    expect(calls).toEqual(expect.arrayContaining([
      "hotspot_detector",
      "analyze_relationship:dependencies",
      "analyze_relationship:calls"
    ]));
  });

  it("skips hotspot detector when include.hotSpots is false", async () => {
    const registry = new InternalToolRegistry();
    const calls: string[] = [];
    registry.register("hotspot_detector", async () => {
      calls.push("hotspot_detector");
      return [] as any;
    });
    registry.register("analyze_relationship", async (args: any) => {
      calls.push(`analyze_relationship:${args.mode}`);
      return { nodes: [], edges: [] } as any;
    });

    const strategy = new EagerLoadingStrategy();
    const context = makeContextWithSearch();

    await strategy.execute({
      category: "understand",
      action: "analyze",
      targets: ["src/demo.ts"],
      originalIntent: "understand demo",
      constraints: { depth: "shallow", include: { hotSpots: false, callGraph: false, dependencies: false } },
      confidence: 1
    } as any, context, registry);

    expect(calls).toHaveLength(0);
  });

  it("loads profile for navigate", async () => {
    const registry = new InternalToolRegistry();
    const calls: string[] = [];
    registry.register("file_profiler", async () => {
      calls.push("file_profiler");
      return { metadata: {} } as any;
    });

    const strategy = new EagerLoadingStrategy();
    const context = makeContextWithSearch();

    await strategy.execute({
      category: "navigate",
      action: "find",
      targets: ["src/demo.ts"],
      originalIntent: "find demo",
      constraints: {},
      confidence: 1
    } as any, context, registry);

    expect(calls).toEqual(["file_profiler"]);
  });
});
