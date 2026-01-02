import { describe, it, expect, beforeAll } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import { extractPdfAsText } from "../../documents/extractors/PdfExtractor.js";

let pdfAvailable = true;

beforeAll(async () => {
    try {
        await import("pdfjs-dist/legacy/build/pdf.js");
    } catch {
        pdfAvailable = false;
    }
});

function buildSamplePdfBuffer(text: string): Buffer {
    const escapePdfText = (value: string) =>
        value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");

    const content = `BT\n/F1 12 Tf\n72 720 Td\n(${escapePdfText(text)}) Tj\nET`;
    const objects = [
        "",
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        `<< /Length ${Buffer.byteLength(content, "utf8")} >>\nstream\n${content}\nendstream`,
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"
    ];

    const parts: string[] = ["%PDF-1.4\n"];
    const offsets: number[] = [0];
    let offset = Buffer.byteLength(parts[0], "utf8");

    for (let i = 1; i < objects.length; i += 1) {
        offsets[i] = offset;
        const obj = `${i} 0 obj\n${objects[i]}\nendobj\n`;
        parts.push(obj);
        offset += Buffer.byteLength(obj, "utf8");
    }

    let xref = "xref\n0 6\n0000000000 65535 f \n";
    for (let i = 1; i < offsets.length; i += 1) {
        xref += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
    }

    const trailer = `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF`;
    const pdf = parts.join("") + xref + trailer;
    return Buffer.from(pdf, "utf8");
}

describe("PdfExtractor", () => {
    it("marks low-text PDFs as needs_ocr", async () => {
        if (!pdfAvailable) return;
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "smart-context-pdf-"));
        const filePath = path.join(dir, "short.pdf");
        fs.writeFileSync(filePath, buildSamplePdfBuffer("Hi"));

        const result = await extractPdfAsText(filePath);
        expect(result.text).toContain("[[page:1]]");
        expect(result.warnings).toContain("pdf_needs_ocr");
        expect(result.warnings).toContain("pdf_low_text_density");

        fs.rmSync(dir, { recursive: true, force: true });
    });
});
