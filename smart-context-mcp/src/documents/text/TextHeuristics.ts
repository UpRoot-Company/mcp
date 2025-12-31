export interface TextHeadingNode {
    title: string;
    level: number;
    line: number;
}

export interface TextOutlineHeuristics {
    maxDepth?: number;
    minHeadingChars?: number;
    maxHeadingChars?: number;
    allowAllCaps?: boolean;
    allowNumbered?: boolean;
    allowUnderline?: boolean;
}

const DEFAULTS: Required<TextOutlineHeuristics> = {
    maxDepth: 3,
    minHeadingChars: 3,
    maxHeadingChars: 80,
    allowAllCaps: true,
    allowNumbered: true,
    allowUnderline: true
};

export function inferTextHeadings(content: string, heuristics: TextOutlineHeuristics = {}): TextHeadingNode[] {
    const cfg = { ...DEFAULTS, ...heuristics };
    const lines = String(content ?? "").split(/\r?\n/);
    const headings: TextHeadingNode[] = [];
    for (let i = 0; i < lines.length; i += 1) {
        const raw = lines[i] ?? "";
        const line = raw.trim();
        if (!line) continue;

        // 1) Markdown-like headings.
        const md = line.match(/^(#{1,6})\s+(.+)$/);
        if (md) {
            const level = Math.min(6, md[1].length);
            const title = normalizeHeading(md[2]);
            if (acceptHeading(title, cfg) && level <= cfg.maxDepth) {
                headings.push({ title, level, line: i + 1 });
            }
            continue;
        }

        // 2) Underline style: Title + ===== / -----
        if (cfg.allowUnderline && i + 1 < lines.length) {
            const underline = (lines[i + 1] ?? "").trim();
            if (/^=+$/.test(underline) || /^-+$/.test(underline)) {
                const level = /^=+$/.test(underline) ? 1 : 2;
                const title = normalizeHeading(line);
                if (acceptHeading(title, cfg) && level <= cfg.maxDepth) {
                    headings.push({ title, level, line: i + 1 });
                    i += 1; // consume underline
                    continue;
                }
            }
        }

        // 3) Numbered: "1. Title" / "1) Title"
        if (cfg.allowNumbered) {
            const numbered = line.match(/^(\d{1,3})[\.\)]\s+(.+)$/);
            if (numbered) {
                const title = normalizeHeading(numbered[2]);
                if (acceptHeading(title, cfg) && 2 <= cfg.maxDepth) {
                    headings.push({ title, level: 2, line: i + 1 });
                    continue;
                }
            }
        }

        // 4) ALL CAPS (short, low whitespace)
        if (cfg.allowAllCaps && isAllCapsHeading(line)) {
            const title = normalizeHeading(line);
            if (acceptHeading(title, cfg) && 2 <= cfg.maxDepth) {
                headings.push({ title, level: 2, line: i + 1 });
                continue;
            }
        }
    }
    return headings;
}

function acceptHeading(title: string, cfg: Required<TextOutlineHeuristics>): boolean {
    if (!title) return false;
    if (title.length < cfg.minHeadingChars) return false;
    if (title.length > cfg.maxHeadingChars) return false;
    return true;
}

function normalizeHeading(value: string): string {
    return String(value ?? "")
        .replace(/\s+/g, " ")
        .replace(/[*_`~]+/g, "")
        .trim();
}

function isAllCapsHeading(line: string): boolean {
    if (!/^[A-Z0-9 _-]+$/.test(line)) return false;
    const letters = line.replace(/[^A-Z]/g, "");
    if (letters.length < 3) return false;
    const spaces = (line.match(/\s/g) ?? []).length;
    return spaces <= Math.max(10, Math.floor(line.length * 0.4));
}

