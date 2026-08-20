import { describe, expect, it } from "vitest";
import { datasetToMarkdown, parseDelimited } from "../src/core/normalize/dataset";
import { htmlToMarkdown } from "../src/core/normalize/html";
import { pdfToMarkdown } from "../src/core/normalize/pdf";
import { buildPdf } from "./helpers/pdf";

describe("html normalization", () => {
  it("converts structure and drops script and style", () => {
    const markdown = htmlToMarkdown(
      "<html><head><style>a{}</style></head><body><h1>Title</h1>" +
        "<p>Some <strong>bold</strong> text.</p><ul><li>one</li><li>two</li></ul>" +
        "<script>alert(1)</script></body></html>",
    );
    expect(markdown).toContain("# Title");
    expect(markdown).toContain("**bold**");
    expect(markdown).toMatch(/^- +one$/m);
    expect(markdown).not.toContain("alert");
    expect(markdown).not.toContain("a{}");
  });

  it("keeps image references so localization can act on them", () => {
    expect(htmlToMarkdown('<p><img src="https://ex.com/a.png" alt="fig"></p>')).toContain(
      "![fig](https://ex.com/a.png)",
    );
  });
});

describe("delimited parsing", () => {
  it("handles quotes, embedded separators and newlines", () => {
    expect(parseDelimited('a,b\n"x,1","y\nz"\n', ",")).toEqual([
      ["a", "b"],
      ["x,1", "y\nz"],
    ]);
  });

  it("unescapes doubled quotes and tolerates CRLF", () => {
    expect(parseDelimited('a\r\n"say ""hi"""\r\n', ",")).toEqual([["a"], ['say "hi"']]);
  });

  it("does not emit a trailing empty row", () => {
    expect(parseDelimited("a,b\n1,2\n", ",")).toHaveLength(2);
  });
});

describe("dataset descriptor card", () => {
  const csv = ["id,name,score", ...Array.from({ length: 15 }, (_, i) => `${i + 1},n${i + 1},${i / 2}`)].join("\n");

  it("reports schema, row count and a 10-row head", () => {
    const card = datasetToMarkdown(csv, "raw/data.csv");
    expect(card).toContain("# data.csv");
    expect(card).toContain("- Rows: 15");
    expect(card).toContain("- Columns: 3");
    expect(card).toContain("| id | integer |");
    expect(card).toContain("| name | string |");
    expect(card).toContain("| score | number |");
    expect(card).toContain("## First 10 rows");
    expect(card).toContain("| 10 | n10 |");
    expect(card).not.toContain("| 11 | n11 |");
    expect(card).toContain("Extracted from `raw/data.csv`.");
  });

  it("synthesizes positional columns when there is no header row", () => {
    const card = datasetToMarkdown("1,2\n3,4\n", "raw/nums.csv");
    expect(card).toContain("- Header row: no, columns are positional");
    expect(card).toContain("| c1 | integer |");
    expect(card).toContain("- Rows: 2");
  });

  it("splits TSV on tabs", () => {
    expect(datasetToMarkdown("a\tb\n1\t2\n", "raw/d.tsv")).toContain("- Delimiter: tab");
  });
});

describe("pdf text-layer extraction", () => {
  it("recovers the text layer and the page count", async () => {
    const extraction = await pdfToMarkdown(buildPdf(["Hello Luka", "Second page text"]));
    expect(extraction.pageCount).toBe(2);
    expect(extraction.text).toContain("Hello Luka");
    expect(extraction.text).toContain("Second page text");
    expect(extraction.pages).toHaveLength(2);
  });

  it("leaves the caller's bytes intact, since they are the source's identity", async () => {
    const bytes = buildPdf(["Hello Luka"]);
    const before = bytes.length;
    await pdfToMarkdown(bytes);
    // pdf.js detaches whatever buffer it is handed; a detached view reads as empty.
    expect(bytes.length).toBe(before);
    expect(bytes.some((byte) => byte !== 0)).toBe(true);
  });
});
