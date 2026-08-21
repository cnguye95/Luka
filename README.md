# Luka

An Obsidian plugin that compiles source documents you drop into `raw/` into a
linked markdown wiki, then answers questions from that wiki with citations.
Retrieval is graph-based (Personalized PageRank over wikilinks) — no vector
database, no embeddings, no chunking.

The full specification is [handoff.md](handoff.md); decisions made where the
spec was silent are logged in [BUILD-NOTES.md](BUILD-NOTES.md).

## Status

Milestones **M0 (scaffold)** and **M1 (ingest)** are complete, plus the first
most of M2: compile now normalizes what you put in `raw/`, extracts an
inventory of entities and concepts from each source, and writes a linked
three-kind wiki with citation blocks and a generated index. Still to come are
the deletion cascade and the scope preview (the rest of M2), then answering
questions and drawing the graph (M3–M4).

To prove the pipeline against the real API (optional, a few cents):

```
ANTHROPIC_API_KEY=sk-ant-... npm test                              # provider smoke tests
ANTHROPIC_API_KEY=sk-ant-... npx vitest run tests/compile-live.test.ts   # a real end-to-end compile
```

Both are skipped without the key, and neither ever runs in CI.

## What compile does today

Run **Luka: Compile** from the command palette. It walks `raw/`, works out what
changed by content hash, and normalizes only that:

| You drop in | Luka writes |
|---|---|
| `.md`, `.txt` | nothing new — frontmatter, image links and markers are added in place |
| `.html` | `<name>.md` beside it, converted |
| `.pdf` | `<name>.md` beside it, from the text layer |
| `.csv`, `.tsv` | `<name>.md` descriptor card; the original is kept |
| `.png`, `.jpg`, `.gif`, `.webp` | `<name>.md` describing it, from a vision pass; the original is kept |
| a repository directory | `<dirname>.md` with the selected files concatenated |

It then reads each changed source once to inventory the entities and concepts
it names, merges those inventories against the pages you already have, and
writes a page per entity and concept under `wiki/`, plus one page per source.
Code writes the frontmatter, resolves the links, and appends the citation block;
the model writes only the prose. `wiki/_index.md` is regenerated at the end.

An image dropped straight into `raw/` becomes a source with its own page — a
photo of a whiteboard is worth as much as a document. Images merely *referenced*
by another source are fetched into `raw/assets/` and get no page of their own.

A directory under `raw/` is treated as a **repository** — one source, not many —
when it contains either `.git/` or an empty file named `.luka-repo` that you
drop in yourself. Any other directory is just organization, and the files inside
it are individual sources.

Remote images referenced by a source are fetched into `raw/assets/`. Anything
that fails to fetch, is too small, or looks decorative keeps its original link
and gains a comment marker explaining why — nothing is ever silently removed.

Files with unsupported extensions are skipped with a notice naming them, and are
deliberately not recorded, so they resurface on the next compile rather than
disappearing quietly. The same is true of a source whose extraction failed: it
is never recorded, so the next compile simply tries it again.

Nothing runs on a timer or a file watcher. Compile happens when you ask for it.

## Development

Requires Node ≥ 20.

```
npm install
npm run build          # typecheck + bundle to main.js
npm run dev            # rebuild on change
npm test               # vitest, src/core only
npm run check:boundary # asserts src/core never imports `obsidian`
npm run lint
```

### Trying it in Obsidian

1. `npm run build`
2. `npm run install:vault` — copies `main.js` and `manifest.json` into
   `test-vault/.obsidian/plugins/luka/`.
3. Open `test-vault/` as a vault in Obsidian and enable Luka under
   *Community plugins*. The vault is gitignored.
4. Copy `demo/raw/` into the vault as `raw/` to have something to compile.

## Manual checklist

Automated tests cover `src/core` only; the Obsidian surface is checked by hand.

### M0

- [ ] Plugin appears under Community plugins and enables without console errors.
- [ ] Settings tab shows an API key field (masked) and one model id per task.
- [ ] Values survive a reload of Obsidian (they are stored in
      `.obsidian/plugins/luka/data.json`).

### M1

With `demo/raw/` copied to `raw/` in the test vault:

- [ ] **Luka: Compile** reports seven new sources and nothing skipped.
- [ ] `raw/note.md` and `raw/notes.txt` gained an `ingested` / `source-format`
      block at the top and are otherwise unchanged.
- [ ] `raw/note.md` shows
      `<!-- image not fetched: fig1.png — ... -->` under the figure, with the
      original remote link still present, and its `data:` image untouched.
- [ ] `raw/page.md`, `raw/paper.md`, `raw/runs.md` and `raw/toy-repo.md` exist,
      each carrying `derived-from`.
- [ ] `raw/paper.md` contains the PDF's text, confirming pdf.js works inside the
      Electron renderer.
- [ ] `.obsidian/plugins/luka/ingest-manifest.json` lists exactly the seven
      sources.
- [ ] A second **Luka: Compile** reports "nothing to do" and modifies no files.
- [ ] Editing `raw/note.md` and compiling again reports one changed source.
- [ ] Triggering Compile twice in quick succession shows
      "Luka is busy: compile" rather than running twice.

### M2c

Needs a real API key in settings. The first compile of `demo/raw/` costs a few
cents and takes a minute or two.

- [ ] `raw/orphan.md` exists and describes the image, carrying `derived-from`.
- [ ] `wiki/sources/` holds one page per source, each with a
      `source: "[[raw/...]]"` key and a citation block naming its own raw file.
- [ ] `wiki/entities/` and `wiki/concepts/` hold pages whose bodies are prose
      with `[[wikilinks]]`, and whose citation blocks name the sources they came
      from.
- [ ] No wiki page contains frontmatter, a citation list, or a heading written
      by the model — code writes all four (invariant 5).
- [ ] `wiki/_index.md` opens with `# Index` and lists every page under
      *Sources*, *Entities* or *Concepts*.
- [ ] Ctrl/Cmd-clicking a `[[link]]` in a generated page opens the page it
      names, or offers to create it (an unresolved link is a future-article
      signal, not a bug).
- [ ] A second **Luka: Compile** reports "nothing to do" and makes no API calls
      (watch the console or your Anthropic usage page).
- [ ] Editing one source and recompiling regenerates only the pages that cite
      it.
- [ ] Removing the API key and compiling a changed source surfaces one failure
      notice per source and leaves the manifest untouched, so the next compile
      with a key restored picks them up again.

### M2d

Continues from the compiled vault above.

- [ ] Deleting `raw/page.html` and running **Luka: Compile** opens the scope
      modal first, showing the diff counts and both lists — pages to regenerate,
      and pages that may be deleted.
- [ ] Pressing **Cancel** (or Esc) closes it, reports "compile cancelled", and
      changes nothing: `wiki/sources/page.md` and `raw/page.md` are still there.
- [ ] Running Compile again and pressing **Compile** removes `wiki/sources/page.md`
      and `raw/page.md`, drops the page from `wiki/_index.md`, and regenerates
      any page that cited it from its remaining sources.
- [ ] Triggering Compile a second time while the modal is open shows
      "Luka is busy: compile" — the lock is held across the confirm.
- [ ] Editing a source rather than deleting it also opens the modal, and its
      "may be deleted" list is empty.
- [ ] A compile whose diff is only additions opens no modal at all.

### M3 — Ask, answers, filing

Needs a real API key and a compiled vault. One question costs a few cents.

- [ ] **Luka: Ask the wiki** opens a modal with a single question field, already
      focused. Enter submits; Esc and Cancel both close it and do nothing.
- [ ] Asking a question about something in the wiki writes
      `answers/YYYY-MM-DD-HHmm <slug>.md` and **opens it in a new leaf**.
- [ ] The note reads as prose with `[[links]]`, then `## Sources consulted`,
      then `## Retrieval trace` — and its frontmatter carries `kind: answer`,
      `question`, `asked`, `mode` and `grounded`.
- [ ] Ctrl/Cmd-clicking a link in the answer opens the page it names.
- [ ] Asking something the wiki says nothing about produces a note whose first
      line is the `> [!warning] Not grounded in your wiki` callout, rendered as
      a callout in reading view, with `grounded: false`.
- [ ] Triggering **Ask the wiki** while a compile is running shows
      "Luka is busy: compile"; triggering **Compile** while an ask is running
      shows "Luka is busy: ask".
- [ ] **Luka: File this answer** does not appear in the command palette while a
      non-answer note is active, and does appear on an answer note.
- [ ] Filing moves the note to `raw/answers/`, drops the `## Retrieval trace`
      block, keeps `## Sources consulted`, and shows
      "Filed. Run Compile to integrate." — with no compile starting on its own.
- [ ] The next **Luka: Compile** ingests the filed answer as an ordinary source:
      it gains a `wiki/sources/` page, and the answer's own links now connect it
      into the graph.

### Deletion is recoverable

The core is tested against in-memory and Node filesystems; only Obsidian's own
adapter can show this.

- [ ] After the deletion above, `wiki/sources/page.md` and `raw/page.md` are in
      the system trash (or the vault's `.trash/` folder, if the platform has no
      usable system trash) — **not** gone. This is what makes a mistaken
      confirmation at the scope modal survivable, and it is the one thing the
      modal's "pages that *may* be deleted" wording promises but code cannot
      assert.
- [ ] `.trash/`, if it appears, is not picked up as a source by a later
      compile: the next **Luka: Compile** still reports "nothing to do".

### Concurrency and settings

- [ ] A markdown source with **two or more** reachable remote images localizes
      all of them on its *first* compile, with no source failing. (§6.3 fetches
      four at a time into a `raw/assets/` folder none of them has created yet.)
- [ ] Hand-editing `.obsidian/plugins/luka/data.json` to
      `"contextBudgetTokens": 0`, `"compileConcurrency": "two"` or
      `"requestTimeoutMs": 0` and compiling still behaves: the run completes,
      pages keep their grounding, and nothing is rewritten from an empty
      context. Restore the file afterwards.
