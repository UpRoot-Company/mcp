import type { DocumentKind } from "../../types.js";

export function buildDeterministicPreview(params: {
    text: string;
    query?: string;
    kind?: DocumentKind;
    maxChars: number;
}): { preview: string; truncated: boolean } {
    const maxChars = Math.max(32, Math.min(4000, params.maxChars));
    const text = String(params.text ?? "");
    const kind = params.kind ?? "unknown";
    const queryTokens = tokenizeQuery(params.query ?? "");

    const lines = text.split(/\r?\n/);
    const scored: Array<{ line: string; score: number }> = [];

    for (const raw of lines) {
        const line = normalizeLine(raw);
        if (!line) continue;
        const score = scoreLine(line, queryTokens, kind);
        if (score <= 0) continue;
        scored.push({ line, score });
    }

    // If nothing scored, fall back to a compact prefix.
    if (scored.length === 0) {
        const base = collapseWhitespace(text).trim();
        const preview = base.length > maxChars ? `${base.slice(0, maxChars - 1)}…` : base;
        return { preview, truncated: base.length > maxChars };
    }

    scored.sort((a, b) => b.score - a.score);

    const selected: string[] = [];
    let used = 0;
    for (const { line } of scored) {
        if (selected.includes(line)) continue;
        const nextLen = used + (selected.length > 0 ? 1 : 0) + line.length;
        if (nextLen > maxChars) continue;
        selected.push(line);
        used = nextLen;
        if (selected.length >= 8) break;
    }

    if (selected.length === 0) {
        const base = collapseWhitespace(text).trim();
        const preview = base.length > maxChars ? `${base.slice(0, maxChars - 1)}…` : base;
        return { preview, truncated: base.length > maxChars };
    }

    const preview = selected.join("\n");
    const truncated = collapseWhitespace(text).length > preview.length;
    return { preview, truncated };
}

function tokenizeQuery(query: string): string[] {
    const tokens = query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(t => t.length >= 3);
    return Array.from(new Set(tokens)).slice(0, 12);
}

function normalizeLine(line: string): string {
    return String(line ?? "").replace(/\s+/g, " ").trim();
}

function collapseWhitespace(text: string): string {
    return String(text ?? "").replace(/\s+/g, " ");
}

function scoreLine(line: string, queryTokens: string[], kind: DocumentKind): number {
    let score = 0;

    // Headings / bullets are usually informative.
    if (/^#{1,6}\s+/.test(line)) score += 4;
    if (/^[-*]\s+/.test(line) || /^\d{1,3}[\.\)]\s+/.test(line)) score += 3;
    if (/^(note|warning|caution|important):/i.test(line)) score += 3;

    // Code-comment specific heuristics.
    if (kind === "code_comment") {
        if (/^@(?:param|returns?|throws?|example|deprecated)\b/i.test(line)) score += 4;
        if (/TODO|FIXME/i.test(line)) score += 1;
    }

    // Query token match boosts.
    const lower = line.toLowerCase();
    let matched = 0;
    for (const t of queryTokens) {
        if (lower.includes(t)) {
            matched += 1;
        }
    }
    if (matched > 0) score += 6 + matched;

    // Penalize very long lines (usually code blocks or minified text).
    if (line.length > 220) score -= 2;
    if (line.length > 500) score -= 5;

    return score;
}

