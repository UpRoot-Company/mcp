import { describe, it, expect } from "@jest/globals";
import { extractClaimsFromCode } from "../../integrity/CodeConstraintExtractor.js";

describe("CodeConstraintExtractor", () => {
  it("extracts numeric constants and simple if constraints", () => {
    const content = [
      "export const MAX_RETRY = 5;",
      "if (hours > 24) throw new Error('too late');",
      "const name = 'noop';"
    ].join("\n");
    const claims = extractClaimsFromCode({
      content,
      filePath: "src/payments/refund.ts",
      packId: "p1"
    });
    expect(claims.length).toBeGreaterThanOrEqual(2);
    expect(claims.some(c => c.text.includes("MAX_RETRY"))).toBe(true);
  });
});
