// The health check: one vault scan, no model calls.
import { describe, expect, it } from "vitest";
import { HEALTH_PATH, healthCheck } from "../src/core/health";
import { createCore } from "../src/core/index";
import { BusyError } from "../src/core/lock";
import { DEFAULT_SETTINGS } from "../src/core/types";
import { StubHttp } from "./helpers/http";
import { MemFs } from "./helpers/memfs";
import { StubProvider, inventoryReply } from "./helpers/provider";

const MANIFEST = ".obsidian/plugins/luka/ingest-manifest.json";
const NOW = new Date("2026-08-20T10:00:00Z");

function page(kind: string, body: string, extra = ""): string {
  return `---\nkind: ${kind}\n${extra}summary: ''\nupdated: '2026-08-20'\n---\n${body}\n`;
}

const cited = (entries: string[]) =>
  `<!-- citations:start -->\n## Sources\n${entries.map((e) => `- [[${e}]]`).join("\n")}\n<!-- citations:end -->`;

const run = async (fs: MemFs) => {
  await healthCheck({ fs, manifestPath: MANIFEST, now: () => NOW });
  return fs.text(HEALTH_PATH);
};

describe("article candidates", () => {
  it("groups unresolved links by target, most wanted first", async () => {
    // The two orders disagree on purpose: alphabetically "Aardvark" leads, by
    // demand "Zeppelin" does. Names on which the two agree cannot tell the
    // sorts apart, which is what the first version of this test did.
    const fs = new MemFs({
      "wiki/concepts/A.md": page("concept", "Wants [[Zeppelin]] and [[Aardvark]]."),
      "wiki/concepts/B.md": page("concept", "Also wants [[Zeppelin]]."),
      [MANIFEST]: "{}",
    });

    const report = await run(fs);

    expect(report).toContain("## Article candidates");
    expect(report).toContain("- **Zeppelin** — wanted by 2: A, B");
    expect(report).toContain("- **Aardvark** — wanted by 1: A");
    // Most wanted first, so the list reads as a queue of things worth writing.
    expect(report.indexOf("**Zeppelin**")).toBeLessThan(report.indexOf("**Aardvark**"));
  });

  it("groups case variants as one candidate, spelled the way a page would be", async () => {
    // The namespace folds case, so the vault cannot hold both spellings —
    // listing them apart would report two half-wanted articles where there is
    // one wanted twice. The pane shares this grouping, so the two agree.
    const fs = new MemFs({
      "wiki/concepts/A.md": page("concept", "Wants [[zeppelin]]."),
      "wiki/concepts/B.md": page("concept", "Wants [[Zeppelin]]."),
      [MANIFEST]: "{}",
    });

    const report = await run(fs);

    expect(report).toContain("- **Zeppelin** — wanted by 2: A, B");
    expect(report).not.toContain("zeppelin** —");
  });

  it("does not call a resolved link, a source link or a heading reference a candidate", async () => {
    const fs = new MemFs({
      "wiki/concepts/A.md": page("concept", "[[B]] and [[raw/note.md]] and [[B#Section]]."),
      "wiki/concepts/B.md": page("concept", "Body."),
      "raw/note.md": "A source.\n",
      [MANIFEST]: JSON.stringify({ "raw/note.md": { hash: "a" } }),
    });

    expect(await run(fs)).toContain("None — every link resolves.");
  });

  it("resolves an alias, so a page reached by its other name is not a candidate", async () => {
    const fs = new MemFs({
      "wiki/concepts/Personalized PageRank.md": page("concept", "Body.", "aliases:\n  - PPR\n"),
      "wiki/concepts/Other.md": page("concept", "See [[PPR]]."),
      [MANIFEST]: "{}",
    });

    expect(await run(fs)).toContain("None — every link resolves.");
  });
});

describe("orphan pages", () => {
  it("names a page nothing links to and which links to nothing", async () => {
    const fs = new MemFs({
      "wiki/concepts/Linked.md": page("concept", "See [[Other]]."),
      "wiki/concepts/Other.md": page("concept", "Body."),
      "wiki/concepts/Alone.md": page("concept", "Body with no links."),
      [MANIFEST]: "{}",
    });

    const report = await run(fs);

    expect(report).toContain("[[wiki/concepts/Alone.md]]");
    expect(report).not.toContain("[[wiki/concepts/Linked.md]]");
  });

  it("says so when every page is connected", async () => {
    const fs = new MemFs({
      "wiki/concepts/A.md": page("concept", "See [[B]]."),
      "wiki/concepts/B.md": page("concept", "See [[A]]."),
      [MANIFEST]: "{}",
    });

    expect(await run(fs)).toContain("None — every page is connected.");
  });
});

describe("citations without a source", () => {
  it("names a page citing a raw file the manifest does not know", async () => {
    const fs = new MemFs({
      "wiki/sources/note.md": page("source", `Prose.\n${cited(["raw/note.md", "raw/gone.md"])}`),
      "raw/note.md": "A source.\n",
      [MANIFEST]: JSON.stringify({ "raw/note.md": { hash: "a" } }),
    });

    const report = await run(fs);

    expect(report).toContain("cites `raw/gone.md`");
    expect(report).not.toContain("cites `raw/note.md`");
  });

  it("ignores a citation entry that does not name a raw file at all", async () => {
    // Citation entries are free text read off disk, so a hand-edited block can
    // hold anything — `constructor` included. The report asks only about entries
    // "pointing at raw files", and that prefix test runs before the manifest is
    // consulted, so a bare prototype key never reaches the lookup. The
    // `Object.hasOwn` there is therefore belt-and-braces and cannot currently
    // fire; it is kept because it is the right idiom for the question it asks.
    const fs = new MemFs({
      "wiki/sources/odd.md": page("source", `Prose.\n${cited(["constructor", "Some Page"])}`),
      [MANIFEST]: "{}",
    });

    expect(await run(fs)).toContain("None — every cited file is a known source.");
  });
});

describe("filed answers", () => {
  it("lists them with an age taken from their own frontmatter", async () => {
    const fs = new MemFs({
      "raw/answers/2026-08-18-0900 a question.md":
        "---\nkind: answer\nasked: '2026-08-18T09:00:00.000Z'\n---\nAn answer.\n",
      [MANIFEST]: JSON.stringify({ "raw/answers/2026-08-18-0900 a question.md": { hash: "a" } }),
    });

    const report = await run(fs);

    expect(report).toContain("## Filed answers");
    expect(report).toContain("2 days old");
  });

  it("says the age is unknown rather than guessing from the filesystem", async () => {
    // `asked` is when the *question* was asked; a sync or a copy would make an
    // mtime answer a different question entirely.
    const fs = new MemFs({
      "raw/answers/undated.md": "---\nkind: answer\n---\nAn answer.\n",
      [MANIFEST]: JSON.stringify({ "raw/answers/undated.md": { hash: "a" } }),
    });

    expect(await run(fs)).toContain("age unknown");
  });

  it("says so when nothing has been filed", async () => {
    const fs = new MemFs({ [MANIFEST]: "{}" });

    expect(await run(fs)).toContain("None yet");
  });
});

describe("the report itself", () => {
  it("counts sources, pages by kind, and the graph", async () => {
    const fs = new MemFs({
      "wiki/concepts/A.md": page("concept", "Body."),
      "wiki/entities/B.md": page("entity", "See [[A]]."),
      "raw/note.md": "A source.\n",
      [MANIFEST]: JSON.stringify({ "raw/note.md": { hash: "a" } }),
    });

    const report = await run(fs);

    expect(report).toContain("- sources in the manifest: 1");
    expect(report).toContain("wiki pages: 2 (0 source, 1 entity, 1 concept)");
    expect(report).toMatch(/- graph: \d+ nodes, \d+ edges/);
  });

  it("is rewritten wholesale, so a stale section cannot survive", async () => {
    const fs = new MemFs({
      "wiki/concepts/A.md": page("concept", "Wants [[Nowhere]]."),
      [MANIFEST]: "{}",
    });
    await run(fs);
    expect(fs.text(HEALTH_PATH)).toContain("**Nowhere**");

    // The link is resolved by writing the page it wanted.
    await fs.write("wiki/concepts/Nowhere.md", page("concept", "Body."));
    const second = await run(fs);

    expect(second).not.toContain("**Nowhere**");
    expect(second).toContain("None — every link resolves.");
  });

  it("is `_`-prefixed, so it is never a node or a candidate (invariant 8)", async () => {
    const fs = new MemFs({
      "wiki/concepts/A.md": page("concept", "Body."),
      [MANIFEST]: "{}",
    });

    await run(fs);
    const second = await run(fs);

    // The report links to pages; if it were a node those links would be edges,
    // and it would list itself as an orphan.
    expect(second).not.toContain("_health");
    expect(HEALTH_PATH.split("/").pop()?.startsWith("_")).toBe(true);
  });
});

describe("the lock and the model (invariant 2)", () => {
  it("asks the model nothing", async () => {
    const fs = new MemFs({ "raw/note.md": "PageRank matters.\n" });
    const provider = new StubProvider((request) =>
      request.task === "page-generation"
        ? "Prose."
        : inventoryReply("A note.", [{ title: "PageRank", kind: "concept" }]),
    );
    const core = createCore({
      fs,
      http: new StubHttp({}),
      manifestPath: MANIFEST,
      settings: { ...DEFAULT_SETTINGS, apiKey: "k" },
      now: () => NOW,
      provider,
    });
    await core.compile();
    const spent = provider.stats().requests;

    await core.healthCheck();

    expect(provider.stats().requests).toBe(spent);
  });

  it("refuses to run while a compile holds the lock", async () => {
    const fs = new MemFs({ "raw/note.md": "Body.\n" });
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = new StubProvider(async (request) => {
      if (request.task === "inventory") await held;
      return inventoryReply("A note.", []);
    });
    const core = createCore({
      fs,
      http: new StubHttp({}),
      manifestPath: MANIFEST,
      settings: { ...DEFAULT_SETTINGS, apiKey: "k" },
      now: () => NOW,
      provider,
    });

    const compiling = core.compile();
    const refused = await core.healthCheck().catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(BusyError);
    expect((refused as BusyError).message).toBe("Luka is busy: compile");
    release();
    await compiling;
  });
});
