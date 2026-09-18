# Luka

An Obsidian plugin that compiles source documents you drop into `raw/` into a
linked markdown wiki, then answers questions from that wiki with citations.
Retrieval is graph-based (Personalized PageRank over wikilinks) — no vector
database, no embeddings, no chunking.

Why it is built this way — the decisions taken, the alternatives weighed, and
what pins each one — is in [design_decisions.md](design_decisions.md). The
Obsidian surface is checked by hand against
[MANUAL-CHECKLIST.md](MANUAL-CHECKLIST.md).

## Table of Contents

- [Compile](#compile)
- [Page Types and Graph Colours](#page-types-and-graph-colours)
- [Development](#development)
- [Running it in Obsidian](#running-it-in-obsidian)
- [Commands](#commands)
- [Eval](#eval)
- [Testing](#testing)

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
npm test               # vitest; see Testing below
npm run check:boundary # asserts src/core never imports `obsidian`
npm run lint
```

### Layout

- `src/core/` — everything that decides anything, with no Obsidian import.
  `compile/` holds discovery and the four change-detection rules, renames,
  inventory, dedup, page generation and the cascade; `normalize/` one strategy
  per source type; `graph/` the link graph and PageRank; `retrieve/` seeds,
  ranking and assembly; `answer/` synthesis, the trace, filing and "Add next";
  `provider/` the reliability wrapper and the two transports. `manifest.ts`,
  `health.ts`, `types.ts` (with the settings defaults) and the façade
  `index.ts` sit at the top.
- `src/plugin/` — the thin Obsidian adapter: commands, the settings tab, the
  two modals, the vault and HTTP adapters, and `graph-view/` for the pane.
  `view.ts` is the host-bound shell; `sim`, `render`, `overlay`, `press` and
  `scrub` beside it are pure and tested.
- `tests/` — vitest over `src/core` and the pane's pure modules, including the
  randomized instruments (`churn`, `fuzz-*`, `provider-matrix`).
- `eval/` — the committed fixture vault, its builder, the queries with their
  floors, and the headless runner with its Node adapters.
- `scripts/` — the boundary check and the vault installer. `demo/raw/` is the
  demo corpus.
- `.nvmrc` — the Node version, read by `actions/setup-node` in CI and by `nvm`
  and friends locally, so the two run the same toolchain. `package.json`'s
  `engines` states the floor; this is the version actually used.

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
directory — the graph pane has no layout without it.

**3. Open the vault.** In Obsidian, *Open folder as vault* → `test-vault/`.
It is gitignored, and starts out empty apart from the plugin you just copied in.

**4. Enable the plugin.** Settings → *Community plugins* → turn off Restricted
Mode → enable **Luka**. Keep the developer console open (Ctrl/Cmd-Shift-I): the
manual checklist asks you to watch it in several places, and a plugin that
fails to load says so there.

**5. Choose a provider and set its key.** The Luka settings tab opens on
**Anthropic**; paste a key and you are done. For OpenAI, switch **Provider** to
*OpenAI-compatible* and paste an OpenAI key: the base URL already points at
`https://api.openai.com/v1`, and the model ids move to OpenAI's when you
switch, so there is nothing else to fill in.

Switching moves only ids you have **not** edited. Anything you typed yourself
survives the switch, on the grounds that changing provider is not a request to
throw your work away — so a hand-typed id can outlive the provider it was meant
for, and the tab is where you would see that.

Each provider keeps its own key, so switching back and forth loses neither.
Note that *OpenAI-compatible* is one setting with one key field covering every
server that speaks that API, so moving between OpenAI and a local one does mean
retyping the key.

Settings are the only source — the plugin has no `ANTHROPIC_API_KEY` fallback,
and reads the key live on each run, so a freshly typed one takes effect without
a reload. (The env var is for the optional live tests above and
`npm run eval:live`, which run outside Obsidian.)

### Running it against a local model

Any server speaking the Chat Completions API works. [Ollama](https://ollama.com)
is the shortest path and needs no key at all.

```
ollama pull qwen2.5:7b
```

Then in the settings tab: **Provider** *OpenAI-compatible*, **Base URL**
`http://localhost:11434/v1`, **API key** empty, and all five model ids set to
`qwen2.5:7b`. Ollama serves the OpenAI-compatible endpoint on port 11434 by
default and ignores credentials, so the empty key is correct rather than a
workaround.

Three things worth knowing before you judge the output:

- **Extraction is the hard task, not writing.** `inventory` must return strict
  JSON naming the entities and concepts in a source, and Luka allows one repair
  retry before giving up on it. A 3B model will parse fine and still return an
  empty list, which leaves you source pages and no concept pages — a legal
  outcome by design, so compile succeeds and the wiki stays thin. 7B is
  the smallest size worth using, and Qwen is stronger at structured output than
  Llama at the same size.
- **Lower the context budget to match the model.** It defaults to 40,000 tokens
  and page generation is fed whole sources. A model with a smaller window will
  quietly build pages from truncated input.
- **Vision needs a vision model.** Only orphan images in `raw/` trigger it, so
  if you have none the `vision` row does not matter. If you do, point it at
  something like `llama3.2-vision:11b`; a text-only model will fail that source
  and leave the rest of the compile alone.

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

### If you are working the [manual checklist](MANUAL-CHECKLIST.md)

Do step 6 **last**. Checklist section 2 checks the empty-vault states, and once
the first compile has run you cannot get back to them without deleting `wiki/`
and the manifest.
If the vault lives inside a synced folder (OneDrive, Dropbox), pause the sync
first — files changing underneath a run will muddy the "nothing to do" and
"modifies no files" items.

## Commands

Luka registers six commands. All are invoked from the command palette
(Ctrl/Cmd-P, then type `luka`) — there are no menus, and the single ribbon
icon opens the graph pane.

| Command | What it does |
|---|---|
| **Luka: Compile** | Walks `raw/`, normalizes what changed, and rebuilds the wiki. The scope modal appears first when the diff includes deletions or modifications. |
| **Luka: Ask the wiki** | Opens a modal for one question; writes the answer to `answers/` and opens it. |
| **Luka: File this answer** | Moves the active answer note to `raw/answers/` so the next compile ingests it as a source. Drops the retrieval trace and the `## Add next` section, keeps the sources block. |
| **Luka: Health check** | Writes and opens `wiki/_health.md`: article candidates, orphan pages, citations naming unknown files, filed answers and their ages. Makes no model calls. |
| **Luka: Open graph** | Opens the graph pane. The ribbon icon opens the same one. |
| **Luka: Show retrieval on graph** | Replays the active answer note's retrieval trace as an overlay on the graph. Makes no model calls. |

### Asking without spending

The graph pane has its own question box, and it is not a second way to run
*Ask the wiki*. Typing into `Ask the graph…` and pressing **Inspect (1 model
call)** — or Enter — answers a narrower question: *what would retrieval
actually pull for this?* It makes exactly one model call to choose seeds, ranks
from them, paints the result as an overlay, and stops. No synthesis, no answer,
and no file: the checklist pins that an inspection writes nothing anywhere in
the vault.

On a graph-ranked vault the overlay arrives with a slider beneath it, which
steps back through the walk one iteration at a time: drag it left to watch how
far the walk had reached that early, and right to watch the ranking settle.
Clicking a node gives you the same slider for the same reason. Neither costs
anything — the iterations were retained by the walk that drew the overlay.

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
all: it seeds by exact title and alias match, the way the force-include rule
does, and scores what the ranker returns. Nothing here says whether the seed
call chooses well, whether synthesis writes a good answer, or whether an answer
is grounded — only whether the pages a question should surface come back near
the top. `npm run eval:live` runs the same measurement with the real seed call
(needs `ANTHROPIC_API_KEY`); it is never run in CI.

`npm run eval:fixture` rebuilds the fixture vault from its hand-written sources
in `eval/fixture-vault/raw/`. It calls no model either — the replies are
scripted — and the rebuild is byte-identical, so regenerating the vault does not
move the floors.

## Testing

```
npm test                           # vitest: src/core and the graph pane's pure modules
CHURN_SEEDS=1500 npm test          # randomized vault churn at review scale (default 120 seeds)
FUZZ_SEEDS=1500 npm test           # hostile bytes through the whole pipeline (default 150)
FUZZ_LOCALIZE_SEEDS=1500 npm test  # the image localizer and marker injection (default 200)
PPR_SEEDS=2000 npm test            # PageRank against an independent dense solver (default 250)
CHURN_FIRST=<seed> npm test        # pin one churn seed for diagnosis
```

Every seed is deterministic, so a failing seed reproduces exactly. The live
tests under *Status* need `ANTHROPIC_API_KEY` and never run in CI. CI runs the
boundary check, lint, the build, the unit suite and the eval.

The Obsidian surface — the pane, the modals, the settings tab, the trash — is
checked by hand against [MANUAL-CHECKLIST.md](MANUAL-CHECKLIST.md): 126 items,
all walked, the last on 2026-09-12. A failure there is a regression, not an
unknown. The reasoning behind what the tests pin, and why the tests are shaped
the way they are, is in [design_decisions.md](design_decisions.md).
