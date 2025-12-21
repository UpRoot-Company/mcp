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
