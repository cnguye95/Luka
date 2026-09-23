# Luka — facts for reviewers and fixes

Design record: [design_decisions.md](design_decisions.md). Its *Principles*
section is the twelve invariants the code is built to (code comments cite them
as `invariant N`), and *Deliberately not built* is the binding list of
non-goals. The rename subsystem keeps a second, separate list, numbered in
roman and cited as `rename invariant N`, defined at the head of
`src/core/compile/renames.ts`. The Obsidian surface is checked by hand against
[MANUAL-CHECKLIST.md](MANUAL-CHECKLIST.md); "checklist item 5.5" in a comment
means that file's section 5, item 5.

## Test command

```
npm test
```

(vitest, `tests/**`, exercises `src/core` and the graph pane's pure modules.)
This is the green/red gate for fixes. Fuller pre-commit checks, run separately
when relevant: `npm run check:boundary`, `npm run lint`, `npm run typecheck`,
`npm run eval`. Instruments scale up via env: `CHURN_SEEDS=1500`,
`FUZZ_SEEDS=1500`, `CHURN_FIRST=<seed>` pins one churn seed for diagnosis. The
Obsidian plugin surface has no automated tests — it is covered by
MANUAL-CHECKLIST.md.

## Invariants (fix-relevant subset — full list: design_decisions.md, Principles)

- Nothing runs without explicit user invocation: no watchers, timers,
  auto-compile, or background processes. (invariant 1)
- One global operation lock; a second invocation shows "Luka is busy". (2)
- The ingest manifest records only sources that completed successfully. (3)
- The model writes prose only; code writes all frontmatter, citation blocks,
  footers, and the index. (5)
- `src/core/` never imports `obsidian` (`npm run check:boundary`). (6)
- User-placed files in `raw/` get exactly three sanctioned in-place writes
  (frontmatter where absent, image-link rewrites, markers), on markdown/text
  only; `wiki/` is machine-owned and regenerated wholesale. (7)
- `_`-prefixed basenames are infrastructure: never graph nodes, edges, or
  retrieval candidates. (8)
- Model-call counts are deterministic functions of the worklist; compile on
  an unchanged vault makes zero calls. (12)
- Frontmatter annotation is byte-stable across runs (unknown keys appended
  alphabetically) — the hash-after-annotation rule depends on it.
- Deletes go through Obsidian's trash (`trashSystem`/`trashLocal`), never a
  permanent unlink.

## Known coupling points

Places where fixing one thing has broken another. In this project a fix has
been the likeliest thing to break something — review fix diffs harder than
feature diffs. The reasoning behind each seam is in design_decisions.md
(decisions 6, 7, 9, 11, 15 and 18).

- **The invariant-7 write guard / rename-derivative subsystem**
  (`claimDerivative` and `chooseTarget` in `src/core/normalize/index.ts`,
  `src/core/compile/renames.ts`). Widening or loosening the guard destroyed
  user data twice and was reverted twice. Tripwire: deleting the float branch
  in `renames.ts` must fail exactly 7 tests; deleting `chooseTarget`'s
  recorded-path fallback exactly 1. If those counts move, the rename subsystem
  was touched.
- **Trace writer ↔ trace parser** (`writeTrace`/`parseTrace`). The writer
  emits one entry to a line; a newline cannot occur in a title or a path, so
  there is one reading and nothing is lost. The parser still accepts the old
  comma-separated form, with its known loss counted via `Trace.unparsed`,
  because notes written before the change exist and the pane replays them.
  Two grammars are read and one is written: a change to the writer must keep
  the old reader, and dropping the old reader silently breaks every note
  already on disk.
- **The title/alias namespace.** One namespace with two identity rules —
  comparison (`handleOf`, NFC fold) and length (`titleStem`, 200 UTF-8 bytes)
  — keyed by six tables. Fixes unifying one rule have fragmented the other.
  Any change must apply to all tables at once.
- **Vendor error message ↔ retry behavior.** The provider error text is both
  display and a behavioral input (the temperature re-run regex). Clipping it
  for display broke compiles; `message` (clipped, display) vs `vendorMessage`
  (full, decisions) is a load-bearing split.
- **Settings are read live, per run.** Snapshotting them at plugin load broke
  invariant 9 (a freshly typed API key never reached the provider). The
  per-run copy must be deep for `models`.
- **Page table feeds both the graph and the rename path.** `GraphNode` /
  `buildGraph` changes can silently alter rename behavior; the 7/1 mutation
  counts above are the tripwire.
- **The readable/live seam** (`readable`, `bodyOfSource`, `isLive`,
  `readableFromManifest`, `readablePathFor`, `readablePathOf`,
  `cascadeScope.live`). "Where is a source's readable markdown" has one
  answer, `readableMarkdown` in `src/core/readable.ts`; the three functions
  that used to decide it separately all call it, and the case they disagreed
  on — a converting source with no derivative recorded — is pinned by test.
  "Is this source still live" is still answered by `isLive`, `isPending` and
  `cascadeScope.live` independently. Local fixes there drift the siblings —
  change all or none.
- **Compile's write phase ↔ the graph cache.** `runCompile` marks its write
  boundaries through `WritePhase`; a walk overlapping them publishes nothing
  and is not returned to its caller. Moving `writes.begin()` past the first
  write, or dropping the `finally` around `writes.end()`, changes which
  snapshots are trusted, and nothing outside `tests/graph.test.ts` notices.
  The lock is not a usable proxy for "writes are in flight": it is too coarse
  (it covers the scope preview, which writes nothing) and too narrow (it
  cannot see a walk already running).
