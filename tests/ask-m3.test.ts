// `ask` end to end (handoff.md §7–§8), over an in-memory vault with a stub
// provider at the wrapper layer.
//
// The invariants that only become observable here: 2 (the lock refuses a
// second operation), 5 (code writes everything but the prose), 9 (the API key
// never reaches the vault), 11 (the note is written on success only), and 12
// (ask ≤ 3 model calls).
import { describe, expect, it } from "vitest";
import { createCore, type CompletionRequest, type CoreDeps } from "../src/core/index";
import { BusyError } from "../src/core/lock";
import { DEFAULT_SETTINGS } from "../src/core/types";
import { StubHttp } from "./helpers/http";
import { MemFs } from "./helpers/memfs";
import { StubProvider, fatalError, inventoryReply } from "./helpers/provider";

const MANIFEST = ".obsidian/plugins/luka/ingest-manifest.json";
const ASKED = new Date("2026-08-20T10:07:00Z");

/** §8.2's reply shape: prose, then exactly one fenced JSON block. */
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

describe("a grounded answer (§8.3)", () => {
  it("writes the note §8.3 describes", async () => {
    const { fs, provider } = await compiled();
    const result = await core(fs, provider).ask("How does ranking work?");

    expect(result.path).toBe("answers/2026-08-20-1007 how-does-ranking-work.md");
    const note = fs.text(result.path);

    // Code-written frontmatter, in §4's key order (invariant 5).
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

  it("records the mode it ranked in on the answer (§7.3)", async () => {
    const { fs, provider } = await compiled();
    const result = await core(fs, provider).ask("How does ranking work?");

    // A one-source vault is far under §7.3's 20 nodes.
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
    expect(result.modelCalls).toBeLessThanOrEqual(3);
  });

  it("still runs the seed call in Mode A (§7.3)", async () => {
    // "The seed call runs in both modes" — Mode A does not save a call.
    const { fs } = await compiled();
    const provider = new StubProvider(replyFor);

    const result = await core(fs, provider).ask("How does ranking work?");

    expect(result.mode).toBe("A");
    expect(provider.stats().byTask["seed-selection"]).toBe(1);
  });
});

describe("§7.4 step 5: an ungrounded answer", () => {
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

describe("determinism", () => {
  it("writes byte-identical notes for the same question and vault", async () => {
    const one = await compiled();
    const first = await core(one.fs, new StubProvider(replyFor)).ask("How does ranking work?");
    const two = await compiled();
    const second = await core(two.fs, new StubProvider(replyFor)).ask("How does ranking work?");

    expect(two.fs.text(second.path)).toBe(one.fs.text(first.path));
  });
});
