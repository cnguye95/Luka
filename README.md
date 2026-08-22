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

## Eval

`npm run eval` scores the committed fixture vault in `eval/` against the
questions in `eval/queries.yaml`, reporting recall@5, recall@10 and MRR for both
retrieval modes and exiting nonzero if any mean falls below the floor recorded
in that file. It runs in CI.

**These numbers measure ranking, not the LLM phases.** CI mode calls no model at
all: it seeds by exact title and alias match, the way §7.4's force-include rule
does, and scores what the ranker returns. Nothing here says whether the seed
call chooses well, whether synthesis writes a good answer, or whether an answer
is grounded — only whether the pages a question should surface come back near
the top. `npm run eval:live` runs the same measurement with the real seed call
(needs `ANTHROPIC_API_KEY`); it is never run in CI.

`npm run eval:fixture` rebuilds the fixture vault from its hand-written sources
in `eval/fixture-vault/raw/`. It calls no model either — the replies are
scripted — and the rebuild is byte-identical, so regenerating the vault does not
move the floors.

## Manual checklist

Automated tests cover `src/core` only; the Obsidian surface is checked by hand
(§14). 93 items, ordered so that stopping anywhere leaves the most valuable
ground covered: setup first, then the graph pane — the newest code and the only
part with no automated coverage whatsoever — then the older flows, then the
destructive and paid checks, then edge cases. Work top to bottom.

### 1. Start here — does it load at all

If any of these fail, nothing below is worth running.

- [ ] Plugin appears under Community plugins and enables without console errors.
- [ ] Settings tab shows an API key field (masked) and one model id per task.
- [ ] Values survive a reload of Obsidian (they are stored in
      `.obsidian/plugins/luka/data.json`).

### 2. Before you compile — the empty-vault states

Do these while the vault is still empty; after the first compile you cannot
get back to this state without deleting `wiki/` and the manifest.

- [ ] On an empty vault — no `wiki/`, no manifest — the pane shows
      "No graph yet. Run Luka: Compile to build one." rather than a blank area.
- [ ] On an empty vault the Compile pointer shows and the banner does not —
      the two states never appear together.

### 3. The first compile

Copy `demo/raw/` to `raw/` in the test vault. Needs a real API key: this
compile costs a few cents and takes a minute or two.

- [ ] **Luka: Compile** reports seven new sources and nothing skipped.
- [ ] `.obsidian/plugins/luka/ingest-manifest.json` lists exactly the seven
      sources.
- [ ] A second **Luka: Compile** reports "nothing to do" and modifies no files.
- [ ] `raw/note.md` and `raw/notes.txt` gained an `ingested` / `source-format`
      block at the top and are otherwise unchanged.
- [ ] `raw/note.md` shows
      `<!-- image not fetched: fig1.png — ... -->` under the figure, with the
      original remote link still present, and its `data:` image untouched.
- [ ] `raw/page.md`, `raw/paper.md`, `raw/runs.md` and `raw/toy-repo.md` exist,
      each carrying `derived-from`.
- [ ] `raw/paper.md` contains the PDF's text, confirming pdf.js works inside the
      Electron renderer.
- [ ] Editing `raw/note.md` and compiling again reports one changed source.
- [ ] Triggering Compile twice in quick succession shows
      "Luka is busy: compile" rather than running twice.

### 4. What compile wrote

Reading the vault the compile above produced. No further calls.

- [ ] `wiki/sources/` holds one page per source, each with a
      `source: "[[raw/...]]"` key and a citation block naming its own raw file.
- [ ] `wiki/entities/` and `wiki/concepts/` hold pages whose bodies are prose
      with `[[wikilinks]]`, and whose citation blocks name the sources they came
      from.
- [ ] `wiki/_index.md` opens with `# Index` and lists every page under
      *Sources*, *Entities* or *Concepts*.
- [ ] Ctrl/Cmd-clicking a `[[link]]` in a generated page opens the page it
      names, or offers to create it (an unresolved link is a future-article
      signal, not a bug).
- [ ] No wiki page contains frontmatter, a citation list, or a heading written
      by the model — code writes all four (invariant 5).
- [ ] `raw/orphan.md` exists and describes the image, carrying `derived-from`.
- [ ] A second **Luka: Compile** reports "nothing to do" and makes no API calls
      (watch the console or your Anthropic usage page).
- [ ] Editing one source and recompiling regenerates only the pages that cite
      it.
- [ ] Removing the API key and compiling a changed source surfaces one failure
      notice per source and leaves the manifest untouched, so the next compile
      with a key restored picks them up again.

### 5. The graph pane opens

Everything from here to "Export" is §9's pane, which has no automated
coverage at all — §14 puts it here instead. This is the largest unverified
surface in the project, so it comes before the older flows.

- [ ] **Luka: Open graph** in the command palette opens the pane, and the ribbon
      icon opens the same one. Pressing the ribbon again *reveals* that pane
      rather than opening a second copy.
- [ ] On the compiled demo vault the pane opens in under a second (§15's AC —
      wall-clock it from the click to the node/edge counts appearing).
- [ ] On a small vault (a handful of pages), the pane shows the banner
      "Mode A (lexical) active — graph ranking off" followed by live node, link
      pair and ratio counts, and the counts match what `wiki/_index.md` implies.
- [ ] With the pane open, run **Luka: Compile**. When it finishes, the pane's
      counts update on their own, with no click. (§7.1's rebuild event.)
- [ ] The **Refresh** button updates the counts after a compile run from another
      window or a vault sync.
- [ ] Close the pane and reopen it: it works, and the developer console shows no
      error logged at close. (Invariant 1 — nothing of the view outlives it.)
- [ ] The graph draws: nodes appear, spread out, and the layout comes to rest
      within a few seconds rather than jittering forever. (§9's "simulation
      cools to a stop".)
- [ ] Once it has settled, the pane is idle — Obsidian's CPU use drops back to
      baseline and stays there with the pane open and untouched. (Invariant 1:
      the only sanctioned loop is the simulation, and it must end.)

### 6. The graph draws correctly

- [ ] Close and reopen the pane on the same vault: the layout starts from the
      same arrangement both times. (§9's "initial positions seeded by hashing
      page path".)
- [ ] Concepts, entities, sources and raw files are four distinguishable muted
      colours, and they are theme colours — not fixed hues.
- [ ] Switch Obsidian between dark and light with the pane open. The graph
      recolours itself without needing to be reopened. (§15's AC.)
- [ ] Well-connected nodes are visibly larger than leaf nodes.
- [ ] At rest, about ten labels are shown — the highest-degree nodes — not one
      per node.
- [ ] Hovering a node shows a tooltip with its title, kind and summary. A raw
      source shows its filename and "raw" with no summary line.

### 7. The graph responds to the pointer

- [ ] Dragging on empty space pans the graph; the scroll wheel zooms, and the
      point under the cursor stays under it rather than sliding away.
- [ ] Hovering costs no vault reads — the tooltip appears instantly even on a
      large vault, because the summary travels on the node.
- [ ] Dragging a node moves it, and it stays where it is dropped while its
      neighbours resettle around it. (§9's drag-to-pin.)
- [ ] Double-clicking a node opens that page in the current tab. Double-clicking
      a raw source opens its readable markdown.
- [ ] Moving the pointer off the canvas hides the tooltip and clears the hover
      label.
- [ ] Dragging a node does *not* trigger click-PPR when you release it; a click
      without movement does.

### 8. Overlays and the filter

All of these are free — §9 gives click-PPR, the filter and replay zero model
calls, and the network panel is how you check that.

- [ ] Clicking a node recolours the graph instantly: the clicked node gains a
      ring, the top-K gain a stroke, reached nodes take a heat ramp, and
      everything unreached dims. No network request appears in the developer
      tools. (§9's "no model call".)
- [ ] The status line names the overlay while one is active.
- [ ] Pressing Esc clears the overlay and restores the plain graph.
- [ ] Typing in the filter box dims non-matching nodes as you type, matching on
      both title and path, case-insensitively. Clearing it restores everything.
      Again, no network request.
- [ ] Filter and overlay compose: with both active, a node outside both is
      dimmer than one outside only one of them.
- [ ] Click-PPR still works while a compile is running — the pane is never
      blocked by the lock.
- [ ] Open the pane on a vault where one file under `wiki/` is unreadable (make
      one a directory, or lock it). The pane shows a notice naming the problem
      and falls back to the empty state — it does not throw into the console or
      render a blank surface with no explanation.

### 9. Export

- [ ] **Export PNG** downloads a file through the browser/OS download path. It
      matches what is on screen — same camera, same overlay if one is active.
- [ ] The exported image has an opaque background in both dark and light
      themes, not a transparent one.
- [ ] Nothing new appears anywhere in the vault after an export.

### 10. Ask, answers, filing

Needs a real API key. One question costs a few cents.

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

### 11. Trace replay on the graph

Continues from the answer note the section above wrote.

- [ ] Ask a question on the demo vault, then run **Luka: Show retrieval on
      graph** from the answer note. The pane opens and lights exactly the pages
      the note's own trace block lists as seeds and top entries.
- [ ] The command does not appear in the palette while a non-answer note is
      active, and the pane's "Show retrieval" button is hidden then too.
- [ ] Delete the `<!-- trace:start -->` block from an answer note by hand and
      run the command: a notice says there is no trace, and the pane is left
      exactly as it was.
- [ ] Replay a trace, then compile after deleting one of the pages it names.
      Replay again: the remaining pages light and the status line reports how
      many labels it could not resolve.
- [ ] Trace replay makes no network request. (§9's "zero calls".)

### 12. Query inspection — one model call per press

The only paid items in the pane. Skip if you would rather not spend the calls;
nothing below depends on them.

- [ ] With a real API key set, type a question into the graph's query box and
      press **Inspect (1 model call)**. Exactly one request appears in the
      developer tools network panel — not two, not three.
- [ ] The button's label reads exactly "Inspect (1 model call)".
- [ ] The overlay appears: seeds ringed, top-K stroked, and on a Mode-B vault a
      heat ramp across what the query reached.
- [ ] On a small Mode-A vault, inspection lights seeds and lexical top-K with
      **no** heat ramp, and the Mode-A banner above explains why.
- [ ] Nothing is written anywhere in the vault by an inspection — no answer
      note, no file at all.
- [ ] The button is disabled while the call is in flight, and pressing Enter in
      the query box does the same thing as clicking it.
- [ ] Inspect works while a compile is running (the pane is never blocked), and
      Esc clears the resulting overlay.

### 13. Deletion is recoverable — destructive, deliberately late

These delete pages, so they come after everything that reads the vault. The
core is tested against in-memory and Node filesystems; only Obsidian's own
adapter can show that a delete reaches the system trash, which makes the last
two items here the highest-value pair in the list.

- [ ] Deleting `raw/page.html` and running **Luka: Compile** opens the scope
      modal first, showing the diff counts and both lists — pages to regenerate,
      and pages that may be deleted.
- [ ] Pressing **Cancel** (or Esc) closes it, reports "compile cancelled", and
      changes nothing: `wiki/sources/page.md` and `raw/page.md` are still there.
- [ ] Triggering Compile a second time while the modal is open shows
      "Luka is busy: compile" — the lock is held across the confirm.
- [ ] Running Compile again and pressing **Compile** removes `wiki/sources/page.md`
      and `raw/page.md`, drops the page from `wiki/_index.md`, and regenerates
      any page that cited it from its remaining sources.
- [ ] After the deletion above, `wiki/sources/page.md` and `raw/page.md` are in
      the system trash (or the vault's `.trash/` folder, if the platform has no
      usable system trash) — **not** gone. This is what makes a mistaken
      confirmation at the scope modal survivable, and it is the one thing the
      modal's "pages that *may* be deleted" wording promises but code cannot
      assert.
- [ ] `.trash/`, if it appears, is not picked up as a source by a later
      compile: the next **Luka: Compile** still reports "nothing to do".
- [ ] Editing a source rather than deleting it also opens the modal, and its
      "may be deleted" list is empty.
- [ ] A compile whose diff is only additions opens no modal at all.

### 14. Health check

- [ ] **Luka: Health check** writes `wiki/_health.md` and opens it, with no
      notice about model calls because it makes none.
- [ ] It lists article candidates (links that resolve to nothing), orphan pages,
      citations naming files the manifest does not know, filed answers with
      their ages, and counts.
- [ ] Running it twice in a row produces the same file; resolving a link by
      writing the page it wanted removes it from the candidates on the next run.
- [ ] Running it while a compile is in flight shows "Luka is busy: compile".

### 15. Settings detail

- [ ] The settings tab shows a **Retrieval** section: context budget, pages per
      answer, both graph-mode thresholds, and a follow-up toggle.
- [ ] **Advanced (PageRank)** is collapsed by default and expands to damping,
      maximum iterations, and a convergence threshold that is visible but not
      editable.
- [ ] Editing a numeric field and reloading Obsidian keeps the new value;
      typing nonsense into one and reloading falls back to the documented
      default rather than breaking compile.

### 16. Bigger vaults and edge cases

Least likely to matter, and the 500-node item needs a vault you may not have.

- [ ] On a vault of 500+ nodes the standing labels disappear and panning stays
      smooth. (§9's "drop labels first".)
- [ ] Compile enough sources to pass the predicate (20+ nodes and 1.5+ link
      pairs per node). After the refresh, the banner disappears.
- [ ] A markdown source with **two or more** reachable remote images localizes
      all of them on its *first* compile, with no source failing. (§6.3 fetches
      four at a time into a `raw/assets/` folder none of them has created yet.)
- [ ] Hand-editing `.obsidian/plugins/luka/data.json` to
      `"contextBudgetTokens": 0`, `"compileConcurrency": "two"` or
      `"requestTimeoutMs": 0` and compiling still behaves: the run completes,
      pages keep their grounding, and nothing is rewritten from an empty
      context. Restore the file afterwards.
