import { describe, it, expect } from "@jest/globals";
import { OrchestrationEngine } from "../../orchestration/OrchestrationEngine.js";
import { InternalToolRegistry } from "../../orchestration/InternalToolRegistry.js";
import { IntentRouter } from "../../orchestration/IntentRouter.js";
import { WorkflowPlanner } from "../../orchestration/WorkflowPlanner.js";

const buildEngine = (registry: InternalToolRegistry) => {
  return new OrchestrationEngine(new IntentRouter(), new WorkflowPlanner(), registry);
};

describe("OrchestrationEngine", () => {
  it("uses pillar execution for structured args", async () => {
    const registry = new InternalToolRegistry();
    registry.register("read_code", async () => "const demo = 1;" as any);
    registry.register("file_profiler", async (args: any) => ({
      metadata: { filePath: args.filePath, lineCount: 1, language: "ts" },
      structure: { symbols: [] }
    } as any));

    const engine = buildEngine(registry);
    const result = await engine.executePillar("read", {
      target: "src/demo.ts",
      view: "full",
      includeProfile: true,
      includeHash: false
    });

    expect(result.content).toBe("const demo = 1;");
    expect(result.metadata.filePath).toBe("src/demo.ts");
  });

  it("marks plan failures when a step returns success=false", async () => {
    const registry = new InternalToolRegistry();
    registry.register("search_project", async () => ({
      results: [{ path: "src/demo.ts" }]
    } as any));
    registry.register("read_code", async () => "const demo = 1;" as any);
    registry.register("impact_analyzer", async () => ({ riskLevel: "low" } as any));
    registry.register("edit_coordinator", async () => ({
      success: false,
      message: "No match",
      errorCode: "NO_MATCH"
    } as any));

    const engine = buildEngine(registry);
    const result = await engine.executePillar("change", "modify demo");

    expect(result.status).toBe("partial_success");
    expect(result.errors?.[0]?.code).toBe("NO_MATCH");
  });
});
