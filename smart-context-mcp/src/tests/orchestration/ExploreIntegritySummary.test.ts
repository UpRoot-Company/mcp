import { describe, it, expect } from "@jest/globals";
import { InternalToolRegistry } from "../../orchestration/InternalToolRegistry.js";
import { OrchestrationContext } from "../../orchestration/OrchestrationContext.js";
import { ExplorePillar } from "../../orchestration/pillars/ExplorePillar.js";

describe("ExplorePillar integrity summary", () => {
  it("attaches integrity report when requested", async () => {
    const registry = new InternalToolRegistry();
    registry.register("search_project", async () => ({ results: [] } as any));
    registry.register("doc_search", async () => ({
      query: "refund policy",
      results: [
        {
          id: "doc-1",
          filePath: "docs/policy.md",
          preview: "Refund within 24 hours.",
          range: { startLine: 1, endLine: 1 },
          scores: { bm25: 1, final: 1 }
        }
      ],
      evidence: [
        {
          id: "doc-1",
          filePath: "docs/policy.md",
          preview: "Refund within 24 hours.",
          range: { startLine: 1, endLine: 1 },
          scores: { bm25: 1, final: 1 }
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

    const pillar = new ExplorePillar(registry);
    const result = await pillar.execute(
      {
        category: "explore",
        action: "search",
        targets: [],
        originalIntent: "refund policy",
        constraints: {
          query: "refund policy",
          integrity: { mode: "warn", scope: "docs", sources: ["docs"] }
        },
        confidence: 1
      } as any,
      new OrchestrationContext()
    );

    expect(result.success).toBe(true);
    expect(result.integrity).toBeTruthy();
    expect(result.integrity?.scopeUsed).toBe("docs");
  });
});
