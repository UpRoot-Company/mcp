import crypto from "crypto";
import type { IntegrityClaim, IntegrityFinding } from "./IntegrityTypes.js";
import { classifyTags } from "./TagClassifier.js";

type Constraint = {
  key: string;
  value: number;
  unit: string;
  unitType: "time" | "percent" | "unitless";
  claim: IntegrityClaim;
};

const EN_CONSTRAINT = /(.+?)\b(within|at most|no more than|less than|<=)\s*(\d+(?:\.\d+)?)\s*(ms|s|sec|seconds|m|min|minutes|h|hr|hours|d|days|%|percent)?/i;
const KO_CONSTRAINT = /(.+?)(이내|이하|최대)\s*(\d+(?:\.\d+)?)\s*(초|분|시간|일|개월|퍼센트|%)?/i;
const COMP_CONSTRAINT = /(.+?)\s*(<=|>=|<|>)\s*(\d+(?:\.\d+)?)\s*(ms|s|sec|seconds|m|min|minutes|h|hr|hours|d|days|%|percent|초|분|시간|일|개월|퍼센트)?/i;
const ASSIGN_CONSTRAINT = /(.+?)\s*=\s*(\d+(?:\.\d+)?)\s*(ms|s|sec|seconds|m|min|minutes|h|hr|hours|d|days|%|percent|초|분|시간|일|개월|퍼센트)?/i;

const STOPWORDS = new Set([
  "the", "a", "an", "to", "for", "of", "and", "is", "are", "be", "with", "within", "at", "most",
  "no", "more", "than", "less", "maximum", "limit", "max", "min", "under", "over",
  "time", "window", "hour", "hours", "minute", "minutes", "second", "seconds", "day", "days", "ms", "s", "m", "h", "d"
]);

const KO_STOPWORDS = new Set([
  "은", "는", "이", "가", "을", "를", "의", "와", "과", "및", "에서", "로", "으로", "하다", "합니다",
  "초", "분", "시간", "일", "개월"
]);

export function detectNumericConflicts(claims: IntegrityClaim[]): IntegrityFinding[] {
  const constraints = claims
    .map(extractConstraint)
    .filter((c): c is Constraint => Boolean(c));

  const grouped = new Map<string, Constraint[]>();
  for (const constraint of constraints) {
    const key = `${constraint.key}|${constraint.unitType}`;
    const existing = grouped.get(key) ?? [];
    existing.push(constraint);
    grouped.set(key, existing);
  }

  const findings: IntegrityFinding[] = [];
  for (const entry of grouped.values()) {
    const byValue = new Map<string, Constraint[]>();
    for (const constraint of entry) {
      const normalizedValue = normalizeValue(constraint);
      const bucket = byValue.get(normalizedValue) ?? [];
      bucket.push(constraint);
      byValue.set(normalizedValue, bucket);
    }
    if (byValue.size < 2) continue;
    const variants = Array.from(byValue.values()).filter(list => list.length > 0);
    if (variants.length < 2) continue;

    const left = variants[0][0];
    const right = variants[1][0];
    if (!left || !right) continue;
    if (left.claim.filePath === right.claim.filePath) continue;

    const tags = dedupeTags([
      ...classifyTags(left.claim.text, left.claim.filePath),
      ...classifyTags(right.claim.text, right.claim.filePath),
      ...(left.claim.tags ?? []),
      ...(right.claim.tags ?? [])
    ]);

    const severity = resolveSeverity(left.claim, right.claim, tags);
    const confidence = resolveConfidence(left.claim, right.claim);
    const kind = resolveKind(left.claim.sourceType, right.claim.sourceType);

    findings.push({
      id: hashFinding(left, right),
      kind,
      severity,
      confidence,
      claimA: left.claim.text,
      claimB: right.claim.text,
      tags,
      evidenceRefs: [left.claim.evidenceRef, right.claim.evidenceRef],
      priority: scorePriority(severity, confidence, tags)
    });
  }

  return findings;
}

export function detectDocConflicts(claims: IntegrityClaim[]): IntegrityFinding[] {
  return detectNumericConflicts(claims);
}

function extractConstraint(claim: IntegrityClaim): Constraint | null {
  const text = claim.text;
  let match = text.match(EN_CONSTRAINT);
  let label = "";
  let rawValue = "";
  let rawUnit = "";
  if (match) {
    label = match[1] ?? "";
    rawValue = match[3] ?? "";
    rawUnit = match[4] ?? "";
  } else {
    match = text.match(KO_CONSTRAINT);
    if (match) {
      label = match[1] ?? "";
      rawValue = match[3] ?? "";
      rawUnit = match[4] ?? "";
    } else {
      match = text.match(COMP_CONSTRAINT);
      if (match) {
        label = match[1] ?? "";
        rawValue = match[3] ?? "";
        rawUnit = match[4] ?? "";
      } else {
        match = text.match(ASSIGN_CONSTRAINT);
        if (match) {
          label = match[1] ?? "";
          rawValue = match[2] ?? "";
          rawUnit = match[3] ?? "";
        }
      }
    }
  }
  if (!match) return null;
  const fallbackUnit = inferUnitFromLabel(label);
  const value = Number.parseFloat(rawValue);
  if (!Number.isFinite(value)) return null;

  const { unit, unitType } = normalizeUnit(rawUnit || fallbackUnit);
  const key = normalizeKey(label);
  if (!key) return null;

  return { key, value, unit, unitType, claim };
}

function normalizeUnit(unitRaw: string): { unit: string; unitType: "time" | "percent" | "unitless" } {
  const unit = unitRaw.trim().toLowerCase();
  if (!unit) return { unit: "", unitType: "unitless" };
  if (unit === "%" || unit === "percent" || unit === "퍼센트") return { unit: "%", unitType: "percent" };
  if (["ms"].includes(unit)) return { unit: "ms", unitType: "time" };
  if (["s", "sec", "seconds", "초"].includes(unit)) return { unit: "s", unitType: "time" };
  if (["m", "min", "minutes", "분"].includes(unit)) return { unit: "m", unitType: "time" };
  if (["h", "hr", "hours", "시간"].includes(unit)) return { unit: "h", unitType: "time" };
  if (["d", "days", "일"].includes(unit)) return { unit: "d", unitType: "time" };
  if (["개월"].includes(unit)) return { unit: "mo", unitType: "time" };
  return { unit, unitType: "unitless" };
}

function inferUnitFromLabel(label: string): string {
  const lower = label.toLowerCase();
  if (/(ms|millisecond)/.test(lower)) return "ms";
  if (/(sec|second|초)/.test(lower)) return "s";
  if (/(min|minute|분)/.test(lower)) return "m";
  if (/(hour|시간)/.test(lower)) return "h";
  if (/(day|일)/.test(lower)) return "d";
  return "";
}

function normalizeValue(constraint: Constraint): string {
  if (constraint.unitType !== "time") {
    return `${constraint.value}${constraint.unit}`;
  }
  const seconds = toSeconds(constraint.value, constraint.unit);
  return `${seconds}s`;
}

function toSeconds(value: number, unit: string): number {
  switch (unit) {
    case "ms":
      return Math.round(value / 1000);
    case "s":
      return Math.round(value);
    case "m":
      return Math.round(value * 60);
    case "h":
      return Math.round(value * 3600);
    case "d":
      return Math.round(value * 86400);
    case "mo":
      return Math.round(value * 2592000);
    default:
      return Math.round(value);
  }
}

function normalizeKey(label: string): string {
  const cleaned = label
    .toLowerCase()
    .replace(/[^a-z0-9가-힣\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  const tokens = cleaned.split(" ").filter(token => !STOPWORDS.has(token) && !KO_STOPWORDS.has(token));
  if (tokens.length === 0) return "";
  return tokens.slice(Math.max(0, tokens.length - 3)).join(" ");
}

function resolveSeverity(left: IntegrityClaim, right: IntegrityClaim, tags: string[]): "info" | "warn" | "high" {
  if (tags.some(tag => tag === "security" || tag === "data-loss" || tag === "payment")) {
    return "high";
  }
  if (left.strength === "must" || right.strength === "must") return "warn";
  if (left.strength === "should" || right.strength === "should") return "warn";
  return "info";
}

function resolveConfidence(left: IntegrityClaim, right: IntegrityClaim): number {
  let confidence = 0.55;
  if (left.strength === "must" || right.strength === "must") confidence += 0.15;
  if (left.strength === "should" || right.strength === "should") confidence += 0.05;
  return Math.min(0.9, confidence);
}

function scorePriority(severity: "info" | "warn" | "high", confidence: number, tags: string[]): number {
  const base = severity === "high" ? 1.0 : severity === "warn" ? 0.6 : 0.3;
  const tagBoost = tags.length > 0 ? 0.1 : 0;
  return base * confidence + tagBoost;
}

function hashFinding(left: Constraint, right: Constraint): string {
  const raw = `${left.key}:${left.value}${left.unit}:${right.value}${right.unit}:${left.claim.filePath}:${right.claim.filePath}`;
  return crypto.createHash("sha256").update(raw).digest("hex");
}

function dedupeTags(tags: string[]): string[] {
  return Array.from(new Set(tags.filter(Boolean)));
}

function resolveKind(
  left: IntegrityClaim["sourceType"],
  right: IntegrityClaim["sourceType"]
): IntegrityFinding["kind"] {
  const pair = new Set([left, right]);
  const docLike = new Set(["docs", "readme", "logs", "metrics"]);
  if (pair.has("code") && pair.has("comment")) return "comment_vs_code";
  if (pair.has("code") && pair.has("adr")) return "adr_vs_code";
  if (pair.has("code") && Array.from(docLike).some(type => pair.has(type as IntegrityClaim["sourceType"]))) {
    return "doc_vs_code";
  }
  return "doc_vs_doc";
}
