import crypto from "crypto";
import type {
  IntegrityBlockPolicy,
  IntegrityLimits,
  IntegrityMode,
  IntegrityOptions,
  IntegrityReport,
  IntegrityResult,
  IntegrityScope,
  IntegritySourceType,
  IntegrityRequest,
  IntegrityClaim,
  IntegrityFinding
} from "./IntegrityTypes.js";
import { extractClaimsFromText } from "./ClaimExtractor.js";
import { detectDocConflicts } from "./ConflictDetector.js";

export type IntegrityPillar = "explore" | "understand" | "change";
export type IntegrityToolRunner = (tool: string, args: any) => Promise<any>;

const DEFAULT_SOURCES: IntegritySourceType[] = ["adr", "docs", "readme", "comment", "code"];
const DEFAULT_MAX_FINDINGS = toInt(process.env.SMART_CONTEXT_INTEGRITY_MAX_FINDINGS, 6);
const DEFAULT_MAX_CHARS = toInt(process.env.SMART_CONTEXT_INTEGRITY_MAX_CHARS, 1600);
const DEFAULT_MIN_CONFIDENCE = toFloat(process.env.SMART_CONTEXT_INTEGRITY_MIN_CONFIDENCE, 0.65);
const DEFAULT_TIMEOUT_MS = toInt(process.env.SMART_CONTEXT_INTEGRITY_TIMEOUT_MS, 1500);
const DEFAULT_MIN_FINDINGS = toInt(process.env.SMART_CONTEXT_INTEGRITY_AUTO_MIN_FINDINGS, 2);
const DEFAULT_MIN_CLAIMS = toInt(process.env.SMART_CONTEXT_INTEGRITY_AUTO_MIN_CLAIMS, 4);

const DEFAULT_SCOPE = normalizeScope(process.env.SMART_CONTEXT_INTEGRITY_SCOPE, "auto");
const DEFAULT_BLOCK_POLICY = normalizeBlockPolicy(
  process.env.SMART_CONTEXT_INTEGRITY_BLOCK_POLICY,
  "high_only"
);

export class IntegrityEngine {
  public static resolveOptions(input: unknown, pillar: IntegrityPillar): IntegrityOptions | undefined {
    if (input === undefined || input === null || input === false) return undefined;
    const raw = input === true ? {} : input;
    if (typeof raw !== "object") return undefined;

    const envMode = normalizeMode(process.env.SMART_CONTEXT_INTEGRITY_MODE, undefined);
    const pillarDefault = pillar === "change" ? "preflight" : "warn";
    const mode = normalizeMode((raw as IntegrityOptions).mode, envMode ?? pillarDefault);
    const scope = normalizeScope((raw as IntegrityOptions).scope, DEFAULT_SCOPE);
    const sources = normalizeSources((raw as IntegrityOptions).sources);
    const extraSources = normalizeExtraSources((raw as IntegrityOptions).extraSources);
    const combinedSources = normalizeSources([...sources, ...extraSources]);
    const blockPolicy =
      pillar === "change"
        ? normalizeBlockPolicy((raw as IntegrityOptions).blockPolicy, DEFAULT_BLOCK_POLICY)
        : DEFAULT_BLOCK_POLICY;

    const limits = normalizeLimits((raw as IntegrityOptions).limits);

    return {
      mode,
      scope,
      sources: combinedSources,
      extraSources,
      blockPolicy,
      limits
    };
  }

  public static buildPlaceholderReport(options: IntegrityOptions): IntegrityResult {
    const report: IntegrityReport = {
      status: "degraded",
      scopeUsed: options.scope ?? "auto",
      healthScore: 1,
      summary: {
        totalFindings: 0,
        bySeverity: { info: 0, warn: 0, high: 0 },
        topDomains: []
      },
      topFindings: [],
      degradedReason: "integrity_not_implemented"
    };

    return { report };
  }

  public static async run(
    request: IntegrityRequest,
    runTool: IntegrityToolRunner
  ): Promise<IntegrityResult> {
    const query = String(request.query ?? "").trim();
    if (!query) {
      return {
        report: {
          status: "degraded",
          scopeUsed: "docs",
          healthScore: 1,
          summary: {
            totalFindings: 0,
            bySeverity: { info: 0, warn: 0, high: 0 }
          },
          topFindings: [],
          degradedReason: "missing_query"
        }
      };
    }

    const scopeUsed: IntegrityScope = "docs";
    const sources = Array.isArray(request.sources) && request.sources.length > 0
      ? request.sources
      : DEFAULT_SOURCES;
    const docSources = sources.filter(source => source === "adr" || source === "docs" || source === "readme");
    const unsupported = sources.filter(source => source === "comment" || source === "code" || source === "logs" || source === "metrics");

    let searchResponse: any;
    try {
      searchResponse = await runTool("doc_search", {
        query,
        output: "compact",
        includeEvidence: true,
        maxResults: Math.max(6, request.limits?.maxFindings ?? DEFAULT_MAX_FINDINGS),
        includeComments: false
      });
    } catch (error) {
      return {
        report: {
          status: "degraded",
          scopeUsed: "docs",
          healthScore: 1,
          summary: {
            totalFindings: 0,
            bySeverity: { info: 0, warn: 0, high: 0 }
          },
          topFindings: [],
          degradedReason: "doc_search_failed"
        }
      };
    }

    const packId = searchResponse?.pack?.packId ?? computeIntegrityPackId(query, scopeUsed, docSources, request.targetPaths);
    const sections = filterDocSections(searchResponse?.evidence ?? searchResponse?.results ?? []);
    const claims = extractClaimsFromSections(sections, packId, docSources);
    const findings = detectDocConflicts(claims);
    const degradedReason = buildDegradedReason(searchResponse, unsupported, request.scope)
      ?? (claims.length === 0 ? "no_claims" : undefined);

    const report = buildReport(findings, scopeUsed, {
      degradedReason,
      maxFindings: request.limits?.maxFindings ?? DEFAULT_MAX_FINDINGS
    });

    report.packId = packId;
    if (searchResponse?.degraded && searchResponse?.reason) {
      report.degradedReason = report.degradedReason ?? searchResponse.reason;
    }

    return {
      report
      };
    }
}

function normalizeLimits(limits?: IntegrityLimits): IntegrityLimits {
  return {
    maxFindings: normalizeNumber(limits?.maxFindings, DEFAULT_MAX_FINDINGS),
    maxChars: normalizeNumber(limits?.maxChars, DEFAULT_MAX_CHARS),
    timeoutMs: normalizeNumber(limits?.timeoutMs, DEFAULT_TIMEOUT_MS),
    minConfidence: normalizeNumber(limits?.minConfidence, DEFAULT_MIN_CONFIDENCE),
    minFindingsForAutoExpand: normalizeNumber(limits?.minFindingsForAutoExpand, DEFAULT_MIN_FINDINGS),
    minClaimsForAutoExpand: normalizeNumber(limits?.minClaimsForAutoExpand, DEFAULT_MIN_CLAIMS)
  };
}

function normalizeMode(value: unknown, fallback?: IntegrityMode): IntegrityMode {
  if (value === "off" || value === "warn" || value === "preflight" || value === "strict") return value;
  if (fallback) return fallback;
  return "warn";
}

function normalizeScope(value: unknown, fallback: IntegrityScope): IntegrityScope {
  if (value === "docs" || value === "project" || value === "auto") return value;
  return fallback;
}

function normalizeBlockPolicy(value: unknown, fallback: IntegrityBlockPolicy): IntegrityBlockPolicy {
  if (value === "high_only" || value === "off") return value;
  return fallback;
}

function normalizeSources(sources?: IntegritySourceType[]): IntegritySourceType[] {
  if (!Array.isArray(sources) || sources.length === 0) {
    return DEFAULT_SOURCES;
  }
  const allowed = new Set(DEFAULT_SOURCES.concat(["logs", "metrics"] as IntegritySourceType[]));
  const filtered = sources.filter((source) => allowed.has(source));
  return filtered.length > 0 ? filtered : DEFAULT_SOURCES;
}

function normalizeExtraSources(extraSources?: Array<"logs" | "metrics">): Array<"logs" | "metrics"> {
  if (!Array.isArray(extraSources)) return [];
  return extraSources.filter((source) => source === "logs" || source === "metrics");
}

function normalizeNumber(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return value;
}

function toInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function toFloat(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function filterDocSections(sections: any[]): any[] {
  if (!Array.isArray(sections)) return [];
  return sections.filter(section => {
    const filePath = String(section?.filePath ?? "");
    const normalized = filePath.replace(/\\/g, "/");
    if (!filePath) return false;
    if (isReadmePath(normalized)) return true;
    return normalized.startsWith("docs/") || normalized.includes("/docs/");
  });
}

function extractClaimsFromSections(
  sections: any[],
  packId: string,
  sources: IntegritySourceType[]
): IntegrityClaim[] {
  const claims: IntegrityClaim[] = [];
  for (const section of sections) {
    const filePath = String(section?.filePath ?? "");
    if (!filePath) continue;
    const normalized = filePath.replace(/\\/g, "/");
    const sourceType = classifySourceType(normalized);
    if (!sources.includes(sourceType)) continue;
    const heading = section?.heading ?? section?.sectionPath?.join(" > ");
    const preview = section?.preview ?? "";
    const text = [heading, preview].filter(Boolean).join("\n");
    if (!text) continue;
    const evidenceRef = {
      packId,
      itemId: String(section?.id ?? section?.chunkId ?? `${filePath}:${section?.range?.startLine ?? 0}`),
      filePath,
      range: section?.range ? { startLine: section.range.startLine, endLine: section.range.endLine } : undefined
    };
    claims.push(
      ...extractClaimsFromText({
        text,
        filePath,
        sectionTitle: heading ?? undefined,
        sourceType,
        evidenceRef
      })
    );
  }
  return claims;
}

function classifySourceType(filePath: string): IntegritySourceType {
  const normalized = filePath.replace(/\\/g, "/");
  if (normalized.includes("/docs/adr/") || normalized.startsWith("docs/adr/")) return "adr";
  if (isReadmePath(normalized)) return "readme";
  return "docs";
}

function isReadmePath(filePath: string): boolean {
  const base = filePath.split("/").pop() ?? "";
  return /^readme(\.|$)/i.test(base);
}

function buildReport(
  findings: IntegrityFinding[],
  scopeUsed: IntegrityScope,
  options: { degradedReason?: string; maxFindings?: number }
): IntegrityReport {
  const bySeverity = { info: 0, warn: 0, high: 0 };
  for (const finding of findings) {
    bySeverity[finding.severity] += 1;
  }
  const healthScore = computeHealthScore(findings);
  const topDomains = collectTopDomains(findings);
  const sorted = findings
    .slice()
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  const topFindings = Number.isFinite(options.maxFindings) && (options.maxFindings ?? 0) > 0
    ? sorted.slice(0, options.maxFindings)
    : sorted;

  return {
    status: options.degradedReason ? "degraded" : "ok",
    scopeUsed,
    healthScore,
    summary: {
      totalFindings: findings.length,
      bySeverity,
      topDomains
    },
    topFindings,
    degradedReason: options.degradedReason
  };
}

function buildDegradedReason(
  searchResponse: any,
  unsupportedSources: IntegritySourceType[],
  requestedScope: IntegrityScope | undefined
): string | undefined {
  if (requestedScope === "project") return "scope_limited";
  if (unsupportedSources.length > 0) return "sources_not_supported";
  if (searchResponse?.degraded) return searchResponse?.reason ?? "search_degraded";
  return undefined;
}

function computeHealthScore(findings: Array<{ severity: "info" | "warn" | "high"; confidence: number }>): number {
  const weights = { info: 0.1, warn: 0.3, high: 0.6 };
  const sum = findings.reduce((acc, finding) => acc + weights[finding.severity] * finding.confidence, 0);
  const score = 1 - Math.min(1, sum / 5);
  return Math.max(0, Math.min(1, score));
}

function collectTopDomains(findings: Array<{ tags?: string[] }>): string[] | undefined {
  const counts = new Map<string, number>();
  for (const finding of findings) {
    for (const tag of finding.tags ?? []) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  if (counts.size === 0) return undefined;
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([tag]) => tag);
}

function computeIntegrityPackId(
  query: string,
  scope: IntegrityScope,
  sources: IntegritySourceType[],
  targetPaths?: string[]
): string {
  const normalized = stableStringify({
    query,
    scope,
    sources,
    targetPaths: targetPaths ?? []
  });
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

function stableStringify(value: any): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(v => stableStringify(v)).join(",")}]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    const parts = keys.map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`);
    return `{${parts.join(",")}}`;
  }
  return JSON.stringify(String(value));
}
