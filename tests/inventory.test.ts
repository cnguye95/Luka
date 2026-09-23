// Call A: the inventory prompt, and what `takeInventory` makes of the reply. A
// fenced reply parses without spending the one repair retry, and every field
// that goes on to name a file or sit in frontmatter is flattened first
// (invariant 5).
import { describe, expect, it } from "vitest";
import { bodyOf, takeInventory } from "../src/core/compile/inventory";
import { MAX_TOKENS_BY_TASK } from "../src/core/provider/types";
import { StubProvider, inventoryReply } from "./helpers/provider";

describe("Call A — inventory", () => {
  it("carries the instructions the prompt is required to give", async () => {
    const provider = new StubProvider(() => inventoryReply("A summary."));
    await takeInventory(provider, "Body text.");

    const call = provider.callsFor("inventory")[0];
    // A JSON task reaches transport at temperature 0, under the
    // task's own max_tokens cap. Both are the wrapper's doing, observed here
    // at the layer that would actually send them.
    expect(call?.temperature).toBe(0);
    expect(call?.maxTokens).toBe(MAX_TOKENS_BY_TASK.inventory);
    // "Qualified titles for ambiguous names ('Mercury (element)')".
    expect(call?.system).toContain("Mercury (element)");
    // "Aliases include obvious variants".
    expect(call?.system.toLowerCase()).toContain("variants");
    // The output shape is fixed exactly; every key has to be asked for by
    // name or the model has no way to know the schema.
    const system = call?.system ?? "";
    for (const key of ["source_summary", "items", "title", "kind", "aliases", "summary"]) {
      expect(system, `prompt never names ${key}`).toContain(key);
    }
    expect(system).toContain('"entity"');
    expect(system).toContain('"concept"');
    // A source worth no pages must be expressible, or the model invents some.
    expect(system.toLowerCase()).toContain("empty items list");
  });

  it("sends the body only, never the frontmatter", async () => {
    const provider = new StubProvider(() => inventoryReply("s"));
    const document = "---\ningested: '2026-08-20'\nsource-format: md\n---\nThe real body.\n";

    await takeInventory(provider, bodyOf(document));

    const user = provider.callsFor("inventory")[0]?.user ?? "";
    expect(user).toBe("The real body.\n");
    expect(user).not.toContain("source-format");
  });

  it("costs exactly one model call", async () => {
    const provider = new StubProvider(() => inventoryReply("s"));
    await takeInventory(provider, "Body.");
    expect(provider.stats().byTask.inventory).toBe(1);
  });

  it("returns the documented shape", async () => {
    const provider = new StubProvider(() =>
      inventoryReply("About PageRank.", [
        { title: "Personalized PageRank", kind: "concept", aliases: ["PPR"], summary: "A walk." },
      ]),
    );

    await expect(takeInventory(provider, "Body.")).resolves.toEqual({
      sourceSummary: "About PageRank.",
      items: [
        {
          title: "Personalized PageRank",
          kind: "concept",
          aliases: ["PPR"],
          summary: "A walk.",
        },
      ],
    });
  });

  it("parses a fenced reply directly, without spending the repair retry", async () => {
    // The single most common real failure: a model that fences its JSON. The
    // repair retry was the original answer to it and is not one on its own,
    // because it re-asks the same model — `claude-haiku-4-5-20251001` fences
    // the repair reply too, which failed all seven sources of a real compile
    // and wrote no manifest at all.
    //
    // The stub fences *every* reply, which is what discriminates: under the
    // repair-only reading it exhausts the retry and throws. An earlier version
    // of this test scripted the stub to comply on the second call, so it
    // asserted that recovery works when the model cooperates and could not
    // fail when it does not.
    const provider = new StubProvider(
      () => "```json\n" + JSON.stringify(inventoryReply("fenced")) + "\n```",
    );

    await expect(takeInventory(provider, "Body.")).resolves.toMatchObject({
      sourceSummary: "fenced",
    });
    expect(provider.stats().byTask.inventory).toBe(1);
  });

  it("still repairs a reply that is neither JSON nor a fence", async () => {
    // Stripping must not cost the repair its remaining job: a reply that is
    // prose has nothing to strip and still gets the one re-ask it is owed.
    const provider = new StubProvider((_request, index) =>
      index === 0 ? "Here is the inventory you asked for:" : inventoryReply("recovered"),
    );

    await expect(takeInventory(provider, "Body.")).resolves.toMatchObject({
      sourceSummary: "recovered",
    });
    expect(provider.stats().byTask.inventory).toBe(2);
  });

  it("strips a fence from the repair reply too", async () => {
    // Both parses go through the same unwrapping, or a model that answers with
    // prose first and a fence second fails for the reason the fence was meant
    // to stop mattering.
    const provider = new StubProvider((_request, index) =>
      index === 0
        ? "Sorry — here it is:"
        : "```\n" + JSON.stringify(inventoryReply("repaired")) + "\n```",
    );

    await expect(takeInventory(provider, "Body.")).resolves.toMatchObject({
      sourceSummary: "repaired",
    });
    expect(provider.stats().byTask.inventory).toBe(2);
  });

  it("gives up after one repair retry rather than looping", async () => {
    const provider = new StubProvider(() => "not json at all");

    await expect(takeInventory(provider, "Body.")).rejects.toThrow(/not valid JSON/);
    expect(provider.stats().byTask.inventory).toBe(2);
  });

  it("throws when the reply is not the documented shape, so the source retries", async () => {
    for (const reply of [
      "not an object",
      [],
      null,
      { items: [] },
      { source_summary: "s" },
      { source_summary: 42, items: [] },
      { source_summary: "s", items: "nope" },
    ]) {
      const provider = new StubProvider(() => reply);
      await expect(takeInventory(provider, "Body.")).rejects.toThrow();
    }
  });

  it("drops malformed items rather than failing the whole source", async () => {
    const provider = new StubProvider(() => ({
      source_summary: "s",
      items: [
        { title: "Good", kind: "concept", aliases: [], summary: "" },
        { title: "", kind: "concept" },
        { title: "No kind" },
        { title: "Bad kind", kind: "source" },
        { title: "Also good", kind: "entity" },
        "not an object",
        null,
      ],
    }));

    const result = await takeInventory(provider, "Body.");
    expect(result.items.map((item) => item.title)).toEqual(["Good", "Also good"]);
  });

  it("coerces alias shapes a model actually produces", async () => {
    const provider = new StubProvider(() => ({
      source_summary: "s",
      items: [
        { title: "Bare", kind: "entity", aliases: "Solo" },
        { title: "Junk", kind: "entity", aliases: ["  Real  ", "", 42, null] },
        { title: "Missing", kind: "entity" },
      ],
    }));

    const items = await takeInventory(provider, "Body.");
    expect(items.items.map((item) => item.aliases)).toEqual([["Solo"], ["Real"], []]);
  });

  it("flattens multi-line summaries, which reach the index (invariant 5)", async () => {
    const provider = new StubProvider(() => ({
      source_summary: "First line.\n## Injected\n- [[Ghost]]",
      items: [{ title: "T", kind: "concept", aliases: [], summary: "Two\nlines" }],
    }));

    const result = await takeInventory(provider, "Body.");
    expect(result.sourceSummary).not.toContain("\n");
    expect(result.items[0]?.summary).toBe("Two lines");
  });

  it("flattens titles and aliases too — both reach page frontmatter (invariant 5)", async () => {
    // An alias with a newline serializes as a YAML block scalar, which would
    // let the model determine the structure of a block code owns. The title
    // becomes a filename, an index entry and a [[link]].
    const provider = new StubProvider(() => ({
      source_summary: "s",
      items: [
        { title: "Bad\nTitle", kind: "entity", aliases: ["a\nb", "  c\td  "] },
        { title: "Ok", kind: "concept", aliases: "one\ntwo" },
      ],
    }));

    const { items } = await takeInventory(provider, "Body.");
    expect(items[0]?.title).toBe("Bad Title");
    expect(items[0]?.aliases).toEqual(["a b", "c d"]);
    expect(items[1]?.aliases).toEqual(["one two"]);
    for (const item of items) {
      expect(item.title).not.toContain("\n");
      for (const alias of item.aliases) expect(alias).not.toContain("\n");
    }
  });
});

describe("bodyOf", () => {
  it("returns the whole document when there is no frontmatter", () => {
    expect(bodyOf("Just prose.\n")).toBe("Just prose.\n");
  });
});
