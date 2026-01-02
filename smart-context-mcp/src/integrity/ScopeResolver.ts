import type { IntegrityFinding, IntegrityLimits } from "./IntegrityTypes.js";

export type ScopeExpandReason =
  | "insufficient_claims"
  | "insufficient_findings"
  | "low_confidence"
  | "spec_query";

export interface ScopeDecision {
  expand: boolean;
  reason?: ScopeExpandReason;
}

export interface ScopeDecisionInput {
  query: string;
  docClaimsCount: number;
  findings: IntegrityFinding[];
  limits: IntegrityLimits;
  defaults: {
    minClaims: number;
    minFindings: number;
    minConfidence: number;
  };
}

export function shouldAutoExpandScope(input: ScopeDecisionInput): ScopeDecision {
  const minClaims = input.limits.minClaimsForAutoExpand ?? input.defaults.minClaims;
  const minFindings = input.limits.minFindingsForAutoExpand ?? input.defaults.minFindings;
  const minConfidence = input.limits.minConfidence ?? input.defaults.minConfidence;
  const avgConfidence = averageConfidence(input.findings);

  if (input.docClaimsCount < minClaims) return { expand: true, reason: "insufficient_claims" };
  if (input.findings.length > 0 && input.findings.length < minFindings) {
    return { expand: true, reason: "insufficient_findings" };
  }
  if (input.findings.length > 0 && avgConfidence < minConfidence) {
    return { expand: true, reason: "low_confidence" };
  }
  if (isSpecQuery(input.query)) return { expand: true, reason: "spec_query" };
  return { expand: false };
}

function averageConfidence(findings: Array<{ confidence: number }>): number {
  if (findings.length === 0) return 1;
  const total = findings.reduce((acc, finding) => acc + (finding.confidence ?? 0), 0);
  return total / findings.length;
}

function isSpecQuery(query: string): boolean {
  return /(\badr\b|\bspec\b|\bpolicy\b|\brequirement\b|\bcontract\b|\bcompliance\b|\bstandard\b|\bdesign\b|\b규격\b|\b명세\b|\b정책\b|\b요구사항\b|\b계약\b|\b표준\b|\b설계\b)/i.test(query);
}
