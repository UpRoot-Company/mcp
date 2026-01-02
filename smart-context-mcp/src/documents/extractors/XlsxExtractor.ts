import { promises as fs } from "fs";

type XlsxExtractionResult = {
    text: string;
    warnings: string[];
};

export class XlsxExtractError extends Error {
    constructor(
        public readonly reason: "xlsx_parser_missing" | "xlsx_parse_failed" | "xlsx_read_failed",
        message?: string
    ) {
        super(message ?? reason);
        this.name = "XlsxExtractError";
    }
}

const DEFAULT_MAX_SHEETS = 5;
const DEFAULT_MAX_ROWS = 200;
const DEFAULT_MAX_COLS = 30;

export async function extractXlsxAsText(absPath: string): Promise<XlsxExtractionResult> {
    let buffer: Buffer;
    try {
        buffer = await fs.readFile(absPath);
    } catch (error: any) {
        throw new XlsxExtractError("xlsx_read_failed", error?.message);
    }

    let xlsx: any;
    try {
        xlsx = await import("xlsx");
    } catch (error: any) {
        throw new XlsxExtractError("xlsx_parser_missing", error?.message);
    }

    try {
        const workbook = xlsx.read(buffer, { type: "buffer" });
        const warnings: string[] = [];
        const maxSheets = Number.parseInt(process.env.SMART_CONTEXT_XLSX_MAX_SHEETS ?? `${DEFAULT_MAX_SHEETS}`, 10);
        const maxRows = Number.parseInt(process.env.SMART_CONTEXT_XLSX_MAX_ROWS ?? `${DEFAULT_MAX_ROWS}`, 10);
        const maxCols = Number.parseInt(process.env.SMART_CONTEXT_XLSX_MAX_COLS ?? `${DEFAULT_MAX_COLS}`, 10);

        const sheets = workbook.SheetNames ?? [];
        const sheetLimit = Number.isFinite(maxSheets) && maxSheets > 0 ? maxSheets : DEFAULT_MAX_SHEETS;
        const rowLimit = Number.isFinite(maxRows) && maxRows > 0 ? maxRows : DEFAULT_MAX_ROWS;
        const colLimit = Number.isFinite(maxCols) && maxCols > 0 ? maxCols : DEFAULT_MAX_COLS;

        if (sheets.length === 0) {
            warnings.push("xlsx_empty_workbook");
        }

        const lines: string[] = [];
        for (const sheetName of sheets.slice(0, sheetLimit)) {
            const sheet = workbook.Sheets?.[sheetName];
            if (!sheet) {
                warnings.push("xlsx_missing_sheet");
                continue;
            }
            const rows = xlsx.utils.sheet_to_json(sheet, { header: 1, raw: false }) as Array<Array<unknown>>;
            lines.push(`[Sheet: ${sheetName}]`);
            if (!rows || rows.length === 0) {
                warnings.push("xlsx_empty_sheet");
                continue;
            }

            const headerRow = rows[0] ?? [];
            const headers = headerRow.map((cell, index) => {
                const value = String(cell ?? "").trim();
                return value.length > 0 ? value : `Col${index + 1}`;
            });

            const cappedHeaders = headers.slice(0, colLimit);
            if (headers.length > colLimit) warnings.push("xlsx_col_cap");

            lines.push(`Header: ${cappedHeaders.join(" | ")}`);

            const bodyRows = rows.slice(1, 1 + rowLimit);
            if (rows.length - 1 > rowLimit) warnings.push("xlsx_row_cap");

            for (let idx = 0; idx < bodyRows.length; idx += 1) {
                const row = bodyRows[idx] ?? [];
                const pairs: string[] = [];
                for (let col = 0; col < cappedHeaders.length; col += 1) {
                    const header = cappedHeaders[col] ?? `Col${col + 1}`;
                    const value = String(row[col] ?? "").trim();
                    if (value.length === 0) continue;
                    pairs.push(`${header}=${value}`);
                }
                if (pairs.length === 0) continue;
                lines.push(`Row ${idx + 2}: ${pairs.join(" | ")}`);
            }
        }

        if (sheets.length > sheetLimit) warnings.push("xlsx_sheet_cap");
        return { text: lines.join("\n"), warnings };
    } catch (error: any) {
        throw new XlsxExtractError("xlsx_parse_failed", error?.message);
    }
}
