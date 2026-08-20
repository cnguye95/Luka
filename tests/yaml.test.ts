import { describe, expect, it } from "vitest";
import { ensureFrontmatter, parseFrontmatter, serializeFrontmatter } from "../src/core/yaml";

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

  it("treats a malformed block as present with no keys", () => {
    const parsed = parseFrontmatter("---\n: : not: yaml\n\t- x\n---\nBody.\n");
    expect(parsed.present).toBe(true);
    expect(parsed.data).toEqual({});
    expect(parsed.body).toBe("Body.\n");
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

  it("does not rewrite a document that already has frontmatter (invariant 7)", () => {
    const existing = "---\ntitle: Mine\n---\nBody.\n";
    expect(ensureFrontmatter(existing, { ingested: "2026-08-19" })).toBe(existing);
  });

  it("prepends when the document has none", () => {
    const out = ensureFrontmatter("Body.\n", { ingested: "2026-08-19", "source-format": "md" });
    expect(out).toBe("---\ningested: '2026-08-19'\nsource-format: md\n---\nBody.\n");
    expect(ensureFrontmatter(out, { ingested: "2026-08-19", "source-format": "md" })).toBe(out);
  });
});
