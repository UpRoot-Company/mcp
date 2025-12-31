export type IntegrityScope = "docs" | "project" | "auto";
export type IntegrityMode = "off" | "warn" | "preflight" | "strict";
export type IntegrityBlockPolicy = "high_only" | "off";

export type IntegritySourceType =
  | "adr"
  | "docs"
  | "readme"
  | "comment"
  | "code"
  | "logs"
  | "metrics";

export interface IntegrityLimits {
  maxFindings?: number;
  maxChars?: number;
  timeoutMs?: number;
  minConfidence?: number;
  minFindingsForAutoExpand?: number;
  minClaimsForAutoExpand?: number;
}

export interface IntegrityOptions {
  mode?: IntegrityMode;
  scope?: IntegrityScope;
  sources?: IntegritySourceType[];
  extraSources?: Array<"logs" | "metrics">;
  blockPolicy?: IntegrityBlockPolicy;
  limits?: IntegrityLimits;
}

export interface EvidenceRef {
  packId: string;
  itemId: string;
  filePath: string;
  range?: { startLine?: number; endLine?: number };
}

export interface IntegrityClaim {
  id: string;
  sourceType: IntegritySourceType;
  filePath: string;
  sectionTitle?: string;
  text: string;
  strength: "must" | "should" | "info";
  tags?: string[];
  evidenceRef: EvidenceRef;
}

export interface IntegrityFinding {
  id: string;
  kind:
    | "adr_vs_code"
    | "doc_vs_doc"
    | "doc_vs_code"
    | "comment_vs_code"
    | "missing_in_code"
    | "missing_in_docs";
  severity: "info" | "warn" | "high";
  confidence: number;
  claimA: string;
  claimB?: string;
  tags?: string[];
  evidenceRefs: EvidenceRef[];
  priority?: number;
}

export interface IntegrityReport {
  status: "ok" | "degraded" | "blocked";
  scopeUsed: IntegrityScope;
  scopeExpansion?: {
    requested: IntegrityScope;
    used: IntegrityScope;
    expanded: boolean;
    reason?: string;
  };
  healthScore: number;
  summary: {
    totalFindings: number;
    bySeverity: { info: number; warn: number; high: number };
    topDomains?: string[];
  };
  topFindings: IntegrityFinding[];
  packId?: string;
  cursor?: { evidence?: string };
  degradedReason?: string;
  blockedReason?: string;
}

export interface IntegrityRequest {
  query?: string;
  targetPaths?: string[];
  scope: IntegrityScope;
  sources: IntegritySourceType[];
  limits: IntegrityLimits;
  mode: IntegrityMode;
}

export interface IntegrityResult {
  report: IntegrityReport;
  stats?: {
    claimsDocs: number;
    claimsCode: number;
    avgConfidence: number;
    evidenceCoverage: number;
  };
}
