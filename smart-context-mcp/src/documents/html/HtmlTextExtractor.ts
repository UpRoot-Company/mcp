const ENTITY_MAP: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": "\"",
    "&#39;": "'"
};

export function extractHtmlTextPreserveLines(html: string): string {
    // Preserve line breaks so downstream range calculations remain stable.
    const lines = String(html ?? "").split(/\r?\n/);
    const out: string[] = [];
    for (const line of lines) {
        let stripped = line;
        stripped = stripped.replace(/<!--[\s\S]*?-->/g, " ");
        stripped = stripped.replace(/<script[\s\S]*?<\/script>/gi, " ");
        stripped = stripped.replace(/<style[\s\S]*?<\/style>/gi, " ");
        stripped = stripped.replace(/<[^>]+>/g, " ");
        stripped = decodeEntities(stripped);
        stripped = stripped.replace(/\s+/g, " ").trim();
        out.push(stripped);
    }
    return out.join("\n");
}

export function extractHtmlReferences(html: string): Array<{ text: string; href: string; line: number }> {
    const content = String(html ?? "");
    const refs: Array<{ text: string; href: string; line: number }> = [];
    const patterns = [
        /<a\b[^>]*\bhref\s*=\s*("([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>/gi,
        /<link\b[^>]*\bhref\s*=\s*("([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>/gi,
        /<script\b[^>]*\bsrc\s*=\s*("([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>/gi,
        /<img\b[^>]*\bsrc\s*=\s*("([^"]+)"|'([^']+)'|([^\s>]+))[^>]*>/gi
    ];
    for (const pattern of patterns) {
        let match: RegExpExecArray | null;
        while ((match = pattern.exec(content)) !== null) {
            const href = (match[2] ?? match[3] ?? match[4] ?? "").trim();
            if (!href) continue;
            const line = 1 + countNewlines(content, match.index);
            refs.push({ text: "", href, line });
        }
    }
    return refs;
}

export function extractHtmlHeadings(html: string): Array<{ title: string; level: number; line: number }> {
    const content = String(html ?? "");
    const headings: Array<{ title: string; level: number; line: number }> = [];
    const regex = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
        const level = Number(match[1]);
        const rawInner = match[2] ?? "";
        const title = normalizeTitle(rawInner);
        if (!title) continue;
        const line = 1 + countNewlines(content, match.index);
        headings.push({ title, level, line });
    }
    return headings;
}

function normalizeTitle(rawInnerHtml: string): string {
    let text = rawInnerHtml;
    text = text.replace(/<[^>]+>/g, " ");
    text = decodeEntities(text);
    text = text.replace(/\s+/g, " ").trim();
    return text;
}

function decodeEntities(input: string): string {
    return input.replace(/&(?:amp|lt|gt|quot|#39);/g, (m) => ENTITY_MAP[m] ?? m);
}

function countNewlines(text: string, endIndex: number): number {
    let count = 0;
    for (let i = 0; i < endIndex && i < text.length; i += 1) {
        if (text[i] === "\n") count += 1;
    }
    return count;
}

