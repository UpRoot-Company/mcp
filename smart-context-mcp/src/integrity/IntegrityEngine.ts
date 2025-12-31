import type {
  IntegrityBlockPolicy,
  IntegrityLimits,
  IntegrityMode,
  IntegrityOptions,
  IntegrityReport,
  IntegrityResult,
  IntegrityScope,
  IntegritySourceType
} from "./IntegrityTypes.js";

export type IntegrityPillar = "explore" | "understand" | "change";

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
    const blockPolicy =
      pillar === "change"
        ? normalizeBlockPolicy((raw as IntegrityOptions).blockPolicy, DEFAULT_BLOCK_POLICY)
        : DEFAULT_BLOCK_POLICY;

    const limits = normalizeLimits((raw as IntegrityOptions).limits);

    return {
      mode,
      scope,
      sources,
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
