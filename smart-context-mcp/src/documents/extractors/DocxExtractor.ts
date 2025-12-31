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
        const warnings = Array.isArray(result?.messages)
            ? result.messages.map((msg: any) => String(msg?.message ?? msg))
            : [];
        return { html, warnings };
    } catch (error: any) {
        throw new DocxExtractError("docx_parse_failed", error?.message);
    }
}
