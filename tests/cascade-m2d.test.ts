// M2d: the §6.6 deletion/modification cascade, §5's scope preview, and §8.1's
// confirm step — over an in-memory vault with a stub provider at the wrapper
// layer, the same rig M2c uses.
//
// The claims under test are the ones §6.6 makes: affected pages regenerate
// from surviving citing sources, a page with zero remaining citations is
// deleted, a visited set stops a page being processed twice, and modification
// uses the same machinery.
import { describe, expect, it, vi } from "vitest";
import { parseCitationBlock } from "../src/core/compile/citations";
import { loadPageTable } from "../src/core/compile/pagetable";
import { BusyError, createCore, type CoreDeps, type ScopePreview } from "../src/core/index";
import type { CompletionRequest } from "../src/core/provider/types";
import { DEFAULT_SETTINGS, type ManifestEntry } from "../src/core/types";
import { StubHttp } from "./helpers/http";
import { MemFs } from "./helpers/memfs";
import { StubProvider, fatalError, inventoryReply } from "./helpers/provider";

const MANIFEST = ".obsidian/plugins/luka/ingest-manifest.json";

function core(fs: MemFs, provider: StubProvider, overrides: Partial<CoreDeps> = {}) {
  return createCore({
    fs,
    http: new StubHttp({}),
    manifestPath: MANIFEST,
    settings: { ...DEFAULT_SETTINGS, apiKey: "test-key" },
    now: () => new Date("2026-08-20T10:00:00Z"),
    provider,
    ...overrides,
  });
}

function manifestOf(fs: MemFs): Record<string, ManifestEntry> {
  return JSON.parse(fs.text(MANIFEST)) as Record<string, ManifestEntry>;
}

/**
 * Each source body names the pages its inventory should produce, so a vault is
 * described entirely by its files: "Ranking" in the text means this source
 * cites the "Ranking" concept.
 */
function replyFor(request: CompletionRequest): unknown {
  if (request.task === "page-generation") {
    const title = /Title: (.+)/.exec(request.user)?.[1] ?? "?";
    const seen = [...request.user.matchAll(/--- source: (.+?) ---/g)].map((match) => match[1]);
    return `About ${title}. Sources: ${seen.join(" ")}`;
  }
  const items: { title: string; kind: "concept" }[] = [];
  for (const title of ["Ranking", "Graphs", "Notes"]) {
    if (request.user.includes(title)) items.push({ title, kind: "concept" });
  }
  return inventoryReply("A source.", items);
}

/** `one.md` and `two.md` both cite Ranking; only `one.md` cites Graphs. */
function sharedVault(): MemFs {
  return new MemFs({
    "raw/one.md": "Ranking and Graphs.\n",
    "raw/two.md": "Ranking only.\n",
  });
}

function citersOf(fs: MemFs, path: string): string[] {
  return parseCitationBlock(fs.text(path)).entries;
}

describe("deletion cascade (§6.6)", () => {
  it("deletes the source page, the derivative, and every page left with no citer", async () => {
    const fs = new MemFs({ "raw/only.html": "<p>Ranking here.</p>\n" });
    await core(fs, new StubProvider(replyFor)).compile();

    expect(await fs.exists("raw/only.md")).toBe(true);
    expect(await fs.exists("wiki/concepts/Ranking.md")).toBe(true);

    await fs.delete("raw/only.html");
    const provider = new StubProvider(replyFor);
    const result = await core(fs, provider).compile();

    // Nothing survives to be regenerated, so nothing is worth asking a model.
    expect(result.modelCalls).toBe(0);
    expect(provider.stats().requests).toBe(0);

    expect(result).toMatchObject({ deleted: 1, pagesDeleted: 2, cancelled: false });
    expect(await fs.exists("wiki/sources/only.md")).toBe(false);
    expect(await fs.exists("wiki/concepts/Ranking.md")).toBe(false);
    // The derivative Luka wrote leaves with the source that owned it.
    expect(await fs.exists("raw/only.md")).toBe(false);
    expect(manifestOf(fs)).toEqual({});
  });

  it("drops a deleted page from _index.md", async () => {
    const fs = sharedVault();
    await core(fs, new StubProvider(replyFor)).compile();
    expect(fs.text("wiki/_index.md")).toContain("[[Graphs]]");

    await fs.delete("raw/one.md");
    await core(fs, new StubProvider(replyFor)).compile();

    const index = fs.text("wiki/_index.md");
    expect(index).not.toContain("[[Graphs]]");
    expect(index).not.toContain("[[one]]");
    // Everything still on disk is still listed.
    for (const page of await loadPageTable(fs)) expect(index).toContain(`[[${page.title}]]`);
  });

  it("regenerates a co-cited page from the survivor alone, with one call", async () => {
    const fs = sharedVault();
    await core(fs, new StubProvider(replyFor)).compile();
    expect(citersOf(fs, "wiki/concepts/Ranking.md")).toEqual(["raw/one.md", "raw/two.md"]);

    await fs.delete("raw/one.md");
    const provider = new StubProvider(replyFor);
    await core(fs, provider).compile();

    // One page survives, so exactly one Call B — and no Call A, since no
    // source changed content.
    const generated = provider.callsFor("page-generation");
    expect(generated).toHaveLength(1);
    expect(generated[0]?.user).toContain("Title: Ranking");
    expect(generated[0]?.user).toContain("--- source: raw/two.md ---");
    expect(generated[0]?.user).not.toContain("raw/one.md");

    expect(citersOf(fs, "wiki/concepts/Ranking.md")).toEqual(["raw/two.md"]);
    expect(fs.text("wiki/concepts/Ranking.md")).toContain("Sources: raw/two.md");
  });

  it("processes a page cited by two deleted sources exactly once (visited set)", async () => {
    const fs = new MemFs({
      "raw/one.md": "Ranking here.\n",
      "raw/two.md": "Ranking again.\n",
      "raw/three.md": "Ranking survives.\n",
    });
    await core(fs, new StubProvider(replyFor)).compile();

    await fs.delete("raw/one.md");
    await fs.delete("raw/two.md");
    const provider = new StubProvider(replyFor);
    const result = await core(fs, provider).compile();

    // Two deleted sources both queued the same page; §6.6's visited set means
    // it regenerates once, not twice.
    expect(provider.callsFor("page-generation")).toHaveLength(1);
    expect(citersOf(fs, "wiki/concepts/Ranking.md")).toEqual(["raw/three.md"]);
    // Only the two source pages go; the concept survives on its third citer.
    expect(result.pagesDeleted).toBe(2);
  });

  it("deletes a page cited only by two deleted sources once, without error", async () => {
    const fs = new MemFs({
      "raw/one.md": "Ranking here.\n",
      "raw/two.md": "Ranking again.\n",
    });
    await core(fs, new StubProvider(replyFor)).compile();

    await fs.delete("raw/one.md");
    await fs.delete("raw/two.md");
    const result = await core(fs, new StubProvider(replyFor)).compile();

    expect(result.failed).toEqual([]);
    // Two source pages and the one concept they shared.
    expect(result.pagesDeleted).toBe(3);
    expect(fs.paths().filter((path) => path.startsWith("wiki/"))).toEqual(["wiki/_index.md"]);
  });

  it("keeps a page a modified source re-cites — the preview's list is a 'may'", async () => {
    const fs = new MemFs({
      "raw/one.md": "Ranking here.\n",
      "raw/two.md": "Notes only.\n",
    });
    await core(fs, new StubProvider(replyFor)).compile();
    expect(citersOf(fs, "wiki/concepts/Ranking.md")).toEqual(["raw/one.md"]);

    // The page's only citer is deleted, but the modified source now names it.
    await fs.delete("raw/one.md");
    await fs.write("raw/two.md", "Notes and Ranking.\n");
    const result = await core(fs, new StubProvider(replyFor)).compile();

    expect(await fs.exists("wiki/concepts/Ranking.md")).toBe(true);
    expect(citersOf(fs, "wiki/concepts/Ranking.md")).toEqual(["raw/two.md"]);
    // Only the deleted source's own page goes.
    expect(result.pagesDeleted).toBe(1);
  });

  it("regenerates for a modified source through the same machinery", async () => {
    const fs = sharedVault();
    await core(fs, new StubProvider(replyFor)).compile();

    await fs.write("raw/one.md", "---\ningested: '2026-08-20'\nsource-format: md\n---\nNotes.\n");
    const result = await core(fs, new StubProvider(replyFor)).compile();

    // Every page one.md cites is requeued and rewritten from its new text, and
    // the topic it now names gets a page.
    expect(await fs.exists("wiki/concepts/Notes.md")).toBe(true);
    expect(fs.text("wiki/concepts/Ranking.md")).toContain(
      "Sources: raw/one.md raw/two.md",
    );

    // But nothing is orphaned. §6.5's citer record survives on the source still
    // existing, not on it still being mentioned: one.md no longer discusses
    // Graphs, yet it is still a live source citing that page, so the page
    // regenerates rather than being deleted. Only deletion empties a citer set.
    expect(await fs.exists("wiki/concepts/Graphs.md")).toBe(true);
    expect(citersOf(fs, "wiki/concepts/Graphs.md")).toEqual(["raw/one.md"]);
    expect(result).toMatchObject({ modified: 1, pagesDeleted: 0 });
  });

  it("still makes zero model calls on a recompile after a cascade", async () => {
    const fs = sharedVault();
    await core(fs, new StubProvider(replyFor)).compile();
    await fs.delete("raw/one.md");
    await core(fs, new StubProvider(replyFor)).compile();

    fs.resetCounters();
    const provider = new StubProvider(replyFor);
    const third = await core(fs, provider).compile();

    expect(third).toMatchObject({ unchanged: 1, modelCalls: 0, noop: true, pagesDeleted: 0 });
    expect(provider.stats().requests).toBe(0);
    expect(fs.writes).toBe(0);
    expect(fs.deletes).toBe(0);
  });
});

describe("scope preview (§5, §6.6)", () => {
  it("reports the four-rule diff and both cascade lists without doing work", async () => {
    const fs = sharedVault();
    await core(fs, new StubProvider(replyFor)).compile();

    await fs.delete("raw/one.md");
    await fs.write("raw/two.md", "---\ningested: '2026-08-20'\nsource-format: md\n---\nNotes.\n");

    fs.resetCounters();
    const provider = new StubProvider(replyFor);
    const preview = await core(fs, provider).previewCompile();

    expect(preview).toMatchObject({ added: 0, modified: 1, deleted: 1, unchanged: 0, renamed: 0 });
    // Ranking is cited by both, so it survives; Graphs and one.md's own page
    // have no citer left.
    expect(preview.regenerate).toEqual(["wiki/concepts/Ranking.md", "wiki/sources/two.md"]);
    expect(preview.mayDelete).toEqual(["wiki/concepts/Graphs.md", "wiki/sources/one.md"]);

    // Invariants 1 and 12: a preview is not an operation.
    expect(provider.stats().requests).toBe(0);
    expect(fs.writes).toBe(0);
    expect(fs.deletes).toBe(0);
  });

  it("answers on a vault that has never been compiled", async () => {
    // No manifest and no wiki/ folder: a first run, never an error (invariant 3).
    const fs = sharedVault();
    const preview = await core(fs, new StubProvider(replyFor)).previewCompile();
    expect(preview).toMatchObject({ added: 2, deleted: 0, regenerate: [], mayDelete: [] });
  });

  it("reports nothing to do on an unchanged vault", async () => {
    const fs = sharedVault();
    await core(fs, new StubProvider(replyFor)).compile();

    const preview = await core(fs, new StubProvider(replyFor)).previewCompile();
    expect(preview).toMatchObject({ unchanged: 2, regenerate: [], mayDelete: [] });
  });

  it("does not take the lock — the pane and the preview never block", async () => {
    const fs = sharedVault();
    const instance = core(fs, new StubProvider(replyFor));
    await instance.compile();

    // Both in flight at once; if previewCompile took the lock one would throw.
    await expect(
      Promise.all([instance.previewCompile(), instance.previewCompile()]),
    ).resolves.toHaveLength(2);
  });
});

describe("the confirm step (§8.1)", () => {
  it("shows the preview and proceeds when confirmed", async () => {
    const fs = sharedVault();
    await core(fs, new StubProvider(replyFor)).compile();
    await fs.delete("raw/one.md");

    const seen: ScopePreview[] = [];
    const result = await core(fs, new StubProvider(replyFor)).compile({
      confirm: (preview) => {
        seen.push(preview);
        return true;
      },
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.mayDelete).toEqual(["wiki/concepts/Graphs.md", "wiki/sources/one.md"]);
    expect(result.cancelled).toBe(false);
    expect(await fs.exists("wiki/concepts/Graphs.md")).toBe(false);
  });

  it("hands the confirm callback exactly what previewCompile reports", async () => {
    const fs = sharedVault();
    await core(fs, new StubProvider(replyFor)).compile();
    await fs.delete("raw/one.md");

    const instance = core(fs, new StubProvider(replyFor));
    const standalone = await instance.previewCompile();

    let handed: ScopePreview | null = null;
    await instance.compile({
      confirm: (preview) => {
        handed = preview;
        return false;
      },
    });

    expect(handed).toEqual(standalone);
  });

  it("writes nothing and calls no model when cancelled", async () => {
    const fs = sharedVault();
    await core(fs, new StubProvider(replyFor)).compile();
    await fs.delete("raw/one.md");

    const before = fs.text(MANIFEST);
    const pagesBefore = fs.paths();
    fs.resetCounters();

    const provider = new StubProvider(replyFor);
    const result = await core(fs, provider).compile({ confirm: () => false });

    expect(result).toMatchObject({
      cancelled: true,
      noop: true,
      deleted: 1,
      modelCalls: 0,
      pagesWritten: 0,
      pagesDeleted: 0,
      failed: [],
    });
    expect(provider.stats().requests).toBe(0);
    expect(fs.writes).toBe(0);
    expect(fs.deletes).toBe(0);
    expect(fs.text(MANIFEST)).toBe(before);
    expect(fs.paths()).toEqual(pagesBefore);
  });

  it("does not confirm an adds-only diff", async () => {
    const fs = sharedVault();
    const confirm = vi.fn(() => true);
    await core(fs, new StubProvider(replyFor)).compile({ confirm });
    expect(confirm).not.toHaveBeenCalled();

    // Nor an unchanged one.
    await core(fs, new StubProvider(replyFor)).compile({ confirm });
    expect(confirm).not.toHaveBeenCalled();
  });

  it("holds the operation lock across the confirm (§8.1, invariant 2)", async () => {
    const fs = sharedVault();
    await core(fs, new StubProvider(replyFor)).compile();
    await fs.delete("raw/one.md");

    const instance = core(fs, new StubProvider(replyFor));
    let release = (): void => {};
    const opened = new Promise<void>((resolve) => {
      release = resolve;
    });
    let answered: (value: boolean) => void = () => {};
    const answer = new Promise<boolean>((resolve) => {
      answered = resolve;
    });

    const running = instance.compile({
      confirm: () => {
        release();
        return answer;
      },
    });

    await opened;
    expect(instance.busyWith).toBe("compile");
    await expect(instance.compile()).rejects.toBeInstanceOf(BusyError);
    await expect(instance.compile()).rejects.toThrow("Luka is busy: compile");

    answered(true);
    await running;
    expect(instance.busyWith).toBe(null);
  });
});

describe("what the cascade must not do", () => {
  it("never deletes a file at the derivative path that Luka did not write (invariant 7)", async () => {
    const fs = new MemFs({ "raw/only.html": "<p>Ranking here.</p>\n" });
    await core(fs, new StubProvider(replyFor)).compile();

    // A user replaces the derivative with a file of their own.
    await fs.write("raw/only.md", "---\ntitle: Mine\n---\nHand-written.\n");
    await fs.delete("raw/only.html");
    await core(fs, new StubProvider(replyFor)).compile();

    expect(fs.text("raw/only.md")).toContain("Hand-written.");
  });

  it("does not delete a derivative belonging to a different source", async () => {
    const fs = new MemFs({
      "raw/one.html": "<p>Ranking here.</p>\n",
      "raw/two.html": "<p>Notes here.</p>\n",
    });
    await core(fs, new StubProvider(replyFor)).compile();

    await fs.delete("raw/one.html");
    await core(fs, new StubProvider(replyFor)).compile();

    expect(await fs.exists("raw/one.md")).toBe(false);
    expect(fs.text("raw/two.md")).toContain("derived-from: raw/two.html");
  });

  it("sweeps the derivative a renamed source left at its old path", async () => {
    const fs = new MemFs({ "raw/a.html": "<p>Ranking here.</p>\n" });
    await core(fs, new StubProvider(replyFor)).compile();
    expect(await fs.exists("raw/a.md")).toBe(true);

    // §6.2's missing-derivative rule turns this into modified + deleted, and
    // the derivative at the old name is what M1 left for the cascade.
    await fs.move("raw/a.html", "raw/b.html");
    await core(fs, new StubProvider(replyFor)).compile();

    expect(await fs.exists("raw/a.md")).toBe(false);
    expect(fs.text("raw/b.md")).toContain("derived-from: raw/b.html");
  });

  it("leaves links to a doomed page unresolved rather than pointing at nothing", async () => {
    // Both sources cite Ranking; only one.md cites Graphs. Deleting one.md
    // regenerates Ranking and dooms Graphs in the same run — so Ranking's new
    // body is written while Graphs is on its way out. An unresolved link is
    // §4's future-article signal; a resolved one would point at nothing.
    const fs = sharedVault();
    await core(fs, new StubProvider(replyFor)).compile();

    await fs.delete("raw/one.md");
    await core(
      fs,
      new StubProvider((request) =>
        request.task === "page-generation" ? "See [[Graphs]] for more." : replyFor(request),
      ),
    ).compile();

    expect(await fs.exists("wiki/concepts/Graphs.md")).toBe(false);
    const ranking = fs.text("wiki/concepts/Ranking.md");
    expect(ranking).toContain("[[Graphs]]");
    expect(ranking).not.toContain("[[Graphs|");
  });
});

describe("an interrupted cascade retries (invariant 3)", () => {
  it("keeps the deleted source in the manifest when a page could not regenerate", async () => {
    const fs = sharedVault();
    await core(fs, new StubProvider(replyFor)).compile();

    await fs.delete("raw/one.md");
    const failing = new StubProvider((request) =>
      request.task === "page-generation" ? fatalError("model is down") : replyFor(request),
    );
    const second = await core(fs, failing).compile();

    // The page that had to regenerate did not, so the deletion is not recorded
    // and §6.2's rule 3 will fire again next compile.
    expect(Object.keys(manifestOf(fs)).sort()).toEqual(["raw/one.md", "raw/two.md"]);
    expect(second.failed.map((failure) => failure.path)).toContain("raw/one.md");

    // Retry with a working provider: the cascade completes with no extra state.
    const third = await core(fs, new StubProvider(replyFor)).compile();
    expect(third).toMatchObject({ deleted: 1, failed: [] });
    expect(citersOf(fs, "wiki/concepts/Ranking.md")).toEqual(["raw/two.md"]);
    expect(Object.keys(manifestOf(fs))).toEqual(["raw/two.md"]);
  });

  it("keeps it when a doomed page could not be deleted", async () => {
    const fs = sharedVault();
    await core(fs, new StubProvider(replyFor)).compile();
    await fs.delete("raw/one.md");

    const guarded = Object.create(fs) as MemFs;
    guarded.delete = async (path: string): Promise<void> => {
      if (path === "wiki/concepts/Graphs.md") throw new Error("EPERM");
      return MemFs.prototype.delete.call(fs, path);
    };

    const second = await core(guarded, new StubProvider(replyFor)).compile();

    expect(second.failed.map((failure) => failure.path)).toContain("raw/one.md");
    expect(Object.keys(manifestOf(fs)).sort()).toEqual(["raw/one.md", "raw/two.md"]);
    // The rest of the run still landed — a failure costs one source, not the run.
    expect(await fs.exists("wiki/sources/one.md")).toBe(false);
    expect(citersOf(fs, "wiki/concepts/Ranking.md")).toEqual(["raw/two.md"]);
  });

  it("keeps it when the orphaned derivative could not be deleted", async () => {
    const fs = new MemFs({ "raw/only.html": "<p>Ranking here.</p>\n" });
    await core(fs, new StubProvider(replyFor)).compile();
    await fs.delete("raw/only.html");

    const guarded = refusingToDelete(fs, "raw/only.md");
    const second = await core(guarded, new StubProvider(replyFor)).compile();

    expect(Object.keys(manifestOf(fs))).toEqual(["raw/only.html"]);
    // One problem, one notice: the reason and the retry are one entry, not two.
    const mine = second.failed.filter((failure) => failure.path === "raw/only.html");
    expect(mine).toHaveLength(1);
    expect(mine[0]?.reason).toContain("could not delete raw/only.md");
    expect(mine[0]?.reason).toContain("retry next compile");

    // Retry: the sweep runs again and the deletion finally records.
    const third = await core(fs, new StubProvider(replyFor)).compile();
    expect(third).toMatchObject({ deleted: 1, failed: [] });
    expect(await fs.exists("raw/only.md")).toBe(false);
    expect(manifestOf(fs)).toEqual({});
  });

  it("re-extracts rather than guessing between two candidate files", async () => {
    // The user copied the derivative into the new folder and left the original
    // where it was, so two files now name this source. The entry names one of
    // them; the copy is at the location the new path expects. Nothing can
    // establish which is current, so nothing is adopted — the source re-extracts
    // and says so, and the file the entry named is cleaned up behind it.
    const fs = new MemFs({ "raw/a.html": "<p>Ranking here.</p>\n" });
    await core(fs, new StubProvider(replyFor)).compile();

    await fs.move("raw/a.html", "raw/sub/a.html");
    await fs.write("raw/sub/a.md", fs.text("raw/a.md"));

    const guarded = refusingToDelete(fs, "raw/a.md");
    const second = await core(guarded, new StubProvider(replyFor)).compile();

    expect(second).toMatchObject({ renamed: 1, modified: 0, failed: [] });
    // Two notices, two facts: what it had to redo, and what it could not tidy.
    const reasons = second.reported.map((entry) => entry.reason).join(" | ");
    expect(second.reported.every((entry) => entry.path === "raw/sub/a.html")).toBe(true);
    expect(reasons).toContain("re-extracted");
    expect(reasons).toContain("raw/a.md");
    expect(fs.text("raw/sub/a.md")).toContain("derived-from: raw/sub/a.html");
    expect(Object.keys(manifestOf(fs))).toEqual(["raw/sub/a.html"]);

    // And the vault settles rather than re-reporting every compile.
    const third = await core(fs, new StubProvider(replyFor)).compile();
    expect(third).toMatchObject({ noop: true, reported: [], failed: [] });
  });

  it("does not let a blocked deletion pair as a rename with an unrelated copy", async () => {
    // A restored entry waits in the manifest for as long as the failure lasts.
    // Recorded as its old hash, any file with the same bytes — a copied
    // template, a second empty note — would inherit its identity and its pages,
    // and the cascade would never retry.
    const fs = sharedVault();
    await core(fs, new StubProvider(replyFor)).compile();
    await fs.delete("raw/one.md");

    const guarded = refusingToDelete(fs, "wiki/concepts/Graphs.md");
    await core(guarded, new StubProvider(replyFor)).compile();
    expect(Object.keys(manifestOf(fs))).toContain("raw/one.md");

    // The same bytes the deleted source had, at a path that has nothing to do
    // with it.
    await fs.write("raw/copy.md", "Ranking and Graphs.\n");
    const provider = new StubProvider(replyFor);
    const third = await core(fs, provider).compile();

    // Read as a rename, the new file would inherit the dead path's identity:
    // no ingest at all, its real content never inventoried, and the pages the
    // cascade owed a deletion silently repointed onto it.
    expect(third).toMatchObject({ renamed: 0, added: 1, deleted: 1 });
    expect(provider.callsFor("inventory")).toHaveLength(1);
    expect(provider.callsFor("inventory")[0]?.user).toContain("Ranking and Graphs");
    expect(citersOf(fs, "wiki/sources/copy.md")).toEqual(["raw/copy.md"]);
    // The dead path is gone from every record, and the deletion is finally done.
    expect(citersOf(fs, "wiki/concepts/Graphs.md")).toEqual(["raw/copy.md"]);
    expect(Object.keys(manifestOf(fs)).sort()).toEqual(["raw/copy.md", "raw/two.md"]);
  });

  it("does not delete a page it is also writing this run", async () => {
    // Doomedness is read from the citation block, but a source page is queued
    // from its `source:` key. A block edited by hand to name only a dead source
    // must not make the run write the page and then delete it.
    const fs = new MemFs({
      "raw/one.md": "Notes here.\n",
      "raw/two.md": "Graphs here.\n",
    });
    await core(fs, new StubProvider(replyFor)).compile();

    const page = "wiki/sources/one.md";
    await fs.write(page, fs.text(page).replace("- [[raw/one.md]]", "- [[raw/two.md]]"));

    await fs.delete("raw/two.md");
    await fs.write("raw/one.md", "---\ningested: '2026-08-20'\nsource-format: md\n---\nRanking.\n");
    await core(fs, new StubProvider(replyFor)).compile();

    // The write is the authoritative record, so the page survives and its block
    // is rebuilt from the source it actually describes.
    expect(await fs.exists(page)).toBe(true);
    expect(citersOf(fs, page)).toEqual(["raw/one.md"]);
    expect(fs.text("wiki/_index.md")).toContain("[[one]]");
  });
});

describe("a source that cannot be read costs a page one run, not its content", () => {
  it("does not regenerate a page from an unreadable citer's empty body (§6.5)", async () => {
    // Both sources cite Ranking. `one.html` then fails to normalize, because a
    // file of the user's now occupies its derivative path — but the source
    // still exists, so it keeps its citation. Call B would be handed "" under
    // its label, and the page, rewritten wholesale, would lose everything that
    // source contributed while its block still claimed it.
    const fs = new MemFs({
      "raw/one.html": "<p>Ranking here.</p>\n",
      "raw/two.md": "Ranking only.\n",
    });
    await core(fs, new StubProvider(replyFor)).compile();
    const before = fs.text("wiki/concepts/Ranking.md");
    expect(citersOf(fs, "wiki/concepts/Ranking.md")).toEqual(["raw/one.html", "raw/two.md"]);

    await fs.write("raw/one.html", "<p>Ranking and Graphs.</p>\n");
    await fs.write("raw/one.md", "My own note now.\n");

    const provider = new StubProvider(replyFor);
    const result = await core(fs, provider).compile();

    // The page is left exactly as it was rather than rewritten from nothing.
    expect(fs.text("wiki/concepts/Ranking.md")).toBe(before);
    expect(result.failed.length).toBeGreaterThan(0);
    // No Call B ran on a prompt carrying an empty source body.
    for (const call of provider.callsFor("page-generation")) {
      expect(call.user).not.toMatch(/--- source: \S+ ---\n\n/);
    }
  });

  it("still serves the body of a citer whose own inventory failed", async () => {
    // Normalization is what creates readable markdown, and it succeeded — only
    // this source's own Call A came back an error. The body is sitting on disk,
    // and §6.5 wants "the full normalized bodies of *all* citing sources", so
    // refusing it would cost the page a citer it still claims in its block.
    //
    // The source is a rename that had to re-extract, which is the case with no
    // usable manifest entry to fall back on: the old entry is under the old
    // path, and the new one is not written until the source completes.
    const fs = new MemFs({
      "raw/one.html": "<p>Ranking here.</p>\n",
      "raw/two.md": "Ranking only.\n",
    });
    await core(fs, new StubProvider(replyFor)).compile();
    expect(citersOf(fs, "wiki/concepts/Ranking.md")).toEqual(["raw/one.html", "raw/two.md"]);

    // Removing the derivative is what makes the rename below re-extract rather
    // than carry, so its entry records no pointer.
    await fs.delete("raw/one.md");
    await fs.move("raw/one.html", "raw/moved.html");

    const provider = new StubProvider((request) =>
      request.task === "inventory" && request.user.includes("Ranking here")
        ? fatalError("inventory is down")
        : replyFor(request),
    );
    const result = await core(fs, provider).compile();

    // The re-extraction landed, so the body Call B needs is right there.
    expect(fs.text("raw/moved.md")).toContain("Ranking here");
    // One failure, the inventory call — not a second one for a page that could
    // not be regenerated.
    expect(result.failed.map((failure) => failure.path)).toEqual(["raw/moved.html"]);
    expect(citersOf(fs, "wiki/concepts/Ranking.md")).toEqual(["raw/moved.html", "raw/two.md"]);
    expect(fs.text("wiki/concepts/Ranking.md")).toContain("raw/moved.html");
  });
});

describe("a carried rename is still a citer", () => {
  it("serves its body to a page regenerating in the same run", async () => {
    // The carry deliberately skips normalization, so this source produces no
    // outcome this run; and its new path is an addition, so the manifest as
    // found does not name it either. It is still a citer, and §6.5 wants the
    // bodies of *all* citing sources — the markdown is sitting at the path the
    // carry just moved it to.
    const fs = new MemFs({
      "raw/one.html": "<p>Ranking here.</p>\n",
      "raw/two.md": "Ranking too.\n",
    });
    await core(fs, new StubProvider(replyFor)).compile();
    expect(citersOf(fs, "wiki/concepts/Ranking.md")).toEqual(["raw/one.html", "raw/two.md"]);

    // One source carries (a clean folder move); the other is edited, which is
    // what requeues the page they share.
    await fs.move("raw/one.html", "raw/sub/one.html");
    await fs.write(
      "raw/two.md",
      "---\ningested: '2026-08-20'\nsource-format: md\n---\nRanking, edited.\n",
    );

    const second = await core(fs, new StubProvider(replyFor)).compile();

    expect(second).toMatchObject({ renamed: 1, modified: 1, failed: [] });
    // The page regenerated from both citers, under their current paths.
    expect(fs.text("wiki/concepts/Ranking.md")).toContain("raw/sub/one.html");
    expect(fs.text("wiki/concepts/Ranking.md")).not.toContain("raw/one.html");
    expect(citersOf(fs, "wiki/concepts/Ranking.md")).toEqual(["raw/sub/one.html", "raw/two.md"]);
  });

  it("serves its body when the carry did not move the file either", async () => {
    // Extension-only: the derivative never moves, so nothing about the carry is
    // visible on disk — and the lookup must still find it.
    const fs = new MemFs({
      "raw/one.html": "<p>Ranking here.</p>\n",
      "raw/two.md": "Ranking too.\n",
    });
    await core(fs, new StubProvider(replyFor)).compile();

    await fs.move("raw/one.html", "raw/one.htm");
    await fs.write(
      "raw/two.md",
      "---\ningested: '2026-08-20'\nsource-format: md\n---\nRanking, edited.\n",
    );

    const second = await core(fs, new StubProvider(replyFor)).compile();
    expect(second).toMatchObject({ renamed: 1, failed: [] });
    expect(fs.text("wiki/concepts/Ranking.md")).toContain("raw/one.htm");
  });
});

describe("a re-extracted rename still owes its pages", () => {
  it("keeps a carried rename whose page could not be written", async () => {
    // A carried rename owes no page. §6.2 skips regeneration for it, so it
    // contributed no inventory this run and re-running it could not regenerate
    // anything — blocking it would only throw away a carry that succeeded and
    // re-extract over the repair next compile. The page comes back through the
    // source that actually queued it, which is un-manifested as usual.
    const fs = new MemFs({
      "raw/one.html": "<p>Ranking here.</p>\n",
      "raw/two.md": "Ranking too.\n",
    });
    await core(fs, new StubProvider(replyFor)).compile();

    await fs.move("raw/one.html", "raw/sub/one.html");
    await fs.write(
      "raw/two.md",
      "---\ningested: '2026-08-20'\nsource-format: md\n---\nRanking, edited.\n",
    );

    const failing = new StubProvider((request) =>
      request.task === "page-generation" ? fatalError("generation is down") : replyFor(request),
    );
    const second = await core(fs, failing).compile();
    // The source that queued the page is the one that has to come back for it.
    expect(second.failed.map((failure) => failure.path)).toEqual(["raw/two.md"]);
    // The rename is recorded, so its markdown is not carried a second time.
    expect(manifestOf(fs)["raw/sub/one.html"]?.derivative).toBe("raw/sub/one.md");
    expect(Object.keys(manifestOf(fs))).not.toContain("raw/one.html");

    const third = await core(fs, new StubProvider(replyFor)).compile();
    expect(third).toMatchObject({ renamed: 0, modified: 1, failed: [] });
    expect(third.pagesWritten).toBeGreaterThan(0);

    const fourth = await core(fs, new StubProvider(replyFor)).compile();
    expect(fourth).toMatchObject({ noop: true });
  });

  it("keeps the repair of a carried rename whose page failed", async () => {
    // The regression this rule replaced: withholding the entry left it naming a
    // path the carry had already vacated, so the retry could not recognise its
    // own work and re-extracted over §6.2's sanctioned repair.
    const fs = new MemFs({
      "raw/one.html": "<p>Ranking here.</p>\n",
      "raw/two.md": "Ranking too.\n",
    });
    await core(fs, new StubProvider(replyFor)).compile();
    await fs.write("raw/one.md", `${fs.text("raw/one.md")}\nHAND REPAIRED.\n`);

    await fs.move("raw/one.html", "raw/sub/one.html");
    await fs.write(
      "raw/two.md",
      "---\ningested: '2026-08-20'\nsource-format: md\n---\nRanking, edited.\n",
    );

    const failing = new StubProvider((request) =>
      request.task === "page-generation" ? fatalError("generation is down") : replyFor(request),
    );
    await core(fs, failing).compile();
    expect(fs.text("raw/sub/one.md")).toContain("HAND REPAIRED.");

    // The retry finishes the page without touching the markdown again.
    const third = await core(fs, new StubProvider(replyFor)).compile();
    expect(third.failed).toEqual([]);
    expect(fs.text("raw/sub/one.md")).toContain("HAND REPAIRED.");

    const fourth = await core(fs, new StubProvider(replyFor)).compile();
    expect(fourth).toMatchObject({ noop: true });
  });

  it("comes back for a page whose generation failed", async () => {
    // The regression the single commit point closes. The rename could not carry,
    // so the source re-extracted and its markdown is fine — but a page it owed
    // could not be written. Recording the derivative pointer here would have the
    // next compile read the source as fully ingested and never return to that
    // page; recording the hash alone is what brings it back.
    const fs = new MemFs({
      "raw/one.html": "<p>Ranking here.</p>\n",
      "raw/two.md": "Ranking only.\n",
    });
    await core(fs, new StubProvider(replyFor)).compile();

    // Nothing left to carry, so the rename below falls back to re-extraction.
    await fs.delete("raw/one.md");
    await fs.move("raw/one.html", "raw/moved.html");

    const failing = new StubProvider((request) =>
      request.task === "page-generation" ? fatalError("generation is down") : replyFor(request),
    );
    const second = await core(fs, failing).compile();
    expect(second.failed.map((failure) => failure.path)).toContain("raw/moved.html");
    // The markdown did land — this is not a normalization failure.
    expect(fs.text("raw/moved.md")).toContain("Ranking here");
    // Invariant 3: not manifested at either path, so the old entry presents the
    // same rename again and the page comes back with it.
    expect(Object.keys(manifestOf(fs))).toContain("raw/one.html");
    expect(Object.keys(manifestOf(fs))).not.toContain("raw/moved.html");

    // So the next compile takes it up again and finishes the job.
    const third = await core(fs, new StubProvider(replyFor)).compile();
    expect(third).toMatchObject({ renamed: 1, failed: [] });
    expect(third.pagesWritten).toBeGreaterThan(0);
    expect(manifestOf(fs)["raw/moved.html"]?.derivative).toBe("raw/moved.md");

    const fourth = await core(fs, new StubProvider(replyFor)).compile();
    expect(fourth).toMatchObject({ noop: true });
  });
});

describe("a failed derivative carry-over leaves the manifest alone", () => {
  it("re-presents the rename from an entry it never rewrote", async () => {
    // Nothing is undone, because nothing was done that needs undoing: the carry
    // writes at the location the entry already records, so a failure leaves the
    // file exactly where the manifest says it is. The manifest is not written at
    // all, which is the whole of the recovery.
    const fs = new MemFs({ "raw/a.html": "<p>Ranking here.</p>\n" });
    await core(fs, new StubProvider(replyFor)).compile();
    await fs.write("raw/a.md", `${fs.text("raw/a.md")}\nHAND REPAIRED.\n`);
    const manifestBytes = fs.text(MANIFEST);

    await fs.move("raw/a.html", "raw/sub/a.html");

    // Neither the repoint at the old location nor the re-extraction at the new
    // one can write, so the carry fails and so does the fallback behind it.
    const guarded = Object.create(fs) as MemFs;
    guarded.write = async (path: string, data: string | Uint8Array): Promise<void> => {
      if (path === "raw/a.md" || path === "raw/sub/a.md") throw new Error("EACCES");
      return MemFs.prototype.write.call(fs, path, data);
    };

    const second = await core(guarded, new StubProvider(replyFor)).compile();
    expect(second.failed.map((failure) => failure.path)).toContain("raw/sub/a.html");
    // One problem, one notice: the detour that led nowhere is not reported
    // separately from the failure that will retry.
    expect(second.reported).toEqual([]);

    // The single commit point: nothing wrote the manifest, so it is byte-for-byte
    // what it was — which is the whole of this design's failure recovery. There
    // is no withdrawal to get wrong and no restore to get wrong.
    expect(fs.text(MANIFEST)).toBe(manifestBytes);
    // Nothing was taken from the vault to arrange any of it: the repair is
    // still at the location the entry records.
    expect(fs.text("raw/a.md")).toContain("HAND REPAIRED.");
    expect(await fs.exists("raw/sub/a.md")).toBe(false);
    expect(second.derivativesDeleted).toBe(0);

    // The untouched entry presents the same rename again, which now carries.
    const third = await core(fs, new StubProvider(replyFor)).compile();
    expect(third).toMatchObject({ renamed: 1, modelCalls: 0, failed: [] });
    expect(fs.text("raw/sub/a.md")).toContain("HAND REPAIRED.");
    expect(fs.text("raw/sub/a.md")).toContain("derived-from: raw/sub/a.html");
    expect(await fs.exists("raw/a.md")).toBe(false);

    const fourth = await core(fs, new StubProvider(replyFor)).compile();
    expect(fourth).toMatchObject({ noop: true });
  });
});

/** A view of the vault whose `delete` refuses one path, as a locked file would. */
function refusingToDelete(fs: MemFs, blocked: string): MemFs {
  const guarded = Object.create(fs) as MemFs;
  guarded.delete = async (path: string): Promise<void> => {
    if (path === blocked) throw new Error("EPERM");
    return MemFs.prototype.delete.call(fs, path);
  };
  return guarded;
}
