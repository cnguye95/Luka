# Luka — Build Specification

Audience: the execution agent (Claude Code). Everything here is decided.
Build what is written; do not add features, alternatives, or scope.

## 0. How to work from this document

- Read the whole document before writing code.
- Where this document is silent on a detail, choose the smallest option
  consistent with §2's invariants and record the choice as one line in
  `BUILD-NOTES.md` at the repo root. Never resolve silence by adding scope.
- Follow the milestones in §15 in order. A milestone is done when its
  acceptance criteria pass and `npm test` is green.
- §16's non-goals are binding. Do not implement anything listed there, even
  if it seems easy or natural.

## 1. What Luka is

Luka is an Obsidian plugin that maintains a personal knowledge wiki the way
Andrej Karpathy's public post describes: the user drops source documents
into `raw/`, an LLM "compiles" them into a linked markdown wiki, the user
asks questions answered from that wiki with citations, answers can be filed
back in so explorations accumulate, and a custom graph pane makes the
retrieval mechanism itself visible. Retrieval is graph-based (Personalized
PageRank over wikilinks) — no vector database, no embeddings, no chunking.

## 2. Invariants — checkable, non-negotiable

1. Compile and every other operation run only on explicit user invocation.
   No file watchers, no timers, no auto-compile, no background processes,
   no HTTP servers.
2. One global operation lock: compile and ask are mutually exclusive; a
   second invocation shows a notice "Luka is busy: <operation>".
3. The ingest manifest is written only for sources that complete
   successfully. A missing manifest is a first run, never an error.
4. Ingest problems surface as inline HTML-comment markers in the affected
   file. There is no ingest report and no aggregate count.
5. Citation blocks, frontmatter, footers, and the index are written by
   code, never by the model. The model writes prose only.
6. Nothing under `src/core/` imports the `obsidian` package. Enforced by a
   check script run in CI (`npm run check:boundary`).
7. `wiki/` is machine-owned: pages are regenerated wholesale; human edits
   there are not preserved. User-placed files in `raw/` receive exactly
   three sanctioned in-place writes, on markdown/text sources only:
   frontmatter written where absent, inline-image link rewriting, and
   markers. Nothing else in a user-placed file is ever modified. Derivative
   files Luka wrote are Luka's to rewrite.
8. Pages and files whose basename starts with `_` are infrastructure: never
   graph nodes, never edge sources, never retrieval candidates.
9. The provider API key lives in plugin settings (`data.json`), is sent
   only to the configured provider endpoint, and is never written anywhere
   in the vault.
10. Every provider call goes through the reliability wrapper (§11): timeout,
    retries with backoff, per-task max_tokens cap.
11. Answer notes are written atomically on success only; a failed query
    writes nothing.
12. All model-call counts are deterministic functions of the worklist:
    compile = S inventory calls + P page-generation calls (+1 vision call
    per orphan image); ask = ≤ 3 calls.

## 3. Repository layout and environment

TypeScript strict, esbuild, Node ≥ 20 (`engines` + `.nvmrc`). Runtime
dependencies: `d3-force`, `js-yaml`, `turndown`. Dev: esbuild, typescript,
a test runner (vitest), eslint. No frameworks. PDF text extraction for M5
may add one library, chosen at that milestone and logged in BUILD-NOTES.

```
luka/
  manifest.json            Obsidian plugin metadata (id: luka)
  package.json  tsconfig.json  esbuild.config.mjs  .nvmrc
  README.md  BUILD-NOTES.md
  src/
    core/                  Obsidian-free. Injected adapters only.
      types.ts             shared types (PageKind, PageMeta, GraphSnapshot, …)
      adapters.ts          FsAdapter, HttpAdapter interfaces
      hash.ts  manifest.ts lock.ts  tokens.ts  markers.ts  yaml.ts
      normalize/           index.ts, html.ts, pdf.ts, repo.ts, dataset.ts,
                           image.ts, smell.ts
      compile/             discover.ts, inventory.ts, dedup.ts, generate.ts,
                           links.ts, citations.ts, cascade.ts, indexdoc.ts
      graph/               build.ts, ppr.ts
      retrieve/            pipeline.ts, lexical.ts, assemble.ts
      answer/              synthesize.ts, trace.ts, fileback.ts
      health.ts
      provider/            types.ts, wrapper.ts, anthropic.ts
                           (openai-compat.ts in M5)
    plugin/                Obsidian adapter, thin.
      main.ts  settings.ts  commands.ts  ask-modal.ts  scope-modal.ts
      fs-obsidian.ts  http-obsidian.ts  notices.ts
      graph-view/          view.ts, render.ts, sim.ts, overlay.ts
  eval/                    fixture-vault/, queries.yaml, run.ts
  demo/raw/                small committed demo corpus
  tests/                   unit tests for core
  .github/workflows/ci.yml build + test + boundary check + eval
```

Adapters: `FsAdapter` (read, write, list, stat, move, exists, mkdir) and
`HttpAdapter` (request with headers/body/timeout). The plugin implements
them over Obsidian's Vault API and `requestUrl` (avoids CORS); eval and
tests implement them over `node:fs` and `fetch`.

## 4. Vault data model

Folders (created on demand):

```
raw/                 user-placed originals + Luka-written normalized .md
raw/assets/          fetched inline images, filenames = content hash + ext
wiki/sources/        one page per source
wiki/entities/
wiki/concepts/
wiki/_index.md       generated index document
wiki/_health.md      generated health report
answers/             answer notes (un-filed)
raw/answers/         filed answer notes (they become sources)
```

Plugin folder `.obsidian/plugins/luka/`: `main.js`, `manifest.json`
(Obsidian's), `data.json` (settings), `ingest-manifest.json` (ingest state:
JSON map of vault-relative source path → SHA-256 content hash).

Frontmatter — exact keys:

- Normalized files Luka writes into `raw/` (and passthrough sources where
  absent): `ingested` (ISO date), `source-format`
  (`md|txt|html|pdf|repo|dataset|image`), `origin-url` (when known),
  `derived-from` (vault path of the original; present on derivatives only).
- Wiki pages: `kind` (`source|entity|concept`), `aliases` (list), `summary`
  (one line), `updated` (ISO date). Source pages additionally:
  `source` (`"[[raw/<file>]]"`).
- Answer notes: `kind: answer`, `question`, `asked` (ISO datetime),
  `mode` (`A|B`), `grounded` (`true|false`).

Source discovery (who is a source): the change-detection scanner walks
`raw/` recursively, skipping `raw/assets/` entirely and skipping any file
whose frontmatter contains `derived-from`. Everything else in `raw/`
(including `raw/answers/`) is a source and is subject to the manifest's
four rules (§6.2). Only sources enter the manifest.

Identity and naming: a source's identity is its vault path. Wiki page
filenames are the page title sanitized (strip `[]#^|\/:`; strip leading
`_` and `.` so no generated page can collide with the infrastructure
prefix), unique across `wiki/`. Overwriting a source in place is an
update; delete-then-add at a different path is two events; the same hash
vanishing at one path and appearing at another is a rename — skip
regeneration, update the manifest path.

Links: wiki→wiki links are `[[Title]]`; links into sources are full-path
`[[raw/...]]`. A code post-pass over every generated body resolves links
against the title+alias table, rewriting `[[Alias]]` → `[[Title|Alias]]`;
links that resolve to nothing are left untouched (they are future-article
signals, not errors).

Citation block — code-written, at page foot, idempotently regenerated:

```
<!-- citations:start -->
## Sources
- [[raw/paper.md]]
<!-- citations:end -->
```

Every wiki page has one. A source page's block cites its own raw file.

Marker idiom — one format for every ingest/answer surface problem:
`<!-- image not fetched: fig3.png — fetch failed, HTTP 404 -->`,
`<!-- repo file omitted: <path> — <reason> -->`,
`<!-- normalization suspect: <reasons> -->`,
`<!-- truncated for context budget -->`,
`<!-- link outside retrieved set: <target> -->`.
Wording for images is always "not fetched", never "removed".

Index document `wiki/_index.md` — generated each compile from the in-memory
page table (which is built from wiki frontmatter):

```
# Index
## Sources
- [[Paper Title]] — one-line summary (aliases: a, b)
## Entities
- ...
## Concepts
- ...
```

## 5. Core public contract

`src/core` exposes (via a façade `core/index.ts`):

- `compile(opts): CompileResult` — full pipeline §6; emits progress
  callbacks; respects the lock.
- `previewCompile(): ScopePreview` — the four-rule diff plus cascade scope
  (pages to regenerate, pages that may be deleted) without doing work.
- `ask(question, opts): AnswerResult` — pipeline §7–§8; writes the answer
  note via FsAdapter.
- `fileBack(answerPath)` — §8.4.
- `getGraph(): GraphSnapshot` — nodes (path, title, kind, degree), edges.
- `computePPR(seedPaths, {snapshots?}): { scores, iterations? }`.
- `healthCheck(): writes wiki/_health.md`.
- `onGraphRebuilt(cb)` — fired after compile and after load.
- Trace helpers: `writeTrace`, `parseTrace` (shared by answer writing and
  the pane's replay).

## 6. Ingest and compile pipeline

Order per run: discover → normalize (changed sources) → extract → generate
→ post-process → index. Normalization is a phase of compile, not a command.

### 6.1 Normalization

One interface, per-type strategies. Compile's extraction only ever receives
markdown. Normalized output is persisted next to the original in `raw/`,
named `<original-stem>.md`, with `derived-from` frontmatter.

| Source | Strategy |
|---|---|
| `.md`, `.txt` | Passthrough: no derivative; in-place annotation only (frontmatter where absent, image localization, markers) |
| `.html` | turndown → `.md` |
| `.pdf` (M1) | Text-layer extraction → `.md` |
| `.pdf` hard cases (M5) | Layout-aware extraction; vision fallback; OCR for scanned |
| repo (see §6.4 for detection) | Concatenate per §6.4 → `.md` |
| dataset (`.csv`, `.tsv`) | Descriptor card: schema, row count, head sample (10 rows), provenance → `.md`; original retained |
| image, orphan (`.png .jpg .jpeg .gif .webp`, user-placed in `raw/`) | Vision pass → `.md` describing it; original retained |
| image, inline (referenced by another source) | Localization only (§6.3); file, no page |

Files in `raw/` with unsupported extensions are skipped with one notice
naming them, and are never written to the manifest — so they surface again
each compile rather than failing silently.

### 6.2 Change detection — the four rules

Sources are identified by SHA-256 of content. Timestamps are never used.

| Manifest | Filesystem | Meaning | Action |
|---|---|---|---|
| path present, hash matches | file present | unchanged | skip |
| path present, hash differs | file present | modified | reprocess |
| path present | file absent | deleted | cascade (§6.6) |
| path absent | file present | new | ingest |

Rename (same hash, new path, old path gone): update manifest, skip
regeneration. Compile on an unchanged vault does nothing and makes zero
model calls.

**Hash timing (prevents a reprocess loop).** The manifest records the
SHA-256 of the source file's bytes *as they exist when processing
completes* — i.e., after any sanctioned in-place writes (frontmatter,
image-link rewrites, markers) on markdown/text sources. For sources with a
derivative, the hash is of the original file; the derivative is never
hashed into the manifest.

**Derivatives.** User edits to a derivative do not trigger anything — the
four rules see originals only — and persist until the original changes;
this is the sanctioned repair path for bad extractions. If a manifested
source's derivative is missing at compile time, reprocess that source as if
modified.

### 6.3 Inline image localization

For each remote image reference in a normalized document: fetch with
timeout; on failure leave the remote link and mark. References that are
already local paths or `data:` URIs are left untouched. Discard (with
marker) when: not an image by content-type; under 100×100 true pixels
(read from header bytes, don't decode); under 5KB; or name/alt matches
`logo|avatar|icon|sprite|badge|pixel` *and* the prose does not reference
it. When uncertain, keep. Kept: write to `raw/assets/<hash>.<ext>`, rewrite
the link. Fetch concurrently, cap 4.

### 6.4 Repository selection

**Detection:** a directory anywhere under `raw/` is a repo iff it contains
`.git/` or a file named `.luka-repo` (an empty marker the user drops in;
documented in README). All other directories are transparent organization —
files inside them are individual sources. **Identity:** the repo's manifest
path is the directory path; its hash is the SHA-256 over the ordered
concatenation of `(relative path + file bytes)` for every included file, so
the four rules apply to repos unchanged. Files inside a detected repo are
never individual sources.

**Selection:** include `README*` first, then `docs/`, then files by
extension whitelist
(`.md .ts .js .py .rs .go .java .c .h .cpp .rb .sh .toml .yaml .json`),
breadth-first path order, each under a `## <path>` header. Exclude `.git`,
`node_modules`, `dist`, `build`, `out`, `vendor`, lockfiles, binaries.
Caps: 100KB/file, 1MB total; omissions leave markers.

### 6.5 Extraction and generation

Two calls, single pass per compile:

- **Call A — inventory**, per changed source: input is the normalized
  markdown (frontmatter stripped; body only); output is strict JSON
  `{ "source_summary": str, "items": [{ "title": str, "kind":
  "entity"|"concept", "aliases": [str], "summary": str }] }`. Prompt must
  instruct: qualified titles for ambiguous names ("Mercury (element)");
  aliases include obvious variants; temperature 0.
- **Merge**: all inventories in the run merge into one work-set.
  Dedup: case-insensitive match of each item's title and aliases against
  the existing title+alias table (kind ignored). Match → that page gains
  this source as a citer and is queued for regeneration. No match → new
  page queued. Also queued: every page citing a modified/deleted source.
- **Call B — page generation**, once per queued entity/concept page: input
  is title, kind, aliases, and the full normalized bodies of *all* citing
  sources (token-budgeted using the same context-budget default as
  retrieval, whole sources in citation order, truncation marker if the
  budget forces it); never the old page text. **The citation block is the
  persistent citer record:** a page's citing set = surviving entries of its
  existing block ∪ this run's inventory matches; the block is rewritten
  from that set afterward. Output is the page body prose with
  `[[wikilinks]]`. Prompt must instruct: link freely to concepts/entities
  it names; do not write citations, frontmatter, or headers duplicating
  the title.
- **Source pages** are assembled by code from Call A's `source_summary` —
  no Call B. A source whose inventory returns zero items still gets its
  source page.
- **Post-process by code**: frontmatter, link post-pass, citation block,
  `updated` date; then regenerate `wiki/_index.md`.
- **Smell test** (PDF-derived only): flag suspiciously short output vs page
  count, repeated lines at intervals (running headers), high
  sentence-fragment ratio → marker at head of the normalized file.

### 6.6 Deletion / modification cascade

Before work: show the scope preview (counts + lists of pages to regenerate
and pages that may be deleted) in a confirm modal. Then: affected pages
regenerate from surviving citing sources; a page with zero remaining
source citations is deleted; a visited set prevents reprocessing a page
twice per run; the cascade runs to completion. Modification uses the same
machinery.

## 7. Retrieval

### 7.1 Graph

Nodes: every file under `wiki/` (minus `_`-prefixed) plus every manifest
source's readable markdown (the source itself if `.md`/`.txt`, else its
derivative). A raw node's display title is its basename. Edges: every
`[[wikilink]]` occurring anywhere in a node's file — body, citation block,
frontmatter `source:` — resolved to a node; links that resolve to no node
contribute nothing. Undirected, uniform weight, deduplicated per pair;
`_` files contribute nothing. Built in memory at plugin load and after
compile; no cache file.

### 7.2 PPR

Exact power iteration. Personalization: uniform over seed nodes. Update:
`v' = α·A·v + (1−α)·p` with α = 0.85, A the degree-normalized undirected
adjacency. Degree-0 nodes propagate nothing (zero column) and hold teleport
mass only. Converged when L1(v'−v) < 1e-8, max 100 iterations. Determinism:
node order lexicographic by path; ties in ranking break lexicographically.
`snapshots: true` retains v after each iteration (≤ 100) for the pane.

### 7.3 Modes

Predicate each query: Mode B (graph) iff node count ≥ 20 AND (total
distinct written link pairs / node count) ≥ 1.5; else Mode A. The seed call
runs in both modes; the mode governs ranking only, and is recorded on the
answer.

### 7.4 Pipeline

1. Page table (wiki pages only) renders to the same text as `_index.md`.
2. Seed call (strict JSON): given the question + index text, return
   `{ "seeds": [paths ≤ 8], "keywords": [strings ≤ 12] }`. Returned paths
   are validated against the page table; invalid ones are dropped. Any wiki
   page whose full title or alias appears case-insensitively as a substring
   of the question is force-included as a seed.
3. Rank. Mode B: PPR over the full graph seeded on (2). Mode A: wiki pages
   only; lexical score = title exact 10, alias exact 8, title/alias
   substring 4, keyword in summary 2, keyword in body 1 (per keyword, body
   scan affordable because Mode A implies a small vault).
4. Assemble top-K whole nodes (wiki or source content) in rank order under
   the context budget (default 40,000 tokens ≈ chars/4; K cap 12). Never
   split a page; a single page over the whole budget is tail-truncated with
   the marker.
5. Zero seeds and zero lexical candidates → skip retrieval; synthesis runs
   from model knowledge and the answer is labeled ungrounded.

## 8. Ask, answers, filing

### 8.1 Commands

"Luka: Compile" (with scope preview when the diff includes deletions or
modifications; the plugin acquires the operation lock before the preview
and holds it through confirm and compile), "Luka: Ask the wiki" (modal),
"Luka: File this answer" (active answer note), "Luka: Health check",
"Luka: Open graph". One ribbon icon: the graph pane.

### 8.2 Synthesis

Input: question + assembled pages, each delimited and labeled with its
title/path/kind. Prompt requirements: answer in markdown; attribute claims
with inline `[[links]]` drawn only from the provided set; end with exactly
one fenced JSON block `{"missing_information": [...]}` (empty list when
done). Code strips the block. If `missing_information` is non-empty and
follow-up is enabled, run one expansion round — identical in both modes:
lexical-score the missing-information strings (as keywords) over wiki
pages, take the highest scorers not already assembled, append them under
the remaining context budget, and synthesize again with the union. No
second seed call, no second PPR. Hard cap: one follow-up round; ≤ 3 model
calls total.

### 8.3 Answer note

Path `answers/YYYY-MM-DD-HHmm <question-slug>.md` (slug: lowercase,
alphanumerics and dashes, max 60 chars). Frontmatter per §4. The `top:`
trace line lists at most 10 entries, scores to 4 decimals. Body:
(ungrounded case) `> [!warning] Not grounded in your wiki` callout
first; then the answer with validated links — any link outside the
retrieved set is unlinked to plain text plus marker; then code-written:

```
<!-- sources:start -->
## Sources consulted
- [[Page Title]]
<!-- sources:end -->
<!-- trace:start -->
## Retrieval trace
- mode: B
- seeds: [[A]], [[B]]
- round2: no
- top: [[X]] 0.0812, [[Y]] 0.0631
<!-- trace:end -->
```

Open the note in a new leaf on success. On failure: notice, nothing
written.

### 8.4 Filing

Move the note to `raw/answers/<same name>` (on collision, append `-2`,
`-3`, …), stripping the trace block (keep sources block). Notice: "Filed.
Run Compile to integrate." No auto-compile. The next compile treats it as a
new source through the normal path — no redundancy gate.

## 9. Graph pane

An `ItemView` (`luka-graph`). Canvas 2D rendering; `d3-force` simulation
only, initial positions seeded by hashing page path; simulation cools to a
stop, drag reheats locally. Colors and fonts from Obsidian CSS variables.

Encoding: node color by kind (three muted theme-derived colors + one for
raw source nodes), baseline radius ∝ log(degree+1), labels on hover plus
top-10 by current metric. Overlay: heat ramp = PPR score, ring = seeds,
stroke = top-K, non-neighborhood dimmed. Query inspection on a Mode-A
vault overlays seeds and lexical top-K without a PPR heat ramp, and the
banner says why.

Interactions: pan/zoom; hover tooltip (title, kind, summary); drag-to-pin;
double-click opens the page; Esc clears overlay; lexical filter box dims
non-matches (no model call); click a node → instant PPR from that node
(no model call); query box with a submit button labeled "Inspect (1 model
call)" → runs pipeline steps 1–3 and overlays; "Show retrieval on graph"
(command + button when an answer note is active) → parses the trace and
overlays, zero calls, graceful notice if the note has no trace. PNG export
button. Iteration scrubber (M5): when an overlay was computed with
snapshots, a slider scrubs per-iteration PPR vectors.

States: below the mode predicate, banner "Mode A (lexical) active — graph
ranking off" with live counts; empty vault → pointer at Compile. The pane
is read-only, never blocked by the lock, and renders the last-built
snapshot; it refreshes on the graph-rebuilt event and via a refresh button.
Degradation: drop labels first; target smooth pan/zoom at 500+ nodes.

## 10. Health check

"Luka: Health check" rewrites `wiki/_health.md` wholesale from one vault
scan, no model calls: unresolved wikilinks grouped by target (labeled
"article candidates"), orphan pages (no inbound links), citation entries
pointing at raw files absent from the manifest, filed answer-sources list
with ages, and count summaries.

## 11. Provider layer and reliability

`LLMProvider.complete({ task, system, user, maxTokens, temperature,
json })`. Tasks: `inventory`, `page-generation`, `seed-selection`,
`synthesis`, `vision`. Settings map each task to a model id; defaults to a
current small Anthropic model for `inventory`/`seed-selection` and a
current mid-tier model for `page-generation`/`synthesis`/`vision` — pick
current model ids at build time and record them in BUILD-NOTES. JSON tasks:
temperature 0, parse, one repair retry appending the parse error.

Wrapper on every call: 120s timeout; 2 retries with exponential backoff +
jitter on 429/5xx/network, honoring `Retry-After`; per-task max_tokens
caps (inventory 2000, seeds 500, generation 3000, synthesis 4000, vision
1500). Compile call concurrency: 2. A failed source is skipped with a
notice; the success-only manifest rule retries it next compile.

Anthropic adapter: Messages API via HttpAdapter. Vision: image content
block, base64. (M5: OpenAI-compatible adapter, base URL configurable.)

## 12. Settings tab

API key (password field), provider selector (M5+), task→model map, context
budget, K, mode-predicate pair, follow-up toggle, PPR α/ε/max-iter
(collapsed "advanced"). All defaults per §17.

## 13. Eval harness

`eval/fixture-vault/` — a committed, pre-built small vault (~20 sources,
~40 wiki pages, realistic links; author it by hand or by one-time
generation, then commit; no model calls at eval time), including its own
`ingest-manifest.json` so graph construction knows the source set.
`eval/queries.yaml` — 15–20 entries: `query`, `expect` (list of page
paths). `eval/run.ts` — headless over core with node adapters: CI mode
seeds by exact title/alias match only (no model), runs both modes' ranking,
reports recall@5, recall@10, MRR per query and mean; exits nonzero below a
floor recorded in the YAML. `--live` flag: full pipeline with a real key,
prints the same metrics; never in CI. CI workflow: build, unit tests,
boundary check, eval CI mode. README states plainly that CI numbers measure
ranking, not the LLM phases.

## 14. Tests (unit, `src/core` only)

Minimum set: hash/manifest four rules incl. rename and derived-skip;
**hash-after-annotation stability** (annotated passthrough source does not
re-read as modified on the next run); **repo hash determinism**;
inline-image filter branches incl. tiebreak-keep; repo selection caps and
ordering; smell-test heuristics; dedup incl. alias hit and qualified-title
collision; link post-pass rewrite and leave-unresolved; citation block
idempotent rewrite; PPR against a hand-computed 5-node fixture, determinism
across runs, degree-0 handling; mode predicate boundaries; lexical scorer;
assembly budget and truncation; trace write/parse round-trip; synthesis
JSON-block strip; fileback move + trace strip + collision suffix. UI is
exercised by a manual checklist in README, not by automated tests.

## 15. Milestones and acceptance criteria

**M0 — Scaffold.** Repo builds (`npm run build` → `main.js`), empty plugin
loads and enables in a test vault, settings tab persists a key and model
map, boundary check + CI skeleton green, vitest runs.

**M1 — Ingest, no-LLM paths.** Normalization for md/txt passthrough, HTML,
simple text-layer PDF, repo, dataset; inline-image localization with
filters and markers; hashing, `ingest-manifest.json`, four rules, source
discovery (derived-skip, assets-skip), rename handling. AC: ingesting
`demo/raw/` yields normalized files with correct frontmatter and markers;
an immediate second compile is a no-op with zero work — including for
in-place-annotated markdown sources (no reprocess loop); unit tests for
all of the above green.

**M2 — Compile.** Provider layer + Anthropic adapter + wrapper; inventory,
merge/dedup, generation, orphan-image vision pass, source pages,
frontmatter/links/citations post-process, index doc, cascade with scope
preview, smell test. AC: demo corpus compiles into a three-kind wiki where
every page has a valid citation block and appears in `_index.md`;
re-compile makes zero model calls (assert via a call counter); deleting a
demo source shows the preview then regenerates/deletes correctly; modified
source reprocesses.

**M3 — Retrieval + Ask + Filing.** Graph build, PPR, modes, pipeline,
assembly, synthesis, answer notes with footers and trace, ungrounded
labeling, follow-up round, lock, filing. AC: eval CI mode runs and reports;
asking on the compiled demo vault yields an answer note whose inline links
all validate; filing moves the note and the next compile ingests it (test
asserts its source page exists); busy-lock notice verified.

**M4 — Graph pane.** Everything in §9 except the scrubber. AC: opens under
1s on the demo vault; click-PPR, query inspection, trace replay, filter,
export all work per spec; maturity banner correct on a tiny vault; theme
switch (dark/light) picks up colors.

—— **Cut-line: the product is shippable here.** ——

**M5 — Stretch, in order:** hard-PDF paths (layout-aware, OCR, vision
fallback), iteration scrubber, OpenAI-compatible adapter.

Under schedule pressure, cut in this order: M5 entirely → scrubber →
follow-up round → eval `--live` → query-inspection overlay (keep click-PPR
and trace replay).

## 16. Non-goals — do not build

Embeddings, vector stores, or chunking in any form; HTTP servers or
endpoints; a CLI binary (keep core CLI-ready, ship no adapter);
internationalization; conversation threading or session state; backup
rotation, settings migration, operation logs; community-plugin-store
submission prep; Marp/matplotlib/slide outputs; LLM-driven lint or health
checks; quote-level provenance injection; preservation of human edits in
`wiki/`; auto-compile on vault events; a redundancy gate on filing.

## 17. Parameter defaults (all user-tunable unless marked fixed)

| Parameter | Default |
|---|---|
| PPR damping α | 0.85 |
| PPR convergence (L1) | 1e-8 (fixed) |
| PPR max iterations | 100 |
| Mode predicate | ≥ 20 nodes AND link-pairs/node ≥ 1.5 |
| Context budget | 40,000 tokens (chars/4) |
| K (assembly cap) | 12 |
| Seeds / keywords caps | 8 / 12 |
| Follow-up round | on, max 1 (fixed cap) |
| Retries / timeout | 2 / 120s |
| Compile concurrency | 2 |
| Image fetch concurrency | 4 (fixed) |
| Image minimums | 100×100 px, 5KB (fixed) |
| Repo caps | 100KB/file, 1MB total (fixed) |
| Dataset head sample | 10 rows (fixed) |
| Snapshot cap (scrubber) | 100 (fixed) |
| Lexical weights | 10/8/4/2/1 (fixed) |
