// "What to add next", to the extent it can be tested without Obsidian.
//
// §14 puts the `ItemView` on the README checklist, and it genuinely belongs
// there: lifecycle, `createSvg` and `setIcon` need a host. What does not is the
// wording and the geometry, so both were written with no Obsidian import and no
// DOM access — the same split `sim.ts` and `render.ts` made for §9's pane.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildCards,
  matchesCard,
  nextDismissed,
  statusLine,
  toCardView,
} from "../src/plugin/gaps-view/cards";
import { GLYPH_SIZE, RING_CAP, glyphShapes, radialLayout } from "../src/plugin/gaps-view/layout";
import type { GapCard, GapReport } from "../src/core/index";

const article = (over: Partial<GapCard> = {}): GapCard => ({
  kind: "article",
  key: "article\nzeppelin\nwiki/concepts/A.md",
  title: "Zeppelin",
  citers: [
    { path: "wiki/concepts/A.md", title: "A" },
    { path: "wiki/concepts/B.md", title: "B" },
  ],
  demand: 2,
  weight: 6,
  demoted: false,
  ...over,
});

const thin = (over: Partial<GapCard> = {}): GapCard => ({
  kind: "thin",
  key: "thin\nwiki/concepts/One.md\nraw/note.md",
  title: "One",
  path: "wiki/concepts/One.md",
  citers: [{ path: "raw/note.md", title: "note.md" }],
  demand: 1,
  weight: 3,
  demoted: false,
  citation: "raw/note.md",
  ...over,
});

const reportOf = (cards: GapCard[], unreadable = 0): GapReport => ({ cards, unreadable });

describe("what a card says", () => {
  it("puts the demand in the bold slot, and names the pages that want it", () => {
    // §8's reading-effort rule: one bolded number per line. The number is
    // rendered as its own element, so it is a number rather than markup in a
    // string built from a model-written title.
    const view = toCardView(article());

    expect(view.reason.before).toBe("Wanted by ");
    expect(view.reason.number).toBe("2");
    expect(view.reason.after).toBe(" pages that link to nothing: A, B.");
  });

  it("says the same number on the chip as in the sentence", () => {
    const view = toCardView(article({ demand: 5 }));

    expect(view.reason.number).toBe("5");
    expect(view.chip).toBe("+5 connections");
  });

  it("marks a demoted card as low confidence rather than hiding why", () => {
    expect(toCardView(article({ demoted: true })).chip).toBe("+2 connections · low confidence");
  });

  it("names the one source a thin page rests on", () => {
    const view = toCardView(thin());

    expect(view.reason).toEqual({ before: "Rests on ", number: "1", after: " source: raw/note.md." });
    expect(view.chip).toBe("+1 source");
  });

  it("prefills a question the answer can confirm or dissolve", () => {
    expect(toCardView(article()).askPrefill).toBe("What does the wiki say about Zeppelin?");
    expect(toCardView(thin()).askPrefill).toBe("What else does the wiki know about One?");
  });

  it("builds a search from the gap and at most three of the pages wanting it", () => {
    const many = article({
      citers: ["A", "B", "C", "D"].map((title) => ({ path: `wiki/concepts/${title}.md`, title })),
      demand: 4,
    });

    expect(toCardView(many).searchQuery).toBe("Zeppelin A B C");
  });

  it("uses different icons for the two kinds, so the type reads before the text", () => {
    expect(toCardView(article()).icon).not.toBe(toCardView(thin()).icon);
  });
});

describe("the filter", () => {
  it("matches title, citing page, citation and path, case-insensitively", () => {
    expect(matchesCard(article(), "zEppEl")).toBe(true);
    expect(matchesCard(article(), "b")).toBe(true);
    expect(matchesCard(thin(), "NOTE.MD")).toBe(true);
    expect(matchesCard(thin(), "wiki/concepts")).toBe(true);
    expect(matchesCard(article(), "photosynthesis")).toBe(false);
  });

  it("matches everything when empty or blank", () => {
    expect(matchesCard(article(), "")).toBe(true);
    expect(matchesCard(article(), "   ")).toBe(true);
  });
});

describe("which cards are shown", () => {
  it("hides a dismissed card and keeps the rest", () => {
    const report = reportOf([article(), thin()]);

    const shown = buildCards(report, [article().key], "");

    expect(shown.map((card) => card.title)).toEqual(["One"]);
  });

  it("never re-sorts: core's order is the answer", () => {
    // The ranking is core's, explainable in one sentence and pinned by its own
    // tests. A second opinion here would be a second ranking nobody wrote down.
    const report = reportOf([
      article({ key: "k1", title: "Low", weight: 0, demand: 2 }),
      article({ key: "k2", title: "High", weight: 99, demand: 9 }),
    ]);

    expect(buildCards(report, [], "").map((card) => card.title)).toEqual(["Low", "High"]);
  });

  it("applies the filter and the dismissals together", () => {
    // Three cards, and each of the two rules removes a different one: the
    // dismissal takes Aardvark, the filter takes the thin card.
    const report = reportOf([article(), article({ key: "k2", title: "Aardvark" }), thin()]);

    expect(buildCards(report, ["k2"], "zep").map((card) => card.title)).toEqual(["Zeppelin"]);
  });
});

describe("dismissals", () => {
  it("adds the key once, however many times it is dismissed", () => {
    const report = reportOf([article(), thin()]);

    const once = nextDismissed(report, [], article().key);

    expect(once).toEqual([article().key]);
    expect(nextDismissed(report, once, article().key)).toEqual([article().key]);
  });

  it("drops keys the report no longer has, so data.json cannot grow forever", () => {
    // A gap that is gone — the article was written — describes nothing, and
    // keeping its key would suppress a card that no longer exists anyway.
    const report = reportOf([article(), thin()]);

    expect(nextDismissed(report, ["stale\nkey", thin().key], article().key)).toEqual([
      thin().key,
      article().key,
    ]);
  });
});

describe("the status line", () => {
  it("counts suggestions, and says nothing else when there is nothing else", () => {
    expect(statusLine({ matched: 4, shown: 4, dismissed: 0, unreadable: 0 })).toBe("4 suggestions");
    expect(statusLine({ matched: 1, shown: 1, dismissed: 0, unreadable: 0 })).toBe("1 suggestion");
  });

  it("says how many are held back, dismissed, or unread", () => {
    expect(statusLine({ matched: 60, shown: 40, dismissed: 2, unreadable: 1 })).toBe(
      "60 suggestions · showing 40 · 2 dismissed · 1 page could not be read",
    );
  });
});

describe("the glyph's geometry", () => {
  it("puts the ghost at the centre and every ring node one radius from it", () => {
    const layout = radialLayout(5, { size: 100, cap: RING_CAP });

    expect(layout.centre).toEqual({ x: 50, y: 50 });
    const radii = layout.ring.map((p) => Math.hypot(p.x - 50, p.y - 50));
    for (const radius of radii) expect(radius).toBeCloseTo(36, 6);
  });

  it("starts at the top and spaces the ring evenly", () => {
    // Twelve o'clock first, so the commonest case — two pages wanting one
    // article — is symmetric rather than tilted.
    const layout = radialLayout(4, { size: 100, cap: RING_CAP });

    expect(layout.ring[0]?.x).toBeCloseTo(50, 6);
    expect(layout.ring[0]?.y).toBeCloseTo(14, 6);
    const angles = layout.ring.map((p) => Math.atan2(p.y - 50, p.x - 50));
    for (let at = 1; at < angles.length; at++) {
      const step = (angles[at] as number) - (angles[at - 1] as number);
      expect(((step % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)).toBeCloseTo(Math.PI / 2, 6);
    }
  });

  it("caps the ring and reports what it could not draw", () => {
    const layout = radialLayout(12, { size: GLYPH_SIZE, cap: RING_CAP });

    expect(layout.ring).toHaveLength(RING_CAP);
    expect(layout.overflow).toBe(4);
  });

  it("draws nothing at all for a gap nothing wants", () => {
    const layout = radialLayout(0, { size: GLYPH_SIZE, cap: RING_CAP });

    expect(layout.ring).toEqual([]);
    expect(layout.overflow).toBe(0);
  });

  it("is the same picture every time it is drawn", () => {
    const once = radialLayout(6, { size: GLYPH_SIZE, cap: RING_CAP });

    expect(radialLayout(6, { size: GLYPH_SIZE, cap: RING_CAP })).toEqual(once);
  });
});

describe("the glyph's shapes", () => {
  const layoutOf = (count: number) => radialLayout(count, { size: GLYPH_SIZE, cap: RING_CAP });

  it("takes every colour from a CSS variable with the graph pane's fallback", () => {
    // A bare `var(--color-blue)` renders as nothing in a theme that does not
    // define it, which is why `render.ts` carries hex fallbacks. The card
    // borrows the same ones, so both panes agree on what a concept looks like.
    const palette = new Set(["#6b6b6b", "#9a9a9a", "#7f6df2", "#5b8def"]);
    const shapes = [
      ...glyphShapes("article", ["A", "B"], layoutOf(2)),
      ...glyphShapes("thin", ["note.md"], layoutOf(1)),
    ];

    const colours = shapes.flatMap((shape) =>
      [shape.attr["fill"], shape.attr["stroke"]].filter(
        (value): value is string => value !== undefined && value !== "none",
      ),
    );

    expect(colours.length).toBeGreaterThan(0);
    for (const colour of colours) {
      const match = /^var\((--[a-z-]+), (#[0-9a-f]{6})\)$/.exec(colour);
      expect(match, colour).not.toBeNull();
      expect(palette).toContain(match?.[2]);
    }
  });

  it("draws the article's centre as a dashed outline, because it is not there yet", () => {
    const centre = glyphShapes("article", ["A"], layoutOf(1)).find(
      (shape) => shape.tag === "circle" && shape.attr["r"] === "7",
    );

    expect(centre?.attr["fill"]).toBe("none");
    expect(centre?.attr["stroke-dasharray"]).toBe("3 2");
  });

  it("fills the thin page's centre, because that page does exist", () => {
    const centre = glyphShapes("thin", ["note.md"], layoutOf(1)).find(
      (shape) => shape.tag === "circle" && shape.attr["r"] === "7",
    );

    expect(centre?.attr["fill"]).not.toBe("none");
    expect(centre?.attr["stroke-dasharray"]).toBeUndefined();
  });

  it("dashes an article's edges and leaves a thin card's solid", () => {
    // Dashed means "what the vault gains when you add this" — for an article
    // the edges do not exist yet either; a thin page's one source is real.
    const dashed = glyphShapes("article", ["A"], layoutOf(1)).filter((s) => s.tag === "line");
    const solid = glyphShapes("thin", ["note.md"], layoutOf(1)).filter((s) => s.tag === "line");

    expect(dashed[0]?.attr["stroke-dasharray"]).toBe("3 2");
    expect(solid[0]?.attr["stroke-dasharray"]).toBeUndefined();
  });

  it("names every ring node, so hovering says which page it is", () => {
    const nodes = glyphShapes("article", ["Alpha", "Beta"], layoutOf(2)).filter(
      (shape) => shape.tag === "circle" && shape.attr["r"] === "4",
    );

    expect(nodes.map((shape) => shape.title)).toEqual(["Alpha", "Beta"]);
  });

  it("adds a '+k more' label only when the ring could not show everything", () => {
    const few = glyphShapes("article", ["A"], layoutOf(1));
    const many = glyphShapes(
      "article",
      Array.from({ length: 11 }, (_, at) => `P${String(at)}`),
      layoutOf(11),
    );

    expect(few.some((shape) => shape.tag === "text")).toBe(false);
    expect(many.find((shape) => shape.tag === "text")?.text).toBe("+3 more");
  });

  it("draws edges before nodes, so a node is never under a line", () => {
    const shapes = glyphShapes("article", ["A", "B"], layoutOf(2));
    const lastLine = shapes.map((s) => s.tag).lastIndexOf("line");
    const firstCircle = shapes.map((s) => s.tag).indexOf("circle");

    expect(lastLine).toBeLessThan(firstCircle);
  });
});

describe("the pure modules are pure", () => {
  it("import nothing from obsidian at runtime", () => {
    // vitest runs in a node environment where a value import from `obsidian`
    // does not resolve. Nothing enforces this — `check:boundary` walks
    // `src/core` only — so the rule is asserted here instead.
    for (const file of ["cards.ts", "layout.ts"]) {
      const source = readFileSync(`src/plugin/gaps-view/${file}`, "utf8");
      for (const line of source.split("\n")) {
        if (!line.includes('from "obsidian"')) continue;
        expect(line, `${file}: ${line}`).toContain("import type");
      }
    }
  });
});
