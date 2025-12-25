import { describe, it, expect } from "@jest/globals";
import { UnderstandPillar } from "../../orchestration/pillars/UnderstandPillar.js";
import { OrchestrationContext } from "../../orchestration/OrchestrationContext.js";
import { InternalToolRegistry } from "../../orchestration/InternalToolRegistry.js";

describe("UnderstandPillar budget behavior", () => {
  it("skips heavy analysis when query is weak and marks degraded", async () => {
    const registry = new InternalToolRegistry();
    let hotspotCalls = 0;
    registry.register("project_stats", async () => ({ fileCount: 8000 } as any));
    registry.register("search_project", async () => ({
      results: [{ path: "src/demo.ts" }]
    } as any));
    registry.register("read_code", async () => "SKELETON" as any);
    registry.register("file_profiler", async () => ({
      metadata: { filePath: "src/demo.ts", lineCount: 1, language: "ts" },
      structure: { symbols: [] }
    } as any));
    registry.register("hotspot_detector", async () => {
      hotspotCalls += 1;
      return [{ filePath: "src/demo.ts" }] as any;
    });

    const pillar = new UnderstandPillar(registry);
    const result = await pillar.execute({
      category: "understand",
      action: "analyze",
      targets: ["x"],
      originalIntent: "analyze x",
      constraints: { include: { hotSpots: true } },
      confidence: 1
    } as any, new OrchestrationContext());

    expect(result.degraded).toBe(true);
    expect(result.status).toBe("partial_success");
    expect(hotspotCalls).toBe(0);
  });
});
