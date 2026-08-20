import { describe, expect, it } from "vitest";
import {
  ensureFrontmatter,
  parseFrontmatter,
  replaceFrontmatterValue,
  serializeFrontmatter,
} from "../src/core/yaml";

describe("replaceFrontmatterValue", () => {
  const wrap = (inner: string, body = "Body.\n") => `---\n${inner}---\n${body}`;
  const rewrite = (inner: string) =>
    replaceFrontmatterValue(wrap(inner), "derived-from", "raw/new.html");

  it("rewrites the value and leaves every other byte alone", () => {
    const before = wrap("# a note\nmykey: 010\nflow: [a, b]\nderived-from: raw/old.html\n");
    const after = replaceFrontmatterValue(before, "derived-from", "raw/new.html") as string;

    expect(after).toContain("derived-from: raw/new.html");
    expect(after).toContain("# a note");
    expect(after).toContain("mykey: 010");
    expect(after).toContain("flow: [a, b]");
    expect(after.endsWith("Body.\n")).toBe(true);
    // Reads back as the value that was written, not as text near it.
    expect(parseFrontmatter(after).data["derived-from"]).toBe("raw/new.html");
  });

  it("quotes a value that needs it", () => {
    const after = replaceFrontmatterValue(
      wrap("derived-from: raw/old.html\n"),
      "derived-from",
      "raw/a: b.html",
    ) as string;
    expect(parseFrontmatter(after).data["derived-from"]).toBe("raw/a: b.html");
  });

  it("preserves CRLF line endings", () => {
    const before = "---\r\nderived-from: raw/old.html\r\nkeep: yes\r\n---\r\nBody.\r\n";
    const after = replaceFrontmatterValue(before, "derived-from", "raw/new.html") as string;
    expect(after).toContain("derived-from: raw/new.html\r\n");
    expect(after).toContain("keep: yes\r\n");
  });

  it("rewrites the document's own key, never a nested one of the same name", () => {
    // Matching by first occurrence would rewrite the user's nested value and
    // leave the real key stale — both wrong, and silently so.
    const after = rewrite(
      "provenance:\n  derived-from: raw/scan.txt\nderived-from: raw/old.html\n",
    ) as string;

    expect(after).toContain("  derived-from: raw/scan.txt");
    expect(after).toContain("\nderived-from: raw/new.html");
    expect(parseFrontmatter(after).data["derived-from"]).toBe("raw/new.html");
  });

  it("declines a folded or literal block value", () => {
    expect(rewrite("derived-from: >-\n  raw/old.html\n")).toBe(null);
    expect(rewrite("derived-from: |-\n  raw/old.html\n")).toBe(null);
    expect(rewrite("derived-from:\n  raw/old.html\n")).toBe(null);
  });

  it("declines a quoted key it cannot match as a plain line", () => {
    expect(rewrite("'derived-from': raw/old.html\n")).toBe(null);
  });

  it("declines when the key is absent, or only in the body", () => {
    expect(rewrite("ingested: '2026-08-19'\n")).toBe(null);
    expect(replaceFrontmatterValue("derived-from: raw/old.html\n", "derived-from", "x")).toBe(null);
  });
});

describe("frontmatter", () => {
  it("reports absence without touching the body", () => {
    const parsed = parseFrontmatter("# Title\n\nBody.\n");
    expect(parsed.present).toBe(false);
    expect(parsed.data).toEqual({});
    expect(parsed.body).toBe("# Title\n\nBody.\n");
  });

  it("parses a block and returns the remainder as the body", () => {
    const parsed = parseFrontmatter("---\ningested: '2026-08-19'\nsource-format: md\n---\nBody.\n");
    expect(parsed.present).toBe(true);
    expect(parsed.data).toEqual({ ingested: "2026-08-19", "source-format": "md" });
    expect(parsed.body).toBe("Body.\n");
  });

  it("treats a malformed block as present but not mergeable", () => {
    const parsed = parseFrontmatter("---\n: : not: yaml\n\t- x\n---\nBody.\n");
    expect(parsed.present).toBe(true);
    expect(parsed.mergeable).toBe(false);
    expect(parsed.data).toEqual({});
    expect(parsed.body).toBe("Body.\n");
  });

  it("treats a sequence or scalar block as not mergeable", () => {
    expect(parseFrontmatter("---\n- one\n- two\n---\nBody.\n").mergeable).toBe(false);
    expect(parseFrontmatter("---\nJust a sentence\n---\nBody.\n").mergeable).toBe(false);
  });

  it("handles an empty block and a frontmatter-only document", () => {
    expect(parseFrontmatter("---\n---\n").body).toBe("");
    expect(parseFrontmatter("---\na: 1\n---").body).toBe("");
  });

  it("emits keys in the §4 order regardless of construction order", () => {
    const block = serializeFrontmatter({
      "derived-from": "raw/page.html",
      "source-format": "html",
      ingested: "2026-08-19",
    });
    expect(block).toBe(
      "---\ningested: '2026-08-19'\nsource-format: html\nderived-from: raw/page.html\n---\n",
    );
  });

  it("omits undefined values, such as an unknown origin-url", () => {
    const block = serializeFrontmatter({
      ingested: "2026-08-19",
      "source-format": "md",
      "origin-url": undefined,
    });
    expect(block).not.toContain("origin-url");
  });

  it("round-trips byte-stably, which the hash-after-annotation rule depends on", () => {
    const data = {
      ingested: "2026-08-19",
      "source-format": "html",
      "origin-url": "https://example.com/a/very/long/path?query=1&other=2#fragment",
      "derived-from": "raw/page.html",
    };
    const once = serializeFrontmatter(data);
    const twice = serializeFrontmatter(parseFrontmatter(once).data);
    expect(twice).toBe(once);
  });

  it("adds only the missing keys, leaving the user's bytes verbatim (invariant 7)", () => {
    const existing = "---\ntitle: Mine\n---\nBody.\n";
    expect(ensureFrontmatter(existing, { ingested: "2026-08-19", "source-format": "md" })).toBe(
      "---\ningested: '2026-08-19'\nsource-format: md\ntitle: Mine\n---\nBody.\n",
    );
  });

  it("never re-serializes what the user wrote", () => {
    // A load/dump round trip would delete the comment, restyle the flow
    // sequence, reorder the keys, and turn 010 into 10.
    const existing = "---\n# keep me\ntags: [a, b]\nzip: 010\ntitle: \"Quoted\"\n---\nBody.\n";
    const out = ensureFrontmatter(existing, { ingested: "2026-08-19", "source-format": "md" });

    expect(out).toContain("# keep me");
    expect(out).toContain("tags: [a, b]");
    expect(out).toContain("zip: 010");
    expect(out).toContain('title: "Quoted"');
    expect(out.endsWith("---\nBody.\n")).toBe(true);
  });

  it("leaves a key the user already set alone", () => {
    const existing = "---\nsource-format: html\n---\nBody.\n";
    const out = ensureFrontmatter(existing, { "source-format": "md", ingested: "2026-08-19" });
    expect(out).toContain("source-format: html");
    expect(out).not.toContain("source-format: md");
  });

  it("refuses to touch a block it cannot read, rather than replacing it", () => {
    for (const document of [
      "---\n- one\n- two\n---\nBody.\n",
      "---\nSome text\n---\nMore.\n",
      "---\n: : not: yaml\n\t- x\n---\nBody.\n",
    ]) {
      expect(ensureFrontmatter(document, { ingested: "2026-08-19" })).toBe(document);
    }
  });

  it("fills an empty block", () => {
    expect(ensureFrontmatter("---\n---\nBody.\n", { ingested: "2026-08-19" })).toBe(
      "---\ningested: '2026-08-19'\n---\nBody.\n",
    );
  });

  it("prepends when the document has none", () => {
    const out = ensureFrontmatter("Body.\n", { ingested: "2026-08-19", "source-format": "md" });
    expect(out).toBe("---\ningested: '2026-08-19'\nsource-format: md\n---\nBody.\n");
    expect(ensureFrontmatter(out, { ingested: "2026-08-19", "source-format": "md" })).toBe(out);
  });
});
