import { describe, it, expect } from "@jest/globals";
import { InternalToolRegistry } from "../../orchestration/InternalToolRegistry.js";
import { OrchestrationContext } from "../../orchestration/OrchestrationContext.js";
import { ChangePillar } from "../../orchestration/pillars/ChangePillar.js";

describe("ChangePillar integrity blocking", () => {
  it("blocks apply when high severity integrity findings exist", async () => {
    const registry = new InternalToolRegistry();
    const editCalls: any[] = [];

    registry.register("edit_coordinator", async (args: any) => {
      editCalls.push(args);
      return { success: true, diff: "diff", operation: { id: "tx-1" } } as any;
    });

    registry.register("doc_search", async () => ({
      query: "refund",
      results: [],
      evidence: [
        {
          id: "doc-1",
          filePath: "docs/policy.md",
          preview: "Refund within 24 hours.",
          range: { startLine: 1, endLine: 1 }
        }
      ],
      pack: { packId: "pack-1", hit: false, createdAt: Date.now() },
      stats: {
        candidateFiles: 1,
        candidateChunks: 1,
        vectorEnabled: false,
        mmrApplied: false,
        evidenceSections: 1,
        evidenceChars: 24,
        evidenceTruncated: false
      }
    } as any));

    registry.register("read_code", async () => "export const REFUND_WINDOW_HOURS = 48;" as any);

    const pillar = new ChangePillar(registry);
    const result = await pillar.execute(
      {
        category: "change",
        action: "modify",
        targets: ["src/payments/refund.ts"],
        originalIntent: "update refund window",
        constraints: {
          dryRun: false,
          edits: [{ targetString: "a", replacementString: "b" }],
          integrity: { mode: "preflight" }
        },
        confidence: 1
      } as any,
      new OrchestrationContext()
    );

    expect(result.success).toBe(false);
    expect(result.status).toBe("blocked");
    expect(result.integrity?.status).toBe("blocked");
    expect(editCalls.length).toBe(0);
  });
});
