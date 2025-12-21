import { describe, it, expect } from "@jest/globals";
import { ManagePillar } from "../../orchestration/pillars/ManagePillar.js";
import { NavigatePillar } from "../../orchestration/pillars/NavigatePillar.js";
import { OrchestrationContext } from "../../orchestration/OrchestrationContext.js";
import { InternalToolRegistry } from "../../orchestration/InternalToolRegistry.js";

const baseIntent = {
  category: "manage",
  action: "status",
  targets: [],
  originalIntent: "status",
  constraints: {},
  confidence: 1
};

describe("ManagePillar", () => {
  it("routes status and history commands", async () => {
    const registry = new InternalToolRegistry();
    registry.register("manage_project", async (args: any) => ({
      ok: true,
      command: args.command,
      target: args.target
    } as any));

    const pillar = new ManagePillar(registry);
    const status = await pillar.execute({ ...baseIntent, action: "status" } as any, new OrchestrationContext());
    const history = await pillar.execute({ ...baseIntent, action: "history" } as any, new OrchestrationContext());

    expect(status.command).toBe("status");
    expect(history.command).toBe("history");
  });
});

describe("NavigatePillar", () => {
  it("returns smartProfile for single result", async () => {
    const registry = new InternalToolRegistry();
    registry.register("search_project", async () => ({
      results: [{ path: "src/demo.ts", context: "preview" }]
    } as any));
    registry.register("file_profiler", async () => ({
      metadata: { filePath: "src/demo.ts" },
      structure: { symbols: [] }
    } as any));

    const pillar = new NavigatePillar(registry);
    const result = await pillar.execute({
      category: "navigate",
      action: "find",
      targets: ["demo"],
      originalIntent: "find demo",
      constraints: {},
      confidence: 1
    } as any, new OrchestrationContext());

    expect(result.smartProfile).toBeDefined();
    expect(result.codePreview).toBe("preview");
  });
});
