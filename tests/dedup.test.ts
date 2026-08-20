import { describe, expect, it } from "vitest";
import { mergeInventories, type SourceInventoryEntry } from "../src/core/compile/dedup";
import type { InventoryItem } from "../src/core/compile/inventory";
import type { PageMeta } from "../src/core/types";

function page(title: string, aliases: string[] = [], kind: PageMeta["kind"] = "concept"): PageMeta {
  return {
    path: `wiki/${kind === "concept" ? "concepts" : "entities"}/${title}.md`,
    title,
    kind,
    aliases,
    summary: "existing summary",
    updated: "2026-08-01",
  };
}

function item(
  title: string,
  kind: InventoryItem["kind"] = "concept",
  aliases: string[] = [],
  summary = "",
): InventoryItem {
  return { title, kind, aliases, summary };
}

function from(sourcePath: string, ...items: InventoryItem[]): SourceInventoryEntry {
  return { sourcePath, items };
}

describe("mergeInventories — matching against the existing table (§6.5, §14)", () => {
  it("matches an item title against an existing page title", () => {
    const work = mergeInventories([page("Personalized PageRank")], [from("raw/a.md", item("Personalized PageRank"))]);

    expect(work.newPages).toEqual([]);
    expect(work.regenerate).toHaveLength(1);
    expect(work.regenerate[0]?.page.title).toBe("Personalized PageRank");
    expect(work.regenerate[0]?.newCiters).toEqual(["raw/a.md"]);
  });

  it("matches an item title against an existing page's alias (§14: alias hit)", () => {
    const work = mergeInventories([page("Personalized PageRank", ["PPR"])], [from("raw/a.md", item("PPR"))]);

    expect(work.newPages).toEqual([]);
    expect(work.regenerate[0]?.page.title).toBe("Personalized PageRank");
  });

  it("matches an item's alias against an existing page title (§14: alias hit, reversed)", () => {
    const work = mergeInventories(
      [page("Personalized PageRank")],
      [from("raw/a.md", item("PPR", "concept", ["Personalized PageRank"]))],
    );

    expect(work.newPages).toEqual([]);
    expect(work.regenerate[0]?.page.title).toBe("Personalized PageRank");
  });

  it("matches case-insensitively", () => {
    const work = mergeInventories([page("Obsidian", [], "entity")], [from("raw/a.md", item("OBSIDIAN", "entity"))]);
    expect(work.regenerate[0]?.page.title).toBe("Obsidian");
  });

  it("ignores kind when matching (§6.5)", () => {
    // The existing page is an entity; the model calls it a concept. Still one page.
    const work = mergeInventories([page("Mercury", [], "entity")], [from("raw/a.md", item("Mercury", "concept"))]);

    expect(work.newPages).toEqual([]);
    expect(work.regenerate[0]?.page.kind).toBe("entity");
  });

  it("prefers the title over the aliases when both would match different pages", () => {
    const pages = [page("Alpha"), page("Beta")];
    const work = mergeInventories(pages, [from("raw/a.md", item("Beta", "concept", ["Alpha"]))]);

    expect(work.regenerate).toHaveLength(1);
    expect(work.regenerate[0]?.page.title).toBe("Beta");
  });

  it("matches a title that only agrees after sanitization", () => {
    // sanitizeTitle strips leading underscores, so "_Mercury" names "Mercury".
    const work = mergeInventories([page("Mercury")], [from("raw/a.md", item("_Mercury"))]);
    expect(work.newPages).toEqual([]);
    expect(work.regenerate[0]?.page.title).toBe("Mercury");
  });
});

describe("mergeInventories — qualified titles (§14: qualified-title collision)", () => {
  const pages = [page("Mercury (element)", ["quicksilver"], "entity")];

  it("matches the qualified title exactly", () => {
    const work = mergeInventories(pages, [from("raw/a.md", item("Mercury (element)", "entity"))]);
    expect(work.newPages).toEqual([]);
    expect(work.regenerate[0]?.page.title).toBe("Mercury (element)");
  });

  it("keeps the unqualified name a separate page when nothing links them", () => {
    // "Mercury" the planet must not collapse into "Mercury (element)".
    const work = mergeInventories(pages, [from("raw/a.md", item("Mercury", "entity"))]);

    expect(work.regenerate).toEqual([]);
    expect(work.newPages).toHaveLength(1);
    expect(work.newPages[0]?.title).toBe("Mercury");
  });

  it("collapses them when the existing page claims the unqualified form as an alias", () => {
    const withAlias = [page("Mercury (element)", ["Mercury"], "entity")];
    const work = mergeInventories(withAlias, [from("raw/a.md", item("Mercury", "entity"))]);

    expect(work.newPages).toEqual([]);
    expect(work.regenerate[0]?.page.title).toBe("Mercury (element)");
  });

  it("gives two different qualifications of one name two pages", () => {
    const work = mergeInventories(
      [],
      [from("raw/a.md", item("Mercury (element)", "entity"), item("Mercury (planet)", "entity"))],
    );
    expect(work.newPages.map((p) => p.title)).toEqual(["Mercury (element)", "Mercury (planet)"]);
  });
});

describe("mergeInventories — new pages within one run", () => {
  it("merges two sources naming the same new thing into one page with two citers", () => {
    const work = mergeInventories(
      [],
      [
        from("raw/a.md", item("Personalized PageRank", "concept", ["PPR"], "From A.")),
        from("raw/b.md", item("PPR", "concept", ["random walk with restart"], "From B.")),
      ],
    );

    expect(work.newPages).toHaveLength(1);
    const created = work.newPages[0];
    expect(created?.title).toBe("Personalized PageRank");
    expect(created?.citers).toEqual(["raw/a.md", "raw/b.md"]);
    // Aliases union; the later mention contributes its new one.
    expect(created?.aliases).toEqual(["PPR", "random walk with restart"]);
    // First encounter fixes the title and kind; the latest summary wins.
    expect(created?.summary).toBe("From B.");
  });

  it("keeps the kind of the first mention", () => {
    const work = mergeInventories(
      [],
      [from("raw/a.md", item("Thing", "entity")), from("raw/b.md", item("Thing", "concept"))],
    );
    expect(work.newPages).toHaveLength(1);
    expect(work.newPages[0]?.kind).toBe("entity");
  });

  it("does not list the same citer twice when one source names a thing twice", () => {
    const work = mergeInventories(
      [],
      [from("raw/a.md", item("Thing"), item("Thing", "concept", ["A thing"]))],
    );
    expect(work.newPages[0]?.citers).toEqual(["raw/a.md"]);
  });

  it("matches through sanitization rather than creating a colliding filename", () => {
    // "Mercury/planet" sanitizes to "Mercuryplanet", which is the existing
    // page's title. Sanitization is what names the file, so matching has to see
    // through it — otherwise the run would queue a second page for one filename.
    const work = mergeInventories(
      [page("Mercuryplanet", [], "entity")],
      [from("raw/a.md", item("Mercury/planet", "entity"))],
    );

    expect(work.newPages).toEqual([]);
    expect(work.regenerate[0]?.page.title).toBe("Mercuryplanet");
  });

  it("never matches a source page, but does not take its filename either", () => {
    // A source page is assembled by code from its own file and has no Call B,
    // so matching one would strand the citer on a page that never regenerates.
    // It still owns its title, so the new page has to take a distinct name.
    const sourcePage: PageMeta = {
      path: "wiki/sources/Mercury.md",
      title: "Mercury",
      kind: "source",
      aliases: [],
      summary: "",
      updated: "",
      source: "raw/Mercury.md",
    };
    const work = mergeInventories([sourcePage], [from("raw/a.md", item("Mercury", "entity"))]);

    expect(work.regenerate).toEqual([]);
    expect(work.newPages).toHaveLength(1);
    expect(work.newPages[0]?.title).toBe("Mercury-2");
  });

  it("treats two titles that sanitize to the same name as one page", () => {
    // Sanitization is what names the file, so "A/B" and "A:B" are one page —
    // creating two would mean two items competing for one filename.
    const work = mergeInventories(
      [],
      [from("raw/a.md", item("A/B", "concept", ["first"]), item("A:B", "concept", ["second"]))],
    );
    expect(work.newPages.map((p) => p.title)).toEqual(["AB"]);
    expect(work.newPages[0]?.aliases).toEqual(["first", "second"]);
  });

  it("avoids titles the caller reserved before the merge", () => {
    // The pipeline names source pages first and passes their titles in, so a
    // concept the model happens to name after a filename cannot collide.
    const work = mergeInventories([], [from("raw/a.md", item("Obsidian", "entity"))], [], new Set(["obsidian"]));
    expect(work.newPages[0]?.title).toBe("Obsidian-2");
  });

  it("still honors existing page titles when the caller reserves others", () => {
    const work = mergeInventories(
      [page("Taken")],
      [from("raw/a.md", item("Taken (thing)", "entity"), item("Other"))],
      [],
      new Set(["other"]),
    );
    // "Taken (thing)" matches nothing and must dodge both the existing page's
    // title space and the reserved one.
    expect(work.newPages.map((p) => p.title)).toEqual(["Taken (thing)", "Other-2"]);
  });

  it("merges a repeated name into the page it created even after suffixing", () => {
    // The first "Mercury" cannot have that filename, so it becomes "Mercury-2".
    // A second source saying "Mercury" must find that page by the name it
    // asked for — otherwise it spawns "Mercury-3", and every later mention
    // spawns another.
    const work = mergeInventories(
      [],
      [from("raw/a.md", item("Mercury", "entity")), from("raw/b.md", item("Mercury", "entity"))],
      [],
      new Set(["mercury"]),
    );

    expect(work.newPages).toHaveLength(1);
    expect(work.newPages[0]?.title).toBe("Mercury-2");
    expect(work.newPages[0]?.citers).toEqual(["raw/a.md", "raw/b.md"]);
  });

  it("resolves an in-run ambiguity by title before alias, like the existing table", () => {
    const work = mergeInventories(
      [],
      [
        from("raw/a.md", item("Alpha"), item("Beta", "concept", ["Gamma"])),
        from("raw/b.md", item("Beta", "concept", ["Alpha"])),
      ],
    );

    // The third item's title matches page Beta and its alias matches page
    // Alpha; the title has to win, or the citer lands on the wrong page.
    expect(work.newPages.map((p) => p.title)).toEqual(["Alpha", "Beta"]);
    expect(work.newPages.find((p) => p.title === "Beta")?.citers).toEqual([
      "raw/a.md",
      "raw/b.md",
    ]);
    expect(work.newPages.find((p) => p.title === "Alpha")?.citers).toEqual(["raw/a.md"]);
  });

  it("collapses case-variant duplicate aliases within one item", () => {
    // Nothing upstream dedupes aliases, so this is the only guard against a
    // model emitting the same handle twice in different cases.
    const work = mergeInventories([], [from("raw/a.md", item("T", "concept", ["PPR", "ppr", "RWR"]))]);
    expect(work.newPages[0]?.aliases).toEqual(["PPR", "RWR"]);
  });

  it("never lets a new page carry its own title as an alias", () => {
    const work = mergeInventories([], [from("raw/a.md", item("Thing", "concept", ["thing", "Other"]))]);
    expect(work.newPages[0]?.aliases).toEqual(["Other"]);
  });
});

describe("mergeInventories — regeneration details", () => {
  it("offers new aliases the page does not already carry, including the matched name", () => {
    const work = mergeInventories(
      [page("Personalized PageRank", ["PPR"])],
      [from("raw/a.md", item("random walk with restart", "concept", ["PPR", "RWR"]))],
    );

    const entry = work.regenerate[0];
    // "PPR" is already an alias; "RWR" and the matched title itself are new.
    expect(entry?.newAliases).toEqual(["random walk with restart", "RWR"]);
  });

  it("does not offer the page's own title as an alias", () => {
    const work = mergeInventories(
      [page("Mercury", ["quicksilver"])],
      [from("raw/a.md", item("mercury", "concept", ["Mercury"]))],
    );
    expect(work.regenerate[0]?.newAliases).toEqual([]);
  });

  it("takes the latest non-empty summary and keeps the old one otherwise", () => {
    const withSummaries = mergeInventories(
      [page("Thing")],
      [from("raw/a.md", item("Thing", "concept", [], "New summary."))],
    );
    expect(withSummaries.regenerate[0]?.newSummary).toBe("New summary.");

    const without = mergeInventories([page("Thing")], [from("raw/a.md", item("Thing"))]);
    expect(without.regenerate[0]?.newSummary).toBe("");
  });

  it("lists a source once even when two of its items hit the same page", () => {
    // One source naming both a page's title and its alias is ordinary model
    // output; citing it twice would show the model the same body twice and
    // write a duplicate citation entry.
    const work = mergeInventories(
      [page("Personalized PageRank", ["PPR"])],
      [from("raw/a.md", item("Personalized PageRank"), item("PPR"))],
    );

    expect(work.regenerate).toHaveLength(1);
    expect(work.regenerate[0]?.newCiters).toEqual(["raw/a.md"]);
  });

  it("takes the last non-empty summary when two sources describe one page", () => {
    const work = mergeInventories(
      [page("Thing")],
      [
        from("raw/a.md", item("Thing", "concept", [], "From A.")),
        from("raw/b.md", item("Thing", "concept", [], "From B.")),
      ],
    );
    // Sources are processed in path order, so "last" is deterministic.
    expect(work.regenerate[0]?.newSummary).toBe("From B.");
  });

  it("queues a requeued page even when no item matched it (§6.5)", () => {
    const cited = page("Cited By Modified");
    const work = mergeInventories([cited], [], [cited.path]);

    expect(work.regenerate).toHaveLength(1);
    expect(work.regenerate[0]?.newCiters).toEqual([]);
  });

  it("merges a requeue and a match into one entry, not two", () => {
    const thing = page("Thing");
    const work = mergeInventories([thing], [from("raw/a.md", item("Thing"))], [thing.path]);

    expect(work.regenerate).toHaveLength(1);
    expect(work.regenerate[0]?.newCiters).toEqual(["raw/a.md"]);
  });

  it("ignores a requeued path that names no page", () => {
    expect(mergeInventories([], [], ["wiki/concepts/Gone.md"]).regenerate).toEqual([]);
  });

  it("lists two sources matching one page as two citers", () => {
    const work = mergeInventories(
      [page("Thing")],
      [from("raw/b.md", item("Thing")), from("raw/a.md", item("Thing"))],
    );
    // Sorted by source path, so the citer order does not depend on completion order.
    expect(work.regenerate[0]?.newCiters).toEqual(["raw/a.md", "raw/b.md"]);
  });
});

describe("mergeInventories — titles that are not plain ASCII", () => {
  it("matches non-ASCII titles case-insensitively", () => {
    const work = mergeInventories(
      [page("Ångström", [], "entity"), page("北京", [], "entity")],
      [from("raw/a.md", item("ångström", "entity"), item("北京", "entity"))],
    );
    expect(work.newPages).toEqual([]);
    expect(work.regenerate.map((r) => r.page.title).sort()).toEqual(["Ångström", "北京"]);
  });

  it("keeps a title made only of emoji rather than losing the page", () => {
    // Surrogate pairs survive sanitization: none of §4's forbidden characters
    // appear in them, so the title is legal and must not collapse to Untitled.
    const work = mergeInventories([], [from("raw/a.md", item("🚀 Launch", "concept"))]);
    expect(work.newPages[0]?.title).toBe("🚀 Launch");
  });

  it("strips every §4 character out of a model title before it becomes a filename", () => {
    const work = mergeInventories([], [from("raw/a.md", item("A[b]c#d^e|f\\g/h:i", "concept"))]);
    expect(work.newPages[0]?.title).toBe("Abcdefghi");
  });

  it("falls back to Untitled rather than producing an unnameable page", () => {
    const work = mergeInventories([], [from("raw/a.md", item("///", "concept"))]);
    expect(work.newPages[0]?.title).toBe("Untitled");
  });

  it("does not match on a title that is only whitespace", () => {
    // `inventory.ts` drops these upstream, but dedup must not match everything
    // to a blank page if one ever reaches it.
    const work = mergeInventories([page("Real")], [from("raw/a.md", item("   ", "concept"))]);
    expect(work.regenerate).toEqual([]);
    expect(work.newPages[0]?.title).toBe("Untitled");
  });
});

describe("mergeInventories — determinism", () => {
  it("produces the same work-set regardless of the order sources finished", () => {
    const pages = [page("Existing", ["ex"])];
    const inventories = [
      from("raw/c.md", item("Gamma", "entity", ["G"])),
      from("raw/a.md", item("Alpha", "concept", ["A"]), item("ex")),
      from("raw/b.md", item("Gamma", "entity", ["Third"])),
    ];

    const forward = mergeInventories(pages, inventories);
    const backward = mergeInventories(pages, [...inventories].reverse());

    expect(backward).toEqual(forward);
    expect(forward.newPages.map((p) => p.title)).toEqual(["Alpha", "Gamma"]);
    expect(forward.newPages[1]?.citers).toEqual(["raw/b.md", "raw/c.md"]);
  });

  it("orders regenerate entries by page path", () => {
    const pages = [page("Zeta"), page("Alpha")];
    const work = mergeInventories(pages, [from("raw/a.md", item("Zeta"), item("Alpha"))]);
    expect(work.regenerate.map((r) => r.page.path)).toEqual([
      "wiki/concepts/Alpha.md",
      "wiki/concepts/Zeta.md",
    ]);
  });

  it("does nothing with no inventories and no requeues", () => {
    expect(mergeInventories([page("A")], [])).toEqual({ newPages: [], regenerate: [] });
  });
});
