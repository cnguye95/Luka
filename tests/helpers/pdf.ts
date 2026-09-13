// A byte-exact, uncompressed PDF with a real text layer, so the extraction
// path is exercised without committing an opaque binary blob to the repo.
import { utf8 } from "../../src/core/hash";

export function buildPdf(pages: readonly string[]): Uint8Array {
  const pageCount = pages.length;
  const fontId = 3 + pageCount * 2;
  const objects: string[] = [];

  const kids = Array.from({ length: pageCount }, (_, i) => `${3 + i * 2} 0 R`).join(" ");
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${kids}] /Count ${pageCount} >>`;

  pages.forEach((text, index) => {
    const pageId = 3 + index * 2;
    const contentId = pageId + 1;
    objects[pageId] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] ` +
      `/Contents ${contentId} 0 R /Resources << /Font << /F1 ${fontId} 0 R >> >> >>`;
    const stream = `BT /F1 12 Tf 72 720 Td (${escapeText(text)}) Tj ET`;
    objects[contentId] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  });

  objects[fontId] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>";

  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (let id = 1; id <= fontId; id++) {
    offsets[id] = body.length;
    body += `${id} 0 obj\n${objects[id] as string}\nendobj\n`;
  }

  const startXref = body.length;
  let xref = `xref\n0 ${fontId + 1}\n0000000000 65535 f \n`;
  for (let id = 1; id <= fontId; id++) {
    xref += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  body += `${xref}trailer\n<< /Size ${fontId + 1} /Root 1 0 R >>\nstartxref\n${startXref}\n%%EOF\n`;

  return utf8(body);
}

function escapeText(text: string): string {
  return text.replace(/([\\()])/g, "\\$1");
}
