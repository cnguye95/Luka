import { describe, expect, it } from "vitest";
import {
  imageNotFetched,
  linkOutsideRetrievedSet,
  normalizationSuspect,
  repoFileOmitted,
  truncatedForContextBudget,
} from "../src/core/markers";

describe("markers", () => {
  it("matches the §4 wording exactly", () => {
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
