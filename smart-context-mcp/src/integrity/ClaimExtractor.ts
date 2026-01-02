import crypto from "crypto";
import type { EvidenceRef, IntegrityClaim, IntegritySourceType } from "./IntegrityTypes.js";
import { classifyTags } from "./TagClassifier.js";

const MUST_PATTERNS = [
  /\b(must|shall|required|mandatory|not allowed|prohibited)\b/i,
  /(반드시|해야\s*한다|필수|금지|불가)/i
];

const SHOULD_PATTERNS = [
  /\b(should|recommended|prefer|ideally)\b/i,
  /(권장|가능하면|되도록)/i
];

const NUMBER_PATTERNS = [
  /\b\d+(?:\.\d+)?\s*(ms|s|sec|seconds|m|min|minutes|h|hr|hours|d|days|%|percent)\b/i,
  /\b\d+(?:\.\d+)?\s*(초|분|시간|일|개월|퍼센트|%)\b/i,
  /\d+(?:\.\d+)?\s*(초|분|시간|일|개월|퍼센트|%)/i
];

const FENCE_MARKER = "```";

export interface ClaimExtractionInput {
  text: string;
  filePath: string;
  sectionTitle?: string;
  sourceType: IntegritySourceType;
  evidenceRef: EvidenceRef;
}

export function extractClaimsFromText(input: ClaimExtractionInput): IntegrityClaim[] {
  const lines = String(input.text ?? "").split(/\r?\n/);
  const claims: IntegrityClaim[] = [];
  const seen = new Set<string>();
  let inCodeFence = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith(FENCE_MARKER)) {
      inCodeFence = !inCodeFence;
      continue;
    }
    if (inCodeFence) continue;

    if (line.length < 8) continue;

    const strength = resolveStrength(line);
    if (!strength) continue;

    const tags = classifyTags(line, input.filePath);
    const claimId = hashClaim(input.filePath, input.sectionTitle, line);
    if (seen.has(claimId)) continue;
    seen.add(claimId);

    claims.push({
      id: claimId,
      sourceType: input.sourceType,
      filePath: input.filePath,
      sectionTitle: input.sectionTitle,
      text: line,
      strength,
      tags,
      evidenceRef: input.evidenceRef
    });
  }

  return claims;
}

function resolveStrength(line: string): "must" | "should" | "info" | null {
  if (MUST_PATTERNS.some(pattern => pattern.test(line))) {
    return "must";
  }
  if (SHOULD_PATTERNS.some(pattern => pattern.test(line))) {
    return "should";
  }
  if (NUMBER_PATTERNS.some(pattern => pattern.test(line))) {
    return "must";
  }
  return null;
}

function hashClaim(filePath: string, sectionTitle: string | undefined, text: string): string {
  const normalized = `${filePath}::${sectionTitle ?? ""}::${text}`;
  return crypto.createHash("sha256").update(normalized).digest("hex");
}
