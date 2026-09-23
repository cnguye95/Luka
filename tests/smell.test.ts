// The PDF extraction smell heuristics, each threshold pinned at its boundary
// and the reason list pinned in order, since those strings become marker text.
import { describe, expect, it } from "vitest";
import { smellPdfExtraction } from "../src/core/normalize/smell";

/**
 * A page of clean prose: long enough, sentences terminated, and — importantly —
 * sharing no line with any other page, so the running-header test has nothing
 * to find unless a test puts something there deliberately.
 */
function prosePage(marker: string): string {
  return [
    `${marker} opens with a claim about retrieval and then defends it.`,
    `${marker} says Personalized PageRank ranks the neighbourhood of a seed set.`,
    `${marker} notes the walk restarts with one minus the damping factor.`,
    `${marker} adds that degree-zero nodes hold teleport mass and propagate none.`,
    `${marker} exists so that the page clears the characters-per-page floor.`,
  ].join("\n");
}

describe("smellPdfExtraction", () => {
  it("passes a clean multi-page extraction", () => {
    expect(smellPdfExtraction({ pages: [prosePage("One"), prosePage("Two")], pageCount: 2 })).toEqual(
      [],
    );
  });

  it("flags output too short for the page count", () => {
    const reasons = smellPdfExtraction({ pages: ["A stub.", "Another stub."], pageCount: 12 });
    expect(reasons).toContain("short output for 12 pages");
  });

  it("does not flag length when the pages are full", () => {
    const pages = [prosePage("One"), prosePage("Two"), prosePage("Three")];
    expect(smellPdfExtraction({ pages, pageCount: 3 }).join()).not.toContain("short output");
  });

  it("flags a running header once it appears on three pages", () => {
    const header = "Journal of Graph Retrieval, Vol 12";
    const two = [`${header}\n${prosePage("One")}`, `${header}\n${prosePage("Two")}`];
    expect(smellPdfExtraction({ pages: two, pageCount: 2 }).join()).not.toContain("repeated line");

    const three = [...two, `${header}\n${prosePage("Three")}`];
    expect(smellPdfExtraction({ pages: three, pageCount: 3 })).toContain("repeated line on 3 pages");
  });

  it("ignores a line repeated many times on a single page", () => {
    const page = `${prosePage("One")}\n${Array(6).fill("ditto ditto").join("\n")}`;
    expect(smellPdfExtraction({ pages: [page, prosePage("Two")], pageCount: 2 }).join()).not.toContain(
      "repeated line",
    );
  });

  it("ignores short repeated lines, which repeat innocently", () => {
    const pages = ["12\n" + prosePage("One"), "12\n" + prosePage("Two"), "12\n" + prosePage("Three")];
    expect(smellPdfExtraction({ pages, pageCount: 3 }).join()).not.toContain("repeated line");
  });

  it("flags a high fragment ratio once there is enough text to judge", () => {
    const fragments = Array.from({ length: 24 }, (_, i) => `column header ${i}`).join("\n");
    expect(smellPdfExtraction({ pages: [fragments], pageCount: 1 }).join()).toContain(
      "high sentence-fragment ratio",
    );
  });

  it("does not judge the fragment ratio on a short document", () => {
    const few = Array.from({ length: 8 }, (_, i) => `fragment ${i}`).join("\n");
    expect(smellPdfExtraction({ pages: [few], pageCount: 1 }).join()).not.toContain("fragment ratio");
  });

  it("does not flag terminated prose as fragmentary", () => {
    const pages = [prosePage("One"), prosePage("Two"), prosePage("Three"), prosePage("Four")];
    expect(smellPdfExtraction({ pages, pageCount: 4 }).join()).not.toContain("fragment ratio");
  });

  it("returns nothing for an empty extraction rather than dividing by zero", () => {
    expect(smellPdfExtraction({ pages: [], pageCount: 0 })).toEqual([]);
  });

  it("reports the same count whichever of two equally-repeated lines is found first", () => {
    // The marker names a count, never a line, so two lines repeating equally
    // often must not make the result depend on which one the scan met first.
    const zebraFirst = ["zebra line\nalpha line", "zebra line\nalpha line", "zebra line\nalpha line"];
    const alphaFirst = ["alpha line\nzebra line", "alpha line\nzebra line", "alpha line\nzebra line"];

    expect(smellPdfExtraction({ pages: zebraFirst, pageCount: 3 })).toEqual(
      smellPdfExtraction({ pages: alphaFirst, pageCount: 3 }),
    );
    expect(smellPdfExtraction({ pages: zebraFirst, pageCount: 3 })).toContain(
      "repeated line on 3 pages",
    );
  });
});

describe("smellPdfExtraction — each threshold at its boundary", () => {
  /** A page of exactly `chars` characters, on one terminated line. */
  function page(chars: number): string {
    return `${"x".repeat(Math.max(0, chars - 1))}.`;
  }

  it("flags at 199 characters per page and clears at 200", () => {
    const under = smellPdfExtraction({ pages: [page(199)], pageCount: 1 });
    const at = smellPdfExtraction({ pages: [page(200)], pageCount: 1 });

    expect(under).toContain("short output for 1 page");
    expect(at.join()).not.toContain("short output");
  });

  it("averages across pages rather than judging each one", () => {
    // 100 + 300 = 400 over two pages is exactly 200 each: not short.
    const pages = [page(100), page(300)];
    expect(smellPdfExtraction({ pages, pageCount: 2 }).join()).not.toContain("short output");
  });

  it("needs 20 lines before it will judge the fragment ratio", () => {
    const fragments = (n: number) => Array.from({ length: n }, (_, i) => `fragment ${i}`).join("\n");

    expect(smellPdfExtraction({ pages: [fragments(19)], pageCount: 1 }).join()).not.toContain(
      "fragment ratio",
    );
    expect(smellPdfExtraction({ pages: [fragments(20)], pageCount: 1 }).join()).toContain(
      "fragment ratio",
    );
  });

  it("flags above 60% fragments, not at exactly 60%", () => {
    // 20 lines: 12 fragments is exactly 0.6 (clean), 13 is above it (flagged).
    const mix = (fragments: number) =>
      [
        ...Array.from({ length: fragments }, (_, i) => `fragment ${i}`),
        ...Array.from({ length: 20 - fragments }, (_, i) => `A finished sentence ${i}.`),
      ].join("\n");

    expect(smellPdfExtraction({ pages: [mix(12)], pageCount: 1 }).join()).not.toContain(
      "fragment ratio",
    );
    expect(smellPdfExtraction({ pages: [mix(13)], pageCount: 1 }).join()).toContain(
      "fragment ratio",
    );
  });

  it("ignores a repeated line of 3 characters and catches one of 4", () => {
    const withHeader = (header: string) => [
      `${header}\n${prosePage("One")}`,
      `${header}\n${prosePage("Two")}`,
      `${header}\n${prosePage("Three")}`,
    ];

    expect(smellPdfExtraction({ pages: withHeader("abc"), pageCount: 3 }).join()).not.toContain(
      "repeated line",
    );
    expect(smellPdfExtraction({ pages: withHeader("abcd"), pageCount: 3 }).join()).toContain(
      "repeated line",
    );
  });
});

describe("smellPdfExtraction — reason order (the marker text)", () => {
  it("reports every reason it finds, in a fixed order", () => {
    // A short document of repeated fragments trips all three heuristics at once.
    const line = "column header";
    const pages = [
      Array.from({ length: 8 }, () => line).join("\n"),
      Array.from({ length: 8 }, () => line).join("\n"),
      Array.from({ length: 8 }, () => line).join("\n"),
    ];

    const reasons = smellPdfExtraction({ pages, pageCount: 3 });
    expect(reasons).toEqual([
      "short output for 3 pages",
      "repeated line on 3 pages",
      "high sentence-fragment ratio (100%)",
    ]);
  });
});
