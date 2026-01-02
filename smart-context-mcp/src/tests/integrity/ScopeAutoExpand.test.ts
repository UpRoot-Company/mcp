import { describe, it, expect } from "@jest/globals";
import { IntegrityEngine } from "../../integrity/IntegrityEngine.js";

describe("IntegrityEngine scope auto expand", () => {
  it("expands from docs to project when doc evidence is scarce", async () => {
    const calls: any[] = [];
    const runTool = async (tool: string, args: any) => {
      if (tool !== "doc_search") {
        throw new Error(`Unexpected tool: ${tool}`);
      }
      calls.push(args);
      if (args.scope === "docs") {
        return {
          query: args.query,
          results: [],
          evidence: [],
          pack: { packId: "pack-docs", hit: false, createdAt: Date.now() },
          stats: {
            candidateFiles: 0,
            candidateChunks: 0,
            vectorEnabled: false,
            mmrApplied: false,
            evidenceSections: 0,
            evidenceChars: 0,
            evidenceTruncated: false
          }
        } as any;
      }
      return {
        query: args.query,
        results: [],
        evidence: [
          {
            id: "doc-1",
            filePath: "specs/policy.md",
            preview: "Refund within 24 hours.",
            range: { startLine: 1, endLine: 1 }
          }
        ],
        pack: { packId: "pack-project", hit: false, createdAt: Date.now() },
        stats: {
          candidateFiles: 1,
          candidateChunks: 1,
          vectorEnabled: false,
          mmrApplied: false,
          evidenceSections: 1,
          evidenceChars: 24,
          evidenceTruncated: false
        }
      } as any;
    };

    const result = await IntegrityEngine.run(
      {
        query: "refund policy",
        scope: "auto",
        sources: ["docs", "readme"],
        limits: {
          minClaimsForAutoExpand: 1,
          minFindingsForAutoExpand: 1,
          minConfidence: 0.9
        },
        mode: "warn"
      },
      runTool
    );

    expect(calls.map((call) => call.scope)).toEqual(["docs", "project"]);
    expect(result.report.scopeUsed).toBe("project");
    expect(result.report.packId).toBe("pack-project");
    expect(result.report.scopeExpansion?.expanded).toBe(true);
    expect(result.report.scopeExpansion?.reason).toBe("insufficient_claims");
  });
});
