import { describe, it, expect } from "@jest/globals";
import { AutoCorrectionStrategy } from "../../orchestration/AutoCorrectionStrategy.js";
import { OrchestrationContext } from "../../orchestration/OrchestrationContext.js";
import { InternalToolRegistry } from "../../orchestration/InternalToolRegistry.js";

const buildIntent = (overrides: Partial<any> = {}) => ({
  category: "change",
  action: "modify",
  targets: [],
  originalIntent: "update demo",
  constraints: { edits: [{ filePath: "src/demo.ts", targetString: "a", replacementString: "b" }] },
  confidence: 1,
  ...overrides
});

describe("AutoCorrectionStrategy", () => {
  it("returns false for non-change intents", async () => {
    const strategy = new AutoCorrectionStrategy();
    const context = new OrchestrationContext();
    const registry = new InternalToolRegistry();

    const result = await strategy.attempt({ ...buildIntent(), category: "read" } as any, context, registry);
    expect(result).toBe(false);
  });

  it("attempts corrective edits and succeeds", async () => {
    const strategy = new AutoCorrectionStrategy();
    const context = new OrchestrationContext();
    context.addError({ code: "NO_MATCH", message: "No match", tool: "edit_coordinator" });

    const registry = new InternalToolRegistry();
    let callCount = 0;
    registry.register("edit_coordinator", async () => {
      callCount += 1;
      return callCount === 1
        ? { success: false, message: "No match", errorCode: "NO_MATCH" }
        : { success: true };
    });

    const result = await strategy.attempt(buildIntent() as any, context, registry);
    expect(result).toBe(true);

    const steps = context.getFullHistory().filter(step => step.tool === "edit_coordinator");
    expect(steps.length).toBeGreaterThan(0);
  });
});
