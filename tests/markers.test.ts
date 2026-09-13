import { describe, expect, it } from "vitest";
import {
  imageNotFetched,
  linkOutsideRetrievedSet,
  normalizationSuspect,
  repoFileOmitted,
  truncatedForContextBudget,
} from "../src/core/markers";

describe("markers", () => {
  it("matches the fixed wording exactly", () => {
    expect(imageNotFetched("fig3.png", "fetch failed, HTTP 404")).toBe(
      "<!-- image not fetched: fig3.png — fetch failed, HTTP 404 -->",
    );
    expect(repoFileOmitted("src/big.ts", "over 100KB")).toBe(
      "<!-- repo file omitted: src/big.ts — over 100KB -->",
    );
    expect(normalizationSuspect(["running headers", "short output"])).toBe(
      "<!-- normalization suspect: running headers; short output -->",
    );
    expect(truncatedForContextBudget()).toBe("<!-- truncated for context budget -->");
    expect(linkOutsideRetrievedSet("Some Page")).toBe(
      "<!-- link outside retrieved set: Some Page -->",
    );
  });

  it("never says images were removed", () => {
    expect(imageNotFetched("a.png", "too small")).not.toContain("removed");
  });
});

describe("markers stay a single HTML comment (invariant 4)", () => {
  /** Every marker is one comment: exactly one opener and one closer, one line. */
  function isOneComment(marker: string): boolean {
    return (
      marker.startsWith("<!--") &&
      marker.endsWith("-->") &&
      marker.indexOf("-->") === marker.length - 3 &&
      !/[\n\r\u2028\u2029]/.test(marker)
    );
  }

  it("neutralizes a `-->` inside an image name", () => {
    // The name comes from a URL the model or the source document supplied.
    // Left alone it ends the comment early and the rest becomes live markdown:
    // a working wikilink is a graph edge nothing actually cites.
    const marker = imageNotFetched("a-->[[Injected]].png", "fetch failed, network error");

    expect(isOneComment(marker)).toBe(true);
    expect(marker).not.toContain("-->[[Injected]]");
    expect(marker).toContain("network error");
  });

  it("neutralizes a longer run of dashes before the bracket", () => {
    expect(isOneComment(imageNotFetched("a--->b.png", "x"))).toBe(true);
    expect(isOneComment(imageNotFetched("a----->b.png", "x"))).toBe(true);
  });

  it("neutralizes a `-->` in a repo path, which the user names", () => {
    expect(isOneComment(repoFileOmitted("src/a-->b.ts", "over 100KB"))).toBe(true);
  });

  it("keeps a marker on one line whatever line terminator appears", () => {
    for (const terminator of ["\n", "\r\n", "\r", "\u2028", "\u2029"]) {
      const marker = imageNotFetched(`a${terminator}b.png`, `reason${terminator}two`);
      expect(isOneComment(marker), JSON.stringify(terminator)).toBe(true);
    }
  });

  it("leaves an ordinary name completely untouched", () => {
    expect(imageNotFetched("fig-3.png", "under 5KB")).toBe(
      "<!-- image not fetched: fig-3.png — under 5KB -->",
    );
  });

  it("guards the other two interpolating markers as well", () => {
    expect(isOneComment(normalizationSuspect(["a-->b", "c\nd"]))).toBe(true);
    expect(isOneComment(linkOutsideRetrievedSet("Page-->x"))).toBe(true);
  });
});
