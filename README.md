# Luka

An Obsidian plugin that compiles source documents you drop into `raw/` into a
linked markdown wiki, then answers questions from that wiki with citations.
Retrieval is graph-based (Personalized PageRank over wikilinks) — no vector
database, no embeddings, no chunking.

The full specification is [handoff.md](handoff.md); decisions made where the
spec was silent are logged in [BUILD-NOTES.md](BUILD-NOTES.md).

## Table of Contents

- [Status](#status)
- [Compile](#compile)
- [Page Types and Graph Colours](#page-types-and-graph-colours)
- [Development](#development)
- [Running it in Obsidian](#running-it-in-obsidian)
- [Commands](#commands)
- [Eval](#eval)
- [Manual checklist](#manual-checklist)

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

## Compile

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

## Page Types and Graph Colours

Compile writes three kinds of wiki page; the graph pane draws a fourth kind of
node for the originals. Colour is how you tell them apart in the pane.

| Kind | Definition |
|---|---|
| 🟢 **entity** | a named thing — a person, organization, place, product, or work |
| 🔵 **concept** | an idea, method, or phenomenon |
| 🟠 **source** | one page per ingested source |
| ⚪ **raw** | the original file itself, not a wiki page |

Colours are Obsidian theme variables rather than fixed hues, so the graph
recolours when you switch themes. Files whose basename starts with `_`
(`_index.md`, `_health.md`) are infrastructure and never appear in the graph.

Running a query paints an **overlay** on top of these colours: a ring marks a
seed, a stroke marks the top-K, reached nodes take a heat ramp toward red, and
anything the query did not reach is **dimmed — not removed**. The node count
never changes, and Esc clears the overlay.

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

## Running it in Obsidian

Luka is an Obsidian plugin — there is no standalone binary, and no way to
launch it on its own. Running it means building the bundle, copying it into a
vault, and enabling it from inside Obsidian.

**1. Install Obsidian.** Desktop only — the manifest sets `isDesktopOnly`.
Download it from [obsidian.md](https://obsidian.md), or on Windows:

```
winget install --id Obsidian.Obsidian -e
```

**2. Build and install the plugin.**

```
npm install
npm run build          # typecheck + bundle to main.js
npm run install:vault  # copies main.js, manifest.json and styles.css into
                       # test-vault/.obsidian/plugins/luka/
```

`styles.css` travels with the build because Obsidian loads it from the plugin
directory — §9's graph pane has no layout without it.

**3. Open the vault.** In Obsidian, *Open folder as vault* → `test-vault/`.
It is gitignored, and starts out empty apart from the plugin you just copied in.

**4. Enable the plugin.** Settings → *Community plugins* → turn off Restricted
Mode → enable **Luka**. Keep the developer console open (Ctrl/Cmd-Shift-I): the
manual checklist asks you to watch it in several places, and a plugin that
fails to load says so there.

**5. Set the API key.** Paste an Anthropic key into the Luka settings tab.
Settings are the only source — the plugin has no `ANTHROPIC_API_KEY` fallback,
and reads the key live on each run, so a freshly typed one takes effect without
a reload. (The env var is for the optional live tests above and
`npm run eval:live`, which run outside Obsidian.)

**6. Give it something to compile.**

```
cp -r demo/raw test-vault/raw
```

Then run **Luka: Compile** from the command palette. **Luka: Open graph** opens
the pane; the ribbon icon opens the same one.

### After a rebuild

Obsidian does not pick up a new `main.js` on its own. Re-run
`npm run build && npm run install:vault`, then either toggle Luka off and on
under *Community plugins* or run *Reload app without saving* from the command
palette. `npm run dev` rebuilds on change but still writes only to `main.js` in
the repo root — the copy into the vault and the reload are both still yours to
do.

### If you are working the manual checklist

Do step 6 **last**. §2 checks the empty-vault states, and once the first compile
has run you cannot get back to them without deleting `wiki/` and the manifest.
If the vault lives inside a synced folder (OneDrive, Dropbox), pause the sync
first — files changing underneath a run will muddy the "nothing to do" and
"modifies no files" items.

## Commands

Luka registers seven commands. All are invoked from the command palette
(Ctrl/Cmd-P, then type `luka`) — there are no menus, and the single ribbon
icon opens the graph pane.

| Command | What it does |
|---|---|
| **Luka: Compile** | Walks `raw/`, normalizes what changed, and rebuilds the wiki. The scope modal appears first when the diff includes deletions or modifications. |
| **Luka: Ask the wiki** | Opens a modal for one question; writes the answer to `answers/` and opens it. |
| **Luka: File this answer** | Moves the active answer note to `raw/answers/` so the next compile ingests it as a source. Drops the retrieval trace, keeps the sources block. |
| **Luka: Health check** | Writes and opens `wiki/_health.md`: article candidates, orphan pages, citations naming unknown files, filed answers and their ages. Makes no model calls. |
| **Luka: Open graph** | Opens the graph pane. The ribbon icon opens the same one. |
| **Luka: Show retrieval on graph** | Replays the active answer note's retrieval trace as an overlay on the graph. Makes no model calls. |
| **Luka: What to add next** | Opens a pane of suggestions read off the wiki's own structure: articles several pages link to that nobody has written, and pages resting on a single source. Makes no model calls and writes nothing; **Refresh** rescans, and a pane Obsidian restored waits to be asked. |

### Asking without spending

The graph pane has its own question box, and it is not a second way to run
*Ask the wiki*. Typing into `Ask the graph…` and pressing **Inspect (1 model
call)** — or Enter — answers a narrower question: *what would retrieval
actually pull for this?* It makes exactly one model call to choose seeds, ranks
from them, paints the result as an overlay, and stops. No synthesis, no answer,
and no file: §12.5 pins that an inspection writes nothing anywhere in the vault.

That makes it the cheap way to see why an answer surfaced what it did, or to
sanity-check a question before paying for the real thing. *Ask the wiki* costs
two or three calls and leaves a note; *Inspect* costs one and leaves nothing,
which is why the button prints its own price.

Two of these are **context-sensitive**: *File this answer* and *Show retrieval
on graph* appear only while an answer note is the active file, and are absent
from the palette otherwise.

### Binding a hotkey

**Settings → Hotkeys**, search `luka`, and click the `+` beside the command you
want. That page lists every command Obsidian and its plugins register, with a
search box, and is the better place to *browse* what exists — the palette is
for running something whose name you already half-remember.

Worth binding:

- **Luka: Ask the wiki** — the command you reach for most once a wiki exists.
- **Luka: Compile** — several checklist items ask you to trigger it twice in
  quick succession, which is fiddly through the palette.

### Obsidian's own commands

The palette also carries everything Obsidian itself registers. The one that
comes up constantly while developing the plugin is **Reload app without
saving**, which is how Obsidian picks up a rebuilt `main.js`.

**The developer console is the exception to all of this.** It is *not* a
command — it never appears in the palette or under Hotkeys, and Obsidian's
Windows title bar has no menu to reach it from. Use **Ctrl/Cmd-Shift-I** (F12
also works in most Electron builds). The manual checklist asks you to watch it
in several places, so it is worth knowing that one key combination even though
everything else here is discoverable.

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
(§14). 118 items, ordered so that stopping anywhere leaves the most valuable
ground covered: setup first, then the graph pane — the newest code and the only
part with no automated coverage whatsoever — then the older flows, then the
destructive and paid checks, then edge cases. Work top to bottom.

### 1. Start here — does it load at all

If any of these fail, nothing below is worth running.

- [x] Plugin appears under Community plugins and enables without console errors.
- [x] Settings tab shows an API key field (masked) and one model id per task.
- [x] Values survive a reload of Obsidian (they are stored in
      `.obsidian/plugins/luka/data.json`).

### 2. Before you compile — the empty-vault states

Do these while the vault is still empty; after the first compile you cannot
get back to this state without deleting `wiki/` and the manifest.

- [x] On an empty vault — no `wiki/`, no manifest — the pane shows
      "No graph yet. Run Luka: Compile to build one." rather than a blank area.
- [x] On an empty vault the Compile pointer shows and the banner does not —
      the two states never appear together.

### 3. The first compile

Copy `demo/raw/` to `raw/` in the test vault. Needs a real API key: this
compile costs a few cents and takes a minute or two.

- [x] **Luka: Compile** reports seven new sources and nothing skipped.
- [x] `.obsidian/plugins/luka/ingest-manifest.json` lists exactly the seven
      sources.
- [x] A second **Luka: Compile** reports "nothing to do" and modifies no files.
- [x] `raw/note.md` and `raw/notes.txt` gained an `ingested` / `source-format`
      block at the top and are otherwise unchanged.
- [x] `raw/note.md` shows
      `<!-- image not fetched: fig1.png — ... -->` under the figure, with the
      original remote link still present, and its `data:` image untouched.
- [x] `raw/page.md`, `raw/paper.md`, `raw/runs.md` and `raw/toy-repo.md` exist,
      each carrying `derived-from`.
- [x] `raw/paper.md` contains the PDF's text, confirming pdf.js works inside the
      Electron renderer.
- [x] Editing `raw/note.md` and compiling again reports one changed source.
- [x] Triggering Compile twice in quick succession shows
      "Luka is busy: compile" rather than running twice.

### 4. What compile wrote

Reading the vault the compile above produced. No further calls.

- [x] `wiki/sources/` holds one page per source, each with a
      `source: "[[raw/...]]"` key and a citation block naming its own raw file.
- [x] `wiki/entities/` and `wiki/concepts/` hold pages whose bodies are prose
      with `[[wikilinks]]`, and whose citation blocks name the sources they came
      from.
- [x] `wiki/_index.md` opens with `# Index` and lists every page under
      *Sources*, *Entities* or *Concepts*.
- [x] Ctrl/Cmd-clicking a `[[link]]` in a generated page opens the page it
      names, or offers to create it (an unresolved link is a future-article
      signal, not a bug).
- [ ] **FAILED — see BUILD-NOTES.** No wiki page contains frontmatter, a citation list, or a heading written
      by the model — code writes all four (invariant 5).
- [x] `raw/orphan.md` exists and describes the image, carrying `derived-from`.
- [x] A second **Luka: Compile** reports "nothing to do" and makes no API calls
      (watch the console or your Anthropic usage page).
- [x] Editing one source and recompiling regenerates only the pages that cite
      it.
- [x] Removing the API key and compiling a changed source surfaces one failure
      notice per source and leaves the manifest untouched, so the next compile
      with a key restored picks them up again.

### 5. The graph pane opens

Everything from here to "Export" is §9's pane, which has no automated
coverage at all — §14 puts it here instead. This is the largest unverified
surface in the project, so it comes before the older flows.

- [x] **Luka: Open graph** in the command palette opens the pane, and the ribbon
      icon opens the same one. Pressing the ribbon again *reveals* that pane
      rather than opening a second copy.
- [x] On the compiled demo vault the pane opens in under a second (§15's AC —
      wall-clock it from the click to the node/edge counts appearing).
- [x] On a small vault (a handful of pages), the pane shows the banner
      "Mode A (lexical) active — graph ranking off" followed by live node, link
      pair and ratio counts, and the counts match what `wiki/_index.md` implies.
- [x] With the pane open, run **Luka: Compile**. When it finishes, the pane's
      counts update on their own, with no click. (§7.1's rebuild event.)
- [ ] **Fixed on branch, verification owed — see BUILD-NOTES.** The **Refresh**
      button updates the counts after a compile run from another window or a
      vault sync.
- [x] Close the pane and reopen it: it works, and the developer console shows no
      error logged at close. (Invariant 1 — nothing of the view outlives it.)
- [x] The graph draws: nodes appear, spread out, and the layout comes to rest
      within a few seconds rather than jittering forever. (§9's "simulation
      cools to a stop".)
- [x] Once it has settled, the pane is idle — Obsidian's CPU use drops back to
      baseline and stays there with the pane open and untouched. (Invariant 1:
      the only sanctioned loop is the simulation, and it must end.)

### 6. The graph draws correctly

- [x] Close and reopen the pane on the same vault: the layout starts from the
      same arrangement both times. (§9's "initial positions seeded by hashing
      page path".)
- [x] Concepts, entities, sources and raw files are four distinguishable muted
      colours, and they are theme colours — not fixed hues.
- [x] Switch Obsidian between dark and light with the pane open. The graph
      recolours itself without needing to be reopened. (§15's AC.)
- [x] Well-connected nodes are visibly larger than leaf nodes.
- [x] At rest, about ten labels are shown — the highest-degree nodes — not one
      per node.
- [x] Hovering a node shows a tooltip with its title, kind and summary. A raw
      source shows its filename and "raw" with no summary line.

### 7. The graph responds to the pointer

- [x] Dragging on empty space pans the graph; the scroll wheel zooms, and the
      point under the cursor stays under it rather than sliding away.
- [x] Hovering costs no vault reads — the tooltip appears instantly even on a
      large vault, because the summary travels on the node.
- [x] Dragging a node moves it, and it stays where it is dropped while its
      neighbours resettle around it. (§9's drag-to-pin.)
- [x] Double-clicking a node opens that page in the current tab. Double-clicking
      a raw source opens its readable markdown.
- [x] Moving the pointer off the canvas hides the tooltip and clears the hover
      label.
- [x] Dragging a node does *not* trigger click-PPR when you release it; a click
      without movement does.
- [x] Let the layout come to rest, then click a node **without moving the
      pointer**. The overlay appears and *nothing moves* — a click must not
      reheat the simulation the way a drag does.
- [x] After that click, drag a *different* node to stir the layout, and watch
      the one you clicked. It drifts along with its neighbours rather than
      sitting frozen — a click must not pin. Only a drag pins.

The last two are negatives: they check that a click does *not* acquire the
drag's side effects. Both were true bugs, and neither is caught by the suite —
`press.ts` decides which gesture a press became and is tested directly, but
nothing asserts that `view.ts` actually asks it. Reverting `view.ts` alone
leaves every automated test passing, so these two items are the only thing
standing between that regression and the vault.

### 8. Overlays and the filter

**How to check "no model call".** Not in DevTools. The plugin calls the API
through Obsidian's `requestUrl`, which runs in Electron's main process, so its
requests never appear in the renderer's Network panel — an empty panel there is
consistent with any number of calls and proves nothing. Use your Anthropic
usage page, which counts server-side, or read the path: click-PPR, the filter
and trace replay reach no provider at all, and `ppr.ts` holds no reference to
one.

All of these are free — §9 gives click-PPR, the filter and replay zero model
calls.

- [x] Clicking a node recolours the graph instantly: the clicked node gains a
      ring, the top-K gain a stroke, reached nodes take a heat ramp, and
      everything unreached dims. No model call — see the note above on how to
      check that. (§9's "no model call".)
- [x] The status line names the overlay while one is active.
- [x] Pressing Esc clears the overlay and restores the plain graph.
- [x] Typing in the filter box dims non-matching nodes as you type, matching on
      both title and path, case-insensitively. Clearing it restores everything.
      Again, no model call.
- [x] Filter and overlay compose: with both active, a node outside both is
      dimmer than one outside only one of them.
- [x] Click-PPR still works while a compile is running — the pane is never
      blocked by the lock.
- [x] Open the pane on a vault where one file under `wiki/` is unreadable. Deny
      read on it — `icacls "<file>" /deny "%USERNAME%":(R)` on Windows, `chmod
      000` elsewhere; restore with `/remove:d`. Replacing it with a *directory*
      does not reproduce, because `fs-obsidian.ts` tags entries by kind and
      `pagetable.ts` skips folders, so the file is never read and nothing
      throws. The pane shows a notice naming the problem
      and falls back to the empty state — it does not throw into the console or
      render a blank surface with no explanation.

### 9. Export

- [x] **Export PNG** downloads a file through the browser/OS download path. It
      matches what is on screen — same camera, same overlay if one is active.
- [x] The exported image has an opaque background in both dark and light
      themes, not a transparent one.
- [x] Nothing new appears anywhere in the vault after an export.

### 10. Ask, answers, filing

Needs a real API key. One question costs a few cents.

- [x] **Luka: Ask the wiki** opens a modal with a single question field, already
      focused. Enter submits; Esc and Cancel both close it and do nothing.
- [x] Asking a question about something in the wiki writes
      `answers/YYYY-MM-DD-HHmm <slug>.md` and **opens it in a new leaf**.
- [x] The note reads as prose with `[[links]]`, then `## Sources consulted`,
      then `## Retrieval trace` — and its frontmatter carries `kind: answer`,
      `question`, `asked`, `mode` and `grounded`.
- [ ] An answer whose synthesis still reported something missing carries a
      `missing:` list in its frontmatter, each entry on one line with no
      `[[brackets]]`; an answer that reported nothing has no such key.
- [x] Ctrl/Cmd-clicking a link in the answer opens the page it names.
- [x] Asking something the wiki says nothing about produces a note whose first
      line is the `> [!warning] Not grounded in your wiki` callout, rendered as
      a callout in reading view, with `grounded: false`.
- [x] Triggering **Ask the wiki** while a compile is running shows
      "Luka is busy: compile"; triggering **Compile** while an ask is running
      shows "Luka is busy: ask".
- [x] **Luka: File this answer** does not appear in the command palette while a
      non-answer note is active, and does appear on an answer note.
- [x] Filing moves the note to `raw/answers/`, drops the `## Retrieval trace`
      block, keeps `## Sources consulted`, and shows
      "Filed. Run Compile to integrate." — with no compile starting on its own.
- [x] The next **Luka: Compile** ingests the filed answer as an ordinary source:
      it gains a `wiki/sources/` page, and the answer's own links now connect it
      into the graph.

### 11. Trace replay on the graph

Continues from the answer note the section above wrote.

- [x] Ask a question on the demo vault, then run **Luka: Show retrieval on
      graph** from the answer note. The pane opens and lights exactly the pages
      the note's own trace block lists as seeds and top entries.
- [x] The command does not appear in the palette while a non-answer note is
      active, and the pane's "Show retrieval" button is hidden then too.
- [x] Delete the `<!-- trace:start -->` block from an answer note by hand and
      run the command: a notice says there is no trace, and the pane is left
      exactly as it was.
- [x] Replay a trace, then compile after deleting one of the pages it names.
      Replay again: the remaining pages light and the status line reports how
      many labels it could not resolve.
- [x] Trace replay makes no model call. (§9's "zero calls".)

### 12. Query inspection — one model call per press

The only paid items in the pane. Skip if you would rather not spend the calls;
nothing below depends on them.

- [x] With a real API key set, type a question into the graph's query box and
      press **Inspect (1 model call)**. Exactly one request reaches the API —
      not two, not three. Count it on the usage page, not in DevTools.
- [x] The button's label reads exactly "Inspect (1 model call)".
- [x] The overlay appears: seeds ringed, top-K stroked, and on a Mode-B vault a
      heat ramp across what the query reached.
- [x] On a small Mode-A vault, inspection lights seeds and lexical top-K with
      **no** heat ramp, and the Mode-A banner above explains why.
- [x] Nothing is written anywhere in the vault by an inspection — no answer
      note, no file at all.
- [x] The button is disabled while the call is in flight, and pressing Enter in
      the query box does the same thing as clicking it.
- [x] Inspect works while a compile is running (the pane is never blocked), and
      Esc clears the resulting overlay.

### 13. Deletion is recoverable — destructive, deliberately late

These delete pages, so they come after everything that reads the vault. The
core is tested against in-memory and Node filesystems; only Obsidian's own
adapter can show that a delete reaches the system trash, which makes the last
two items here the highest-value pair in the list.

- [x] Deleting `raw/page.html` and running **Luka: Compile** opens the scope
      modal first, showing the diff counts and both lists — pages to regenerate,
      and pages that may be deleted.
- [x] Pressing **Cancel** (or Esc) closes it, reports "compile cancelled", and
      changes nothing: `wiki/sources/page.md` and `raw/page.md` are still there.
- [x] Triggering Compile a second time while the modal is open shows
      "Luka is busy: compile" — the lock is held across the confirm.
- [x] Running Compile again and pressing **Compile** removes `wiki/sources/page.md`
      and `raw/page.md`, drops the page from `wiki/_index.md`, and regenerates
      any page that cited it from its remaining sources.
- [x] After the deletion above, `wiki/sources/page.md` and `raw/page.md` are in
      the system trash (or the vault's `.trash/` folder, if the platform has no
      usable system trash) — **not** gone. This is what makes a mistaken
      confirmation at the scope modal survivable, and it is the one thing the
      modal's "pages that *may* be deleted" wording promises but code cannot
      assert.
- [ ] **N/A where the OS has a system trash** (deletes go there instead, so no
      vault-local folder appears). `.trash/`, if it appears, is not picked up as a source by a later
      compile: the next **Luka: Compile** still reports "nothing to do".
- [x] Editing a source rather than deleting it also opens the modal, and its
      "may be deleted" list is empty.
- [x] A compile whose diff is only additions opens no modal at all.

### 14. Health check

- [x] **Luka: Health check** writes `wiki/_health.md` and opens it, with no
      notice about model calls because it makes none.
- [x] It lists article candidates (links that resolve to nothing), orphan pages,
      citations naming files the manifest does not know, filed answers with
      their ages, and counts.
- [x] Running it twice in a row produces the same file; resolving a link by
      writing the page it wanted removes it from the candidates on the next run.
- [x] Running it while a compile is in flight shows "Luka is busy: compile".

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
- [x] Compile enough sources to pass the predicate (20+ nodes and 1.5+ link
      pairs per node). After the refresh, the banner disappears.
- [ ] A markdown source with **two or more** reachable remote images localizes
      all of them on its *first* compile, with no source failing. (§6.3 fetches
      four at a time into a `raw/assets/` folder none of them has created yet.)
- [ ] Hand-editing `.obsidian/plugins/luka/data.json` to
      `"contextBudgetTokens": 0`, `"compileConcurrency": "two"` or
      `"requestTimeoutMs": 0` and compiling still behaves: the run completes,
      pages keep their grounding, and nothing is rewritten from an empty
      context. Restore the file afterwards.

### 17. What to add next

The second pane, and the newest code in the plugin. Everything here is free —
it makes no model call at all — and nothing it does writes to the vault.

- [ ] **Luka: What to add next** opens a pane titled "What to add next" in the
      right sidebar. Running the command again *reveals* that pane rather than
      opening a second copy, and **no new ribbon icon appears** — §8.1 still
      allows exactly one, and it is the graph's.
- [ ] Opened by the command, it scans at once: the status line gives counts and
      cards appear. No progress notice about model calls, because it makes none.
- [ ] Restart Obsidian with the pane open. It comes back reading "Press Refresh
      to scan…", with no cards and nothing in the console, and stays that way
      until you press **Refresh** or run the command. (Invariant 1: a pane
      Obsidian restored was opened by nobody, so it walks nothing on its own.)
- [ ] A **New article** card names a target at least two pages link to that no
      title or alias resolves. The bold number matches the chip, the sentence
      names the citing pages, and the glyph shows a dashed hollow centre with
      one dot per citing page — "+k more" past eight.
- [ ] A **Thin evidence** card names a page whose `## Sources` block has exactly
      one entry, and the sentence names that entry. At most five appear, and no
      `wiki/sources/` page is among them (each cites exactly its own raw file).
- [ ] Names with an underscore or camelCase, and names already inside an
      existing page's title, sort after the rest, read dimmer, and say "low
      confidence" on the chip. They are still listed.
- [ ] **Find sources** shows a notice with a search string built from the card's
      title and citing pages, and puts the same string on the clipboard — paste
      it somewhere to confirm. No browser opens and nothing leaves the machine.
- [ ] **Ask** opens the Ask modal with the question already written in it.
      Enter asks it; Esc cancels and asks nothing.
- [ ] **Dismiss** removes the card. It stays gone after Refresh and after an
      Obsidian restart, and `.obsidian/plugins/luka/data.json` gains a
      `dismissedGaps` list.
- [ ] Write the page a dismissed New-article card wanted, press **Refresh**,
      then dismiss any other card: the stale key has gone from `data.json`.
- [ ] With the pane open and armed, run **Luka: Compile** on a changed source.
      The cards update on their own when it finishes. A compile that reports
      "nothing to do" leaves them exactly as they were.
- [ ] The filter box hides non-matching cards as you type, matching on the
      title, the citing pages and the citation. Clearing it restores them, and
      the status line's count follows.
- [ ] Narrow the sidebar until a card is under about 200px: the glyph
      disappears and the words stay readable. Widen it and the glyph returns.
      Switching between dark and light recolours the glyphs with no reopen.
- [ ] After all of the above, `git status` in the vault shows nothing new: the
      pane has written no file anywhere.
