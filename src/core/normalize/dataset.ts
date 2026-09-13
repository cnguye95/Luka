// Dataset sources become a descriptor card; the original file is retained.
// The head sample is fixed at 10 rows.
import { datasetColumnsOmitted } from "../markers";
import { basename } from "../paths";

const HEAD_ROWS = 10;
/**
 * A bound with no setting: the descriptor assumes a file that is actually
 * tabular. Both tables below walk columns against rows, so without it a ragged
 * file — one very wide header, many short rows — costs columns x rows while the
 * file itself stays small: 478KB measured at 53 seconds, holding the global
 * operation lock the whole time. Capping the columns restores the ordinary
 * relationship where the work is proportional to the bytes.
 *
 * The rows are deliberately *not* sampled. A tall file is genuinely large, so
 * spending time on it is honest work, and reading only the first N rows would
 * make the reported column type quietly wrong for a file whose values change
 * further down.
 */
const MAX_SCHEMA_COLUMNS = 200;
const BYTE_ORDER_MARK = String.fromCharCode(0xfeff);

/** RFC 4180: quoted fields, doubled quotes, embedded separators and newlines. */
export function parseDelimited(text: string, delimiter: string): string[][] {
  const input = text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i] as string;
    if (quoted) {
      if (char === '"') {
        if (input[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && field === "") quoted = true;
    else if (char === delimiter) {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") field += char;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function delimiterFor(path: string): string {
  return path.toLowerCase().endsWith(".tsv") ? "\t" : ",";
}

export function datasetToMarkdown(text: string, sourcePath: string): string {
  const delimiter = delimiterFor(sourcePath);
  const rows = parseDelimited(text, delimiter);
  const hasHeader = rows.length > 0 && looksLikeHeader(rows[0] as string[]);
  const columns = hasHeader
    ? (rows[0] as string[]).map((c) => c.trim())
    : Array.from({ length: rows[0]?.length ?? 0 }, (_, i) => `c${i + 1}`);
  const data = hasHeader ? rows.slice(1) : rows;

  const out: string[] = [];
  out.push(`# ${basename(sourcePath)}`, "");
  out.push("A dataset descriptor written by Luka. The original file is retained.", "");
  out.push(`- Rows: ${data.length}`);
  out.push(`- Columns: ${columns.length}`);
  out.push(`- Delimiter: ${delimiter === "\t" ? "tab" : "comma"}`);
  out.push(`- Header row: ${hasHeader ? "yes" : "no, columns are positional"}`, "");

  // Both tables below walk columns against rows, so an unbounded column count
  // multiplies against an unbounded row count — and a ragged file (one very
  // wide header, many short rows) makes that product enormous while the file
  // itself stays small. A card is a schema, a row count and a ten-row head;
  // none of that needs a table row per column of a file that is not really
  // tabular. Both dimensions are bounded here, and anything dropped is named.
  const shown = columns.slice(0, MAX_SCHEMA_COLUMNS);

  out.push("## Schema", "");
  if (shown.length < columns.length) {
    out.push(datasetColumnsOmitted(shown.length, columns.length), "");
  }
  out.push("| Column | Type |", "| --- | --- |");
  shown.forEach((column, index) => {
    const values = data.map((row) => row[index] ?? "");
    out.push(`| ${escapeCell(column)} | ${inferType(values)} |`);
  });
  out.push("");

  const head = data.slice(0, HEAD_ROWS);
  out.push(`## First ${head.length} row${head.length === 1 ? "" : "s"}`, "");
  out.push(`| ${shown.map(escapeCell).join(" | ")} |`);
  out.push(`| ${shown.map(() => "---").join(" | ")} |`);
  for (const row of head) {
    out.push(`| ${shown.map((_, i) => escapeCell(row[i] ?? "")).join(" | ")} |`);
  }
  out.push("");

  out.push("## Provenance", "");
  out.push(`Extracted from \`${sourcePath}\`.`, "");

  return out.join("\n");
}

function looksLikeHeader(row: readonly string[]): boolean {
  if (row.length === 0) return false;
  const cells = row.map((c) => c.trim());
  if (cells.some((c) => c === "")) return false;
  if (new Set(cells.map((c) => c.toLowerCase())).size !== cells.length) return false;
  return cells.every((c) => !isNumeric(c));
}

function inferType(values: readonly string[]): string {
  const present = values.map((v) => v.trim()).filter((v) => v !== "");
  if (present.length === 0) return "empty";
  if (present.every(isInteger)) return "integer";
  if (present.every(isNumeric)) return "number";
  if (present.every((v) => /^(true|false|yes|no)$/i.test(v))) return "boolean";
  if (present.every((v) => /^\d{4}-\d{2}-\d{2}([T ].*)?$/.test(v))) return "date";
  return "string";
}

function isNumeric(value: string): boolean {
  return /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value.trim());
}

function isInteger(value: string): boolean {
  return /^[+-]?\d+$/.test(value.trim());
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}
