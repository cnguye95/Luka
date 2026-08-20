# Luka

An Obsidian plugin that compiles source documents you drop into `raw/` into a
linked markdown wiki, then answers questions from that wiki with citations.
Retrieval is graph-based (Personalized PageRank over wikilinks) — no vector
database, no embeddings, no chunking.

The full specification is [handoff.md](handoff.md); decisions made where the
spec was silent are logged in [BUILD-NOTES.md](BUILD-NOTES.md).

## Status

Milestones **M0 (scaffold)** and **M1 (ingest)** are complete. Luka currently
normalizes what you put in `raw/` and tracks it in an ingest manifest. It does
not yet build wiki pages, answer questions, or draw a graph — those are M2–M4.

## What compile does today

Run **Luka: Compile** from the command palette. It walks `raw/`, works out what
changed by content hash, and normalizes only that:

| You drop in | Luka writes |
|---|---|
| `.md`, `.txt` | nothing new — frontmatter, image links and markers are added in place |
| `.html` | `<name>.md` beside it, converted |
| `.pdf` | `<name>.md` beside it, from the text layer |
| `.csv`, `.tsv` | `<name>.md` descriptor card; the original is kept |
| a repository directory | `<dirname>.md` with the selected files concatenated |

A directory under `raw/` is treated as a **repository** — one source, not many —
when it contains either `.git/` or an empty file named `.luka-repo` that you
drop in yourself. Any other directory is just organization, and the files inside
it are individual sources.

Remote images referenced by a source are fetched into `raw/assets/`. Anything
that fails to fetch, is too small, or looks decorative keeps its original link
and gains a comment marker explaining why — nothing is ever silently removed.

Images placed directly in `raw/` and files with unsupported extensions are
skipped with a notice naming them, and are deliberately not recorded, so they
resurface on the next compile rather than disappearing quietly.

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

- [ ] **Luka: Compile** reports six new sources and one skipped file
      (`raw/orphan.png`).
- [ ] `raw/note.md` and `raw/notes.txt` gained an `ingested` / `source-format`
      block at the top and are otherwise unchanged.
- [ ] `raw/note.md` shows
      `<!-- image not fetched: fig1.png — ... -->` under the figure, with the
      original remote link still present, and its `data:` image untouched.
- [ ] `raw/page.md`, `raw/paper.md`, `raw/runs.md` and `raw/toy-repo.md` exist,
      each carrying `derived-from`.
- [ ] `raw/paper.md` contains the PDF's text, confirming pdf.js works inside the
      Electron renderer.
- [ ] `.obsidian/plugins/luka/ingest-manifest.json` lists exactly the six
      sources.
- [ ] A second **Luka: Compile** reports "nothing to do" and modifies no files.
- [ ] Editing `raw/note.md` and compiling again reports one changed source.
- [ ] Triggering Compile twice in quick succession shows
      "Luka is busy: compile" rather than running twice.
