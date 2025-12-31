import { describe, it, expect } from "@jest/globals";
import { extractClaimsFromText } from "../../integrity/ClaimExtractor.js";

describe("ClaimExtractor", () => {
  it("extracts must/should/numeric claims and skips code fences", () => {
    const input = {
      text: [
        "Must use OAuth2 for all auth flows.",
        "Recommended to retry within 3 seconds.",
        "```",
        "const limit = 5;",
        "```",
        "결제 취소는 24시간 이내만 가능하다."
      ].join("\n"),
      filePath: "docs/policy.md",
      sectionTitle: "Policy",
      sourceType: "docs" as const,
      evidenceRef: { packId: "p1", itemId: "c1", filePath: "docs/policy.md" }
    };

    const claims = extractClaimsFromText(input);
    expect(claims).toHaveLength(3);
    expect(claims.map(c => c.strength)).toEqual(["must", "should", "must"]);
  });
});
