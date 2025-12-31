import { promises as fs } from "fs";

type PdfExtractionResult = {
    text: string;
    warnings: string[];
    stats: {
        inputBytes: number;
        outputChars: number;
        extractedPages: number;
        samplingApplied: boolean;
    };
};

export class PdfExtractError extends Error {
    constructor(
        public readonly reason: "pdf_parser_missing" | "pdf_parse_failed" | "pdf_read_failed",
        message?: string
    ) {
        super(message ?? reason);
        this.name = "PdfExtractError";
    }
}

const DEFAULT_MAX_PAGES = 25;
const DEFAULT_MAX_CHARS = 200_000;
const DEFAULT_MIN_CHARS = 40;
const DEFAULT_MIN_CHARS_PER_PAGE = 20;

function normalizeLimit(value: string | undefined, fallback: number): number {
    const parsed = Number.parseInt(value ?? "", 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function extractPdfAsText(absPath: string): Promise<PdfExtractionResult> {
    let buffer: Buffer;
    try {
        buffer = await fs.readFile(absPath);
    } catch (error: any) {
        throw new PdfExtractError("pdf_read_failed", error?.message);
    }

    let pdfjs: any;
    try {
        const module: any = await import("pdfjs-dist/legacy/build/pdf.js");
        pdfjs = module?.getDocument ? module : module?.default ?? module;
    } catch (error: any) {
        throw new PdfExtractError("pdf_parser_missing", error?.message);
    }

    const warnings = new Set<string>();
    const maxPages = normalizeLimit(process.env.SMART_CONTEXT_PDF_MAX_PAGES, DEFAULT_MAX_PAGES);
    const maxChars = normalizeLimit(process.env.SMART_CONTEXT_PDF_MAX_CHARS, DEFAULT_MAX_CHARS);
    const minChars = normalizeLimit(process.env.SMART_CONTEXT_PDF_MIN_CHARS, DEFAULT_MIN_CHARS);
    const minCharsPerPage = normalizeLimit(process.env.SMART_CONTEXT_PDF_MIN_CHARS_PER_PAGE, DEFAULT_MIN_CHARS_PER_PAGE);

    let loadingTask: any;
    try {
        loadingTask = pdfjs.getDocument({ data: buffer, disableWorker: true });
        const pdf = await loadingTask.promise;
        const totalPages = pdf?.numPages ?? 0;
        const pageLimit = Math.min(totalPages, maxPages);
        if (totalPages > pageLimit) warnings.add("pdf_page_cap");

        const lines: string[] = [];
        let totalChars = 0;
        let pagesWithText = 0;

        for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
            const page = await pdf.getPage(pageNumber);
            const textContent = await page.getTextContent();
            const items = Array.isArray(textContent?.items) ? textContent.items : [];
            const pageText = items
                .map((item: any) => String(item?.str ?? ""))
                .join(" ")
                .replace(/\s+/g, " ")
                .trim();
            if (pageText.length === 0) {
                warnings.add("pdf_empty_page");
            } else {
                pagesWithText += 1;
                if (pageText.length < minCharsPerPage) {
                    warnings.add("pdf_low_text_density");
                }
                lines.push(`[[page:${pageNumber}]]`);
                lines.push(pageText);
                totalChars += pageText.length;
            }
            if (typeof page.cleanup === "function") {
                page.cleanup();
            }
            if (totalChars >= maxChars) {
                warnings.add("pdf_char_cap");
                break;
            }
        }

        if (totalChars < minChars || pagesWithText === 0) {
            warnings.add("pdf_needs_ocr");
        }

        const text = lines.join("\n");
        return {
            text,
            warnings: Array.from(warnings),
            stats: {
                inputBytes: buffer.length,
                outputChars: text.length,
                extractedPages: pageLimit,
                samplingApplied: totalPages > pageLimit
            }
        };
    } catch (error: any) {
        throw new PdfExtractError("pdf_parse_failed", error?.message);
    } finally {
        try {
            if (loadingTask?.destroy) {
                await loadingTask.destroy();
            }
        } catch {
            // best-effort cleanup
        }
    }
}
