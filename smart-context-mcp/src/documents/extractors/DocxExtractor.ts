import { promises as fs } from "fs";

export type DocxExtractionResult = {
    html: string;
    warnings: string[];
};

export class DocxExtractError extends Error {
    constructor(
        public readonly reason: "docx_parser_missing" | "docx_parse_failed" | "docx_read_failed",
        message?: string
    ) {
        super(message ?? reason);
        this.name = "DocxExtractError";
    }
}

export function postProcessDocxHtml(html: string): { html: string; warnings: string[] } {
    if (!html || !html.includes("<img")) {
        return { html, warnings: [] };
    }
    const warnings = new Set<string>();
    const replaced = html.replace(/<img\b[^>]*>/gi, (match) => {
        const altMatch = match.match(/\balt\s*=\s*["']([^"']*)["']/i);
        const altText = (altMatch?.[1] ?? "").trim();
        const label = altText ? `image: ${escapeHtml(altText)}` : "image";
        warnings.add("docx_embedded_images_ignored");
        return `<span>[${label}]</span>`;
    });
    return { html: replaced, warnings: Array.from(warnings) };
}

export async function extractDocxAsHtml(absPath: string): Promise<DocxExtractionResult> {
    let buffer: Buffer;
    try {
        buffer = await fs.readFile(absPath);
    } catch (error: any) {
        throw new DocxExtractError("docx_read_failed", error?.message);
    }

    let mammoth: any;
    try {
        mammoth = await import("mammoth");
    } catch (error: any) {
        throw new DocxExtractError("docx_parser_missing", error?.message);
    }

    try {
        const result = await mammoth.convertToHtml({ buffer });
        const html = typeof result?.value === "string" ? result.value : "";
        const postProcessed = postProcessDocxHtml(html);
        const warnings = Array.isArray(result?.messages)
            ? result.messages.map((msg: any) => String(msg?.message ?? msg))
            : [];
        return { html: postProcessed.html, warnings: [...warnings, ...postProcessed.warnings] };
    } catch (error: any) {
        throw new DocxExtractError("docx_parse_failed", error?.message);
    }
}

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
