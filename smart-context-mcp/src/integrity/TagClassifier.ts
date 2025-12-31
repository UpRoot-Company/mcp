const TAG_RULES: Array<{ tag: "security" | "data-loss" | "payment"; pattern: RegExp }> = [
  { tag: "security", pattern: /\b(auth|oauth|token|secret|encrypt|tls|jwt|password|credential|security)\b/i },
  { tag: "data-loss", pattern: /\b(delete|drop|purge|truncate|backup|restore|wipe|loss|data\s*loss)\b/i },
  { tag: "payment", pattern: /\b(payment|billing|invoice|refund|charge|settle|payout)\b/i }
];

const PATH_TAG_RULES: Array<{ tag: "security" | "data-loss" | "payment"; pattern: RegExp }> = [
  { tag: "security", pattern: /\/(auth|security|crypto|secrets?)\//i },
  { tag: "data-loss", pattern: /\/(backup|restore|migrations?)\//i },
  { tag: "payment", pattern: /\/(billing|payment|checkout|refund)/i }
];

export function classifyTags(text: string, filePath: string): string[] {
  const tags = new Set<string>();
  const normalizedPath = String(filePath ?? "").replace(/\\/g, "/");
  for (const rule of TAG_RULES) {
    if (rule.pattern.test(text)) {
      tags.add(rule.tag);
    }
  }
  for (const rule of PATH_TAG_RULES) {
    if (rule.pattern.test(normalizedPath)) {
      tags.add(rule.tag);
    }
  }
  return Array.from(tags);
}
