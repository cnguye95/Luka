// Text-layer PDF extraction. Hard cases — layout-aware
// extraction, OCR, vision fallback — are deliberately absent here.
import { extractText, getDocumentProxy } from "unpdf";

export interface PdfExtraction {
  /** Page texts joined by a blank line. */
  text: string;
  pageCount: number;
  /** Per-page text, kept for the smell test. */
  pages: string[];
}

export async function pdfToMarkdown(bytes: Uint8Array): Promise<PdfExtraction> {
  // pdf.js takes ownership of the buffer it is handed and detaches it. The
  // caller still needs these bytes to hash the source, so it gets a copy.
  const document = await getDocumentProxy(bytes.slice());
  const { totalPages, text } = await extractText(document, { mergePages: false });
  const pages = text.map(tidy);
  const body = pages.filter((page) => page !== "").join("\n\n");
  return {
    text: body === "" ? "" : `${body}\n`,
    pageCount: totalPages,
    pages,
  };
}

function tidy(page: string): string {
  return page
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
