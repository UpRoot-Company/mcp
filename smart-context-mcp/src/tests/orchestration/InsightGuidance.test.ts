import { describe, it, expect } from "@jest/globals";
import { InsightSynthesizer } from "../../orchestration/InsightSynthesizer.js";
import { GuidanceGenerator } from "../../orchestration/GuidanceGenerator.js";

describe("InsightSynthesizer", () => {
  it("builds summaries from call graph, hotspots, and impact previews", () => {
    const synthesizer = new InsightSynthesizer();
    const result = synthesizer.synthesize({
      skeletons: [{ symbols: [] }],
      calls: {
        edges: [
          { source: "A", target: "B" },
          { source: "B", target: "C" },
          { source: "C", target: "A" }
        ]
      },
      dependencies: { edges: [] },
      hotSpots: [{ filePath: "src/demo.ts" }, { filePath: "src/demo.ts" }],
      impactPreviews: [{ riskLevel: "high", summary: { impactedFiles: ["src/demo.ts"] } }]
    });

    expect(result.pageRankSummary?.coverage).toBeGreaterThan(0);
    expect(result.hotSpotSummary?.count).toBe(2);
    expect(result.impactSummary?.riskCounts.high).toBe(1);
  });
});

describe("GuidanceGenerator", () => {
  it("emits high risk warnings and hotspot warnings", () => {
    const generator = new GuidanceGenerator();
    const guidance = generator.generate({
      lastPillar: "change",
      lastResult: { operation: "plan" },
      insights: [
        {
          type: "risk",
          severity: "high",
          observation: "Impact analysis indicates high risk.",
          implication: "",
          actionSuggestion: "",
          affectedFiles: ["src/demo.ts"],
          confidence: 0.8
        }
      ],
      synthesis: {
        hotSpots: [{ filePath: "src/demo.ts" }],
        pageRankCoverage: 1,
        impactIncluded: true
      }
    });

    const warningCodes = guidance.warnings.map((w) => w.code);
    expect(warningCodes).toEqual(expect.arrayContaining(["HIGH_RISK", "HOTSPOT_AFFECTED"]));
  });
});
