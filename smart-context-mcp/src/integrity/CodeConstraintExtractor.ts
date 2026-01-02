import crypto from "crypto";
import type { EvidenceRef, IntegrityClaim } from "./IntegrityTypes.js";
import { classifyTags } from "./TagClassifier.js";

const CONST_PATTERN = /(?:export\s+)?(?:const|let|var)\s+([A-Z0-9_]{3,})\s*=\s*(\d+(?:\.\d+)?)/;
const CONDITION_PATTERN = /if\s*\(([^)]*?)(<=|>=|<|>)\s*(\d+(?:\.\d+)?)(?:\s*(ms|s|sec|seconds|m|min|minutes|h|hr|hours|d|days))?\)/i;

export interface CodeConstraintInput {
  content: string;
  filePath: string;
  packId: string;
}

export function extractClaimsFromCode(input: CodeConstraintInput): IntegrityClaim[] {
  const lines = String(input.content ?? "").split(/\r?\n/);
  const claims: IntegrityClaim[] = [];
  const seen = new Set<string>();

  lines.forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (!line || line.startsWith("//")) return;

    const constMatch = line.match(CONST_PATTERN);
    if (constMatch) {
      const name = constMatch[1];
      const value = constMatch[2];
      const unit = inferUnitFromName(name);
      const text = unit ? `${name} = ${value} ${unit}` : `${name} = ${value}`;
      pushClaim(text, index);
    }

    const condMatch = line.match(CONDITION_PATTERN);
    if (condMatch) {
      const subject = condMatch[1].trim() || "constraint";
      const op = condMatch[2];
      const value = condMatch[3];
      const unit = condMatch[4] ?? inferUnitFromName(subject);
      const text = `${subject} ${op} ${value}${unit ? ` ${unit}` : ""}`;
      pushClaim(text, index);
    }
  });

  return claims;

  function pushClaim(text: string, lineIndex: number) {
    const id = hashClaim(input.filePath, lineIndex, text);
    if (seen.has(id)) return;
    seen.add(id);
    const evidenceRef: EvidenceRef = {
      packId: input.packId,
      itemId: `${input.filePath}:${lineIndex + 1}`,
      filePath: input.filePath,
      range: { startLine: lineIndex + 1, endLine: lineIndex + 1 }
    };
    const tags = classifyTags(text, input.filePath);
    claims.push({
      id,
      sourceType: "code",
      filePath: input.filePath,
      text,
      strength: "must",
      tags,
      evidenceRef
    });
  }
}

function hashClaim(filePath: string, lineIndex: number, text: string): string {
  const normalized = `${filePath}:${lineIndex}:${text}`;
  return crypto.createHash("sha256").update(normalized).digest("hex");
}

function inferUnitFromName(name: string): string {
  const upper = name.toUpperCase();
  if (upper.includes("MS")) return "ms";
  if (upper.includes("SEC") || upper.includes("SECOND")) return "s";
  if (upper.includes("MIN")) return "m";
  if (upper.includes("HOUR")) return "h";
  if (upper.includes("DAY")) return "d";
  return "";
}
