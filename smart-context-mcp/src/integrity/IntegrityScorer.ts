export function scoreIntegrityPriority(
  severity: "info" | "warn" | "high",
  confidence: number,
  tags: string[],
  impactScore = 0
): number {
  const base = severity === "high" ? 1.0 : severity === "warn" ? 0.6 : 0.3;
  const tagBoost = tags.length > 0 ? 0.1 : 0;
  const impactBoost = impactScore > 0 ? Math.min(0.3, impactScore * 0.3) : 0;
  return base * confidence + tagBoost + impactBoost;
}
