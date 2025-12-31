import { describe, it, expect } from "@jest/globals";
import { detectDocConflicts } from "../../integrity/ConflictDetector.js";

describe("ConflictDetector", () => {
  it("detects conflicting numeric constraints across docs", () => {
    const findings = detectDocConflicts([
      {
        id: "c1",
        sourceType: "docs",
        filePath: "docs/policy.md",
        text: "Refund within 24 hours.",
        strength: "must",
        evidenceRef: { packId: "p1", itemId: "a1", filePath: "docs/policy.md" }
      },
      {
        id: "c2",
        sourceType: "docs",
        filePath: "docs/faq.md",
        text: "Refund within 48 hours.",
        strength: "must",
        evidenceRef: { packId: "p1", itemId: "a2", filePath: "docs/faq.md" }
      }
    ]);

    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].kind).toBe("doc_vs_doc");
  });
});
