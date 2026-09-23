// `ask` end to end, over an in-memory vault with a stub
// provider at the wrapper layer.
//
// The invariants that only become observable here: 2 (the lock refuses a
// second operation), 5 (code writes everything but the prose), 9 (the API key
// never reaches the vault), 11 (the note is written on success only), and 12
// (ask ≤ 3 model calls).
import { describe, expect, it } from "vitest";
import {
  createCore,
  parseTrace,
  resolveTraceNodes,
  type CompletionRequest,
  type CoreDeps,
  type Trace,
} from "../src/core/index";
import { decodeUtf8 } from "../src/core/hash";
import { estimateTokens } from "../src/core/tokens";
import { parseFrontmatter } from "../src/core/yaml";
import { linkTargets } from "../src/core/compile/links";
import { BusyError } from "../src/core/lock";
import { DEFAULT_SETTINGS } from "../src/core/types";
import { StubHttp } from "./helpers/http";
import { MemFs } from "./helpers/memfs";
import { StubProvider, fatalError, inventoryReply, retryableError } from "./helpers/provider";

const MANIFEST = ".obsidian/plugins/luka/ingest-manifest.json";

/** A trace list field's entries — one to a line, under the field name. */
function traceList(note: string, field: "seeds" | "top"): string[] {
  const lines = note.split("\n");
  const at = lines.indexOf(`- ${field}:`);
  if (at === -1) return [];
  const out: string[] = [];
  for (const line of lines.slice(at + 1)) {
    const item = /^\s+-\s+(.+)$/.exec(line);
    if (item === null) break;
    out.push((item[1] as string).trim());
  }
  return out;
}
const ASKED = new Date("2026-08-20T10:07:00Z");

/** The synthesis reply shape: prose, then exactly one fenced JSON block. */
const answerWith = (body: string, missing: string[] = []) =>
  `${body}\n\n\`\`\`json\n${JSON.stringify({ missing_information: missing })}\n\`\`\``;

function replyFor(request: CompletionRequest): unknown {
  if (request.task === "seed-selection") {
    return { seeds: ["wiki/concepts/PageRank.md"], keywords: ["ranking"] };
  }
  if (request.task === "synthesis") {
    return answerWith("Ranking uses [[PageRank]], not [[Photosynthesis]].");
  }
  if (request.task === "page-generation") return "Prose about [[PageRank]].";
  return inventoryReply("A note about ranking.", [
    { title: "PageRank", kind: "concept", aliases: ["PPR"], summary: "A walk." },
  ]);
}

function vault(): MemFs {
  return new MemFs({ "raw/note.md": "PageRank matters for ranking.\n" });
}

function core(fs: MemFs, provider: StubProvider, overrides: Partial<CoreDeps> = {}) {
  return createCore({
    fs,
    http: new StubHttp({}),
    manifestPath: MANIFEST,
    settings: { ...DEFAULT_SETTINGS, apiKey: "sk-ant-secret-key" },
    now: () => ASKED,
    provider,
    ...overrides,
  });
}

/** A compiled vault, ready to be asked. */
async function compiled(): Promise<{ fs: MemFs; provider: StubProvider }> {
  const fs = vault();
  const provider = new StubProvider(replyFor);
  await core(fs, provider).compile();
  return { fs, provider };
}

describe("a grounded answer", () => {
  it("writes the answer note", async () => {
    const { fs, provider } = await compiled();
    const result = await core(fs, provider).ask("How does ranking work?");

    expect(result.path).toBe("answers/2026-08-20-1007 how-does-ranking-work.md");
    const note = fs.text(result.path);

    // Code-written frontmatter, in the fixed key order (invariant 5).
    expect(note.startsWith("---\nkind: answer\n")).toBe(true);
    expect(note).toContain("question: How does ranking work?");
    expect(note).toContain("asked: '2026-08-20T10:07:00.000Z'");
    expect(note).toContain("grounded: true");
    // The retrieved page keeps its link; the page outside the set does not.
    expect(note).toContain("[[PageRank]]");
    expect(note).not.toContain("[[Photosynthesis]]");
    expect(note).toContain("<!-- link outside retrieved set: Photosynthesis -->");
    // Both code-written blocks, in order.
    expect(note).toContain("## Sources consulted");
    expect(note).toContain("## Retrieval trace");
    expect(note.indexOf("sources:start")).toBeLessThan(note.indexOf("trace:start"));
    expect(result.grounded).toBe(true);
  });

  it("records the mode it ranked in on the answer", async () => {
    const { fs, provider } = await compiled();
    const result = await core(fs, provider).ask("How does ranking work?");

    // A one-source vault is far under the predicate's 20 nodes.
    expect(result.mode).toBe("A");
    expect(fs.text(result.path)).toContain("- mode: A");
  });

  it("force-includes a page the question names, even when the model does not", async () => {
    const { fs } = await compiled();
    const provider = new StubProvider((request) =>
      request.task === "seed-selection"
        ? { seeds: [], keywords: [] }
        : answerWith("About [[PageRank]]."),
    );

    const result = await core(fs, provider).ask("what is pagerank?");

    expect(fs.text(result.path)).toContain("[[PageRank]]");
    expect(result.grounded).toBe(true);
  });
});

describe("invariant 12: ask makes at most three model calls", () => {
  it("spends one seed call and one synthesis call", async () => {
    const { fs } = await compiled();
    const provider = new StubProvider(replyFor);

    const result = await core(fs, provider).ask("How does ranking work?");

    const stats = provider.stats();
    expect(stats.byTask["seed-selection"]).toBe(1);
    expect(stats.byTask.synthesis).toBe(1);
    expect(result.modelCalls).toBe(2);
  });

  it("still runs the seed call in Mode A", async () => {
    // The seed call runs in both modes — Mode A does not save a call.
    const { fs } = await compiled();
    const provider = new StubProvider(replyFor);

    const result = await core(fs, provider).ask("How does ranking work?");

    expect(result.mode).toBe("A");
    expect(provider.stats().byTask["seed-selection"]).toBe(1);
  });
});

describe("an ungrounded answer", () => {
  it("labels it, warns first, and still answers", async () => {
    const fs = new MemFs({});
    const provider = new StubProvider((request) =>
      request.task === "seed-selection"
        ? { seeds: [], keywords: [] }
        : answerWith("From general knowledge."),
    );

    const result = await core(fs, provider).ask("What is a graph?");
    const note = fs.text(result.path);

    expect(result.grounded).toBe(false);
    expect(note).toContain("grounded: false");
    const body = note.slice(note.indexOf("---\n", 4) + 4);
    expect(body.trimStart().startsWith("> [!warning] Not grounded in your wiki")).toBe(true);
    expect(note).toContain("From general knowledge.");
    // Nothing was retrieved, so nothing is claimed as a source.
    expect(note).toContain("<!-- sources:start -->\n## Sources consulted\n<!-- sources:end -->");
    expect(note).toContain("- top: (none)");
  });
});

describe("invariant 11: written atomically, on success only", () => {
  it("writes nothing when the note cannot be written", async () => {
    const { fs, provider } = await compiled();
    const guarded = Object.create(fs) as MemFs;
    guarded.write = async (path: string, data: string | Uint8Array) => {
      if (path.startsWith("answers/")) throw new Error("EACCES answers/");
      return MemFs.prototype.write.call(fs, path, data);
    };

    await expect(core(guarded, provider).ask("How does ranking work?")).rejects.toThrow(/EACCES/);

    expect(fs.paths().some((path) => path.startsWith("answers/"))).toBe(false);
  });

  it("writes nothing when synthesis fails", async () => {
    const { fs } = await compiled();
    const provider = new StubProvider((request) =>
      request.task === "synthesis"
        ? fatalError("model refused")
        : { seeds: [], keywords: [] },
    );

    await expect(core(fs, provider).ask("q")).rejects.toThrow();

    expect(fs.paths().some((path) => path.startsWith("answers/"))).toBe(false);
  });

  it("suffixes rather than overwriting a note asked in the same minute", async () => {
    const { fs, provider } = await compiled();
    const asking = core(fs, provider);

    const first = await asking.ask("How does ranking work?");
    const second = await asking.ask("How does ranking work?");

    expect(second.path).not.toBe(first.path);
    expect(second.path).toContain("-2.md");
    expect(fs.text(first.path)).toContain("kind: answer");
  });
});

describe("invariant 2: compile and ask are mutually exclusive", () => {
  it("refuses an ask while a compile holds the lock, with the specified notice", async () => {
    const fs = vault();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = new StubProvider(async (request) => {
      if (request.task === "inventory") await held;
      return replyFor(request);
    });
    const asking = core(fs, provider);

    const compiling = asking.compile();
    const refused = await asking.ask("q").catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(BusyError);
    expect((refused as BusyError).message).toBe("Luka is busy: compile");
    release();
    await compiling;
  });

  it("refuses a compile while an ask holds the lock", async () => {
    const { fs } = await compiled();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider = new StubProvider(async (request) => {
      if (request.task === "synthesis") await held;
      return replyFor(request);
    });
    const asking = core(fs, provider);

    const answering = asking.ask("How does ranking work?");
    const refused = await asking.compile().catch((error: unknown) => error);

    expect(refused).toBeInstanceOf(BusyError);
    expect((refused as BusyError).message).toBe("Luka is busy: ask");
    release();
    await answering;
  });
});

describe("invariant 9: the key never reaches the vault", () => {
  it("writes no part of the API key into the note", async () => {
    const { fs, provider } = await compiled();

    const result = await core(fs, provider).ask("How does ranking work?");

    expect(fs.text(result.path)).not.toContain("sk-ant-secret-key");
    for (const path of fs.paths()) expect(fs.text(path)).not.toContain("sk-ant-secret-key");
  });
});

describe("the `## Add next` section", () => {
  /** A vault whose one page reaches for an article nobody has written. */
  async function gappy(): Promise<MemFs> {
    const fs = new MemFs({ "raw/note.md": "PageRank matters for ranking.\n" });
    const provider = new StubProvider((request) => {
      if (request.task === "page-generation") return "Ranking rests on [[Convergence]].";
      return inventoryReply("A note about ranking.", [
        { title: "PageRank", kind: "concept", summary: "A walk." },
      ]);
    });
    await core(fs, provider).compile();
    return fs;
  }

  const answering = (missing: string[]) =>
    new StubProvider((request) =>
      request.task === "seed-selection"
        ? { seeds: ["wiki/concepts/PageRank.md"], keywords: ["ranking"] }
        : answerWith("Ranking uses [[PageRank]].", missing),
    );

  it("names both what synthesis lacked and what the pages reached for", async () => {
    const fs = await gappy();

    const result = await core(fs, answering(["the 1998 paper"]), {
      // Off, so the reported item is the one the note carries: with the round
      // on, a match would replace the list under test.
      settings: { ...DEFAULT_SETTINGS, apiKey: "k", followUpEnabled: false },
    }).ask("How does ranking work?");
    const note = fs.text(result.path);

    expect(note).toContain("## Add next");
    expect(note).toContain("- **the 1998 paper** — the wiki could not answer this");
    expect(note).toContain("- **Convergence** — wanted by 1 of the pages consulted: PageRank");
    // The picture, drawn from what the answer already held.
    expect(note).toContain("```mermaid");
    expect(note).toContain('a(["This answer"])');
    expect(note).toContain("-.- g0");
    // And the section says the same thing the frontmatter does.
    expect(note).toContain("missing:\n  - the 1998 paper");
  });

  it("writes no section for an answer that ran into nothing", async () => {
    const { fs, provider } = await compiled();

    const result = await core(fs, provider).ask("How does ranking work?");

    expect(fs.text(result.path)).not.toContain("gaps:start");
  });

  it("leaves nothing behind when the answer is filed", async () => {
    const fs = await gappy();
    const instance = core(fs, answering(["the 1998 paper"]), {
      settings: { ...DEFAULT_SETTINGS, apiKey: "k", followUpEnabled: false },
    });
    const result = await instance.ask("How does ranking work?");

    await instance.fileBack(result.path);
    const filed = fs.text("raw/answers/2026-08-20-1007 how-does-ranking-work.md");

    expect(filed).not.toContain("## Add next");
    // A name the section recommended must not become an edge, or the next
    // compile inventories a page out of the suggestion to write one.
    expect(linkTargets(filed)).not.toContain("Convergence");
    expect(filed).toContain("missing:\n  - the 1998 paper");
    expect(filed).toContain("## Sources consulted");
  });
});

describe("determinism", () => {
  it("writes byte-identical notes for the same question and vault", async () => {
    const one = await compiled();
    const first = await core(one.fs, new StubProvider(replyFor)).ask("How does ranking work?");
    const two = await compiled();
    const second = await core(two.fs, new StubProvider(replyFor)).ask("How does ranking work?");

    expect(two.fs.text(second.path)).toBe(one.fs.text(first.path));
  });
});

describe("the follow-up round", () => {
  /** A vault with a second page the first answer will say it is missing. */
  async function twoPages(): Promise<MemFs> {
    const fs = new MemFs({
      "raw/one.md": "PageRank matters for ranking.\n",
      "raw/two.md": "Convergence takes many iterations.\n",
    });
    const provider = new StubProvider((request) => {
      if (request.task === "page-generation") return "Prose.";
      if (request.user.includes("Convergence")) {
        return inventoryReply("A note on convergence.", [
          { title: "Convergence", kind: "concept", summary: "It settles." },
        ]);
      }
      return inventoryReply("A note about ranking.", [
        { title: "PageRank", kind: "concept", summary: "A walk." },
      ]);
    });
    await core(fs, provider).compile();
    return fs;
  }

  /** Seeds PageRank only; the first answer reports convergence missing. */
  const expanding = (missingFirst: string[]) =>
    new StubProvider((request, index) => {
      if (request.task === "seed-selection") {
        return { seeds: ["wiki/concepts/PageRank.md"], keywords: ["ranking"] };
      }
      if (request.task === "synthesis") {
        return index === 0
          ? answerWith("Ranking uses [[PageRank]].", missingFirst)
          : answerWith("Ranking uses [[PageRank]] and [[Convergence]].");
      }
      return "";
    });

  it("appends the missing pages and synthesizes once more", async () => {
    const fs = await twoPages();
    const provider = expanding(["convergence"]);

    const result = await core(fs, provider).ask("How does ranking work?");
    const note = fs.text(result.path);

    expect(result.round2).toBe(true);
    expect(note).toContain("- round2: yes");
    // The union: the page the seed call chose, and the one the follow-up found.
    expect(note).toContain("[[PageRank]]");
    expect(note).toContain("[[Convergence]]");
    expect(note).toContain("- [[Convergence]]");
  });

  it("stays inside invariant 12's three calls, and never seeds twice", async () => {
    const fs = await twoPages();
    const provider = expanding(["convergence"]);

    const result = await core(fs, provider).ask("How does ranking work?");

    const stats = provider.stats();
    // No second seed call, no second PPR.
    expect(stats.byTask["seed-selection"]).toBe(1);
    expect(stats.byTask.synthesis).toBe(2);
    expect(result.modelCalls).toBe(3);
  });

  it("runs at most one round, however much the second answer still misses", async () => {
    const fs = await twoPages();
    // Both replies report something missing; only one expansion may run.
    const provider = new StubProvider((request) =>
      request.task === "seed-selection"
        ? { seeds: ["wiki/concepts/PageRank.md"], keywords: ["ranking"] }
        : answerWith("Partial answer about [[PageRank]].", ["convergence"]),
    );

    const result = await core(fs, provider).ask("How does ranking work?");

    expect(provider.stats().byTask.synthesis).toBe(2);
    expect(result.modelCalls).toBe(3);
  });

  it("does not run when the first answer is complete", async () => {
    const fs = await twoPages();
    const provider = expanding([]);

    const result = await core(fs, provider).ask("How does ranking work?");

    expect(result.round2).toBe(false);
    expect(provider.stats().byTask.synthesis).toBe(1);
    expect(fs.text(result.path)).toContain("- round2: no");
  });

  it("does not run when the setting is off", async () => {
    const fs = await twoPages();
    const provider = expanding(["convergence"]);

    const result = await core(fs, provider, {
      settings: { ...DEFAULT_SETTINGS, apiKey: "k", followUpEnabled: false },
    }).ask("How does ranking work?");

    expect(result.round2).toBe(false);
    expect(provider.stats().byTask.synthesis).toBe(1);
  });

  it("does not spend a call when the missing string matches nothing", async () => {
    const fs = await twoPages();
    const provider = expanding(["photosynthesis in deep sea vents"]);

    const result = await core(fs, provider).ask("How does ranking work?");

    expect(result.round2).toBe(false);
    expect(provider.stats().byTask.synthesis).toBe(1);
    // The strongest gap signal there is: the wiki had nothing to expand with,
    // so what synthesis said it lacked is what the vault still lacks.
    expect(fs.text(result.path)).toContain("missing:\n  - photosynthesis in deep sea vents");
  });

  it("cleans what the model wrote before it reaches the note, and the graph", async () => {
    // The unit tests pin `cleanMissing`; this pins that `runAsk` calls it. A
    // bracketed item survives filing into `raw/answers/`, where the graph scans the
    // whole file — frontmatter included — for links, so an uncleaned item is
    // an edge the model chose rather than one the wiki has.
    const fs = await twoPages();
    const provider = expanding(["[[Convergence]]\n  rate"]);

    const instance = core(fs, provider, {
      // Off, so the item under test is the one that reaches the note: with the
      // round on, "Convergence" matches a page and the second reply replaces it.
      settings: { ...DEFAULT_SETTINGS, apiKey: "k", followUpEnabled: false },
    });
    const result = await instance.ask("How does ranking work?");
    const note = fs.text(result.path);

    expect(note).toContain("missing:\n  - Convergence rate");
    expect(note).not.toContain("[[Convergence]]");

    await instance.fileBack(result.path);
    const filed = fs.text("raw/answers/2026-08-20-1007 how-does-ranking-work.md");
    // The function the graph reads edges with, asked the question the graph asks.
    expect(linkTargets(filed)).not.toContain("Convergence");
    expect(linkTargets(filed)).toContain("PageRank");
  });

  it("persists the last round's missing list, not the first's", async () => {
    // The follow-up round is the wiki's own attempt to close the gap. What it
    // still reports afterwards is the answer; the first round's list has been
    // acted on already.
    const fs = await twoPages();
    const provider = new StubProvider((request, index) => {
      if (request.task === "seed-selection") {
        return { seeds: ["wiki/concepts/PageRank.md"], keywords: ["ranking"] };
      }
      if (request.task === "synthesis") {
        return index === 0
          ? answerWith("Ranking uses [[PageRank]].", ["convergence"])
          : answerWith("Ranking uses [[PageRank]] and [[Convergence]].", ["the proof"]);
      }
      return "";
    });

    const result = await core(fs, provider).ask("How does ranking work?");
    const note = fs.text(result.path);
    const frontmatter = note.slice(0, note.indexOf("\n---\n", 4));

    expect(result.round2).toBe(true);
    expect(frontmatter).toContain("missing:\n  - the proof");
    expect(frontmatter).not.toContain("convergence");
  });

  it("writes no missing key when the answer reported nothing missing", async () => {
    const fs = await twoPages();

    const result = await core(fs, expanding([])).ask("How does ranking work?");
    const note = fs.text(result.path);

    expect(note.slice(0, note.indexOf("\n---\n", 4))).not.toContain("missing");
  });

  it("does not spend a call when the pages it found have nothing to read", async () => {
    // A page can score on its frontmatter and still contribute no text. It
    // ranks, so there are candidates, and then assembly finds nothing to
    // append — a second synthesis here would ask the same question of the same
    // context and spend invariant 12's third call on it.
    const fs = await twoPages();
    const page = fs.text("wiki/concepts/Convergence.md");
    const frontmatter = page.slice(0, page.indexOf("---", 4) + 4);
    await fs.write("wiki/concepts/Convergence.md", frontmatter);
    // "settles" appears only in this page's summary, so it is the only
    // candidate — the source pages mention convergence, but not this word.
    const provider = expanding(["settles"]);

    const result = await core(fs, provider).ask("How does ranking work?");

    expect(result.round2).toBe(false);
    expect(provider.stats().byTask.synthesis).toBe(1);
  });

  it("appends nothing when the remaining budget holds no page whole", async () => {
    // Tail-truncation is for a page over the *whole* budget. The
    // follow-up round packs into what the first round left; when that remnant
    // fits no candidate whole, appending a page cut to a few characters would
    // spend the third call on a fragment and list the page as read.
    const fs = await twoPages();
    const convergence = "wiki/concepts/Convergence.md";
    await fs.write(convergence, `${fs.text(convergence)}\n${"Iterations. ".repeat(200)}`);
    // A budget the first round fills to within a few tokens. In Mode A the seed
    // page itself scores nothing; the page ranked is the source page whose
    // summary says "ranking", and the `top:` assertion below pins that so the
    // remnant really is four tokens rather than zero, which would skip the
    // round before this rule is reached.
    const first = parseFrontmatter(fs.text("wiki/sources/one.md")).body;
    const budget = estimateTokens(first) + 4;
    const provider = expanding(["convergence"]);

    const result = await core(fs, provider, {
      settings: { ...DEFAULT_SETTINGS, apiKey: "k", contextBudgetTokens: budget },
    }).ask("How does ranking work?");

    const note = fs.text(result.path);
    expect(traceList(note, "top")).toEqual(["[[one]] 2.0000"]);
    expect(result.round2).toBe(false);
    expect(provider.stats().byTask.synthesis).toBe(1);
    expect(note).not.toContain("[[Convergence]]");
  });

  it("does not append a page the first round already had", async () => {
    // The missing string names something already in context. Appending it
    // again would list one page twice in `## Sources consulted` and spend a
    // model call re-reading what the model has already seen.
    const fs = await twoPages();
    // An exact title match on a page the first round already assembled.
    const provider = expanding(["PageRank"]);

    const result = await core(fs, provider).ask("How does ranking work?");
    const note = fs.text(result.path);

    const listed = [...note.matchAll(/^- \[\[PageRank\]\]$/gm)];
    expect(listed).toHaveLength(1);
  });
});

describe("invariant 12's number means what the invariant says", () => {
  // Invariant 12 allows ask at most three calls. `stats().requests` and
  // `byTask` both count transport *attempts* — they increment on the same
  // line inside the retry loop — so neither is the number the invariant
  // bounds. Retries and the one repair are recovery of a single logical call,
  // not extra calls.
  it("counts logical calls, not the attempts the wrapper spends making them", async () => {
    const { fs } = await compiled();
    // The seed reply is unparseable once, which the wrapper repairs with a
    // second transport attempt for the same logical call.
    let seedAttempts = 0;
    const provider = new StubProvider(
      (request) => {
        if (request.task === "seed-selection") {
          seedAttempts += 1;
          return seedAttempts === 1
            ? "not json at all"
            : { seeds: ["wiki/concepts/PageRank.md"], keywords: ["ranking"] };
        }
        return answerWith("About [[PageRank]].");
      },
      { maxRetries: 2 },
    );

    const result = await core(fs, provider).ask("How does ranking work?");

    // Two transport attempts were spent on one logical seed call.
    expect(provider.stats().byTask["seed-selection"]).toBe(2);
    // The reported number is the one invariant 12 bounds.
    expect(result.modelCalls).toBe(2);
  });

  it("never reports more than three, even when the wrapper retries hard", async () => {
    const { fs } = await compiled();
    let synthAttempts = 0;
    const provider = new StubProvider(
      (request) => {
        if (request.task === "seed-selection") {
          return { seeds: ["wiki/concepts/PageRank.md"], keywords: ["ranking"] };
        }
        synthAttempts += 1;
        if (synthAttempts < 3) return retryableError("503 upstream");
        return answerWith("About [[PageRank]].");
      },
      { maxRetries: 3 },
    );

    const result = await core(fs, provider).ask("How does ranking work?");

    expect(provider.stats().requests).toBeGreaterThan(3);
    expect(result.modelCalls).toBeLessThanOrEqual(3);
  });
});

describe("the trace names things one way", () => {
  it("writes seeds and top entries in the same form", async () => {
    // The trace's seeds and top entries are both title-shaped. `parseTrace` is
    // shared with the pane's replay, so a
    // block whose two lines use different naming schemes makes the pane
    // resolve two vocabularies from one four-line block.
    const { fs, provider } = await compiled();
    const result = await core(fs, provider).ask("How does ranking work?");
    const note = fs.text(result.path);

    const seeds = traceList(note, "seeds");
    expect(seeds.join(" ")).toContain("[[PageRank]]");
    expect(seeds.join(" ")).not.toContain("wiki/concepts/");
  });

  it("records the scores it actually ranked with", async () => {
    // Nothing asserted these before, so `score: 0` for every entry passed.
    const { fs, provider } = await compiled();
    const result = await core(fs, provider).ask("How does ranking work?");

    const top = traceList(fs.text(result.path), "top");
    expect(top).not.toEqual([]);
    const scores = top.map((entry) => Number(/\]\]\s+([0-9.]+)$/.exec(entry)?.[1]));
    expect(scores.length).toBeGreaterThan(0);
    expect(scores.some((score) => score > 0)).toBe(true);
  });

  it("records the seeds it actually retrieved with", async () => {
    // Likewise: `seeds: []` used to pass the whole suite.
    const { fs, provider } = await compiled();
    const result = await core(fs, provider).ask("How does ranking work?");

    expect(fs.text(result.path)).not.toContain("- seeds: (none)");
  });
});

describe("the trace a real answer writes replays onto the real graph", () => {
  it("resolves every label the note recorded back to a node of the graph", async () => {
    // The one place `labelFor` and `resolveTraceNodes` meet. They are written
    // apart — one renders the link form, the other reverses it — so nothing
    // but running the pipeline proves they still agree. A trace that replays to
    // nothing would leave the pane's overlay silently empty.
    const { fs, provider } = await compiled();
    const result = await core(fs, provider).ask("What ranks pages?");

    const note = decodeUtf8(await fs.read(result.path));
    const parsed = parseTrace(note).trace as Trace;
    const graph = await core(fs, provider).getGraph();

    const resolved = resolveTraceNodes(parsed, graph);

    expect(parsed.seeds.length).toBeGreaterThan(0);
    expect(resolved.unresolved).toEqual([]);
    expect(resolved.seeds).toEqual(["wiki/concepts/PageRank.md"]);
    // Every resolved path is a real node, and every top entry keeps its score.
    const nodePaths = new Set(graph.nodes.map((node) => node.path));
    for (const path of resolved.seeds) expect(nodePaths.has(path)).toBe(true);
    for (const entry of resolved.top) {
      expect(nodePaths.has(entry.path)).toBe(true);
      expect(entry.score).toBeGreaterThanOrEqual(0);
    }
    expect(resolved.top.length).toBe(parsed.top.length);
  });
});
