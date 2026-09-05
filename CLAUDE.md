# Luka — facts for reviewers and fixes

Spec: [handoff.md](handoff.md) (authoritative; §2 = invariants, §16 = binding
non-goals). Decision log: [BUILD-NOTES.md](BUILD-NOTES.md) — deviations and
their reasons live there, check it before calling a divergence a bug.

## Test command

```
npm test
```

(vitest, `tests/**`, exercises `src/core` only.) This is the green/red gate
for fixes. Fuller pre-commit checks, run separately when relevant:
`npm run check:boundary`, `npm run lint`, `npm run typecheck`, `npm run eval`.
Instruments scale up via env: `CHURN_SEEDS=1500`, `FUZZ_SEEDS=1500`,
`CHURN_FIRST=<seed>` pins one churn seed for diagnosis. The Obsidian plugin
surface has no automated tests — it is covered by the manual checklist in
README.md §"Manual checklist".

## Invariants (fix-relevant subset — full list is handoff.md §2)

- Nothing runs without explicit user invocation: no watchers, timers,
  auto-compile, or background processes. (§2.1)
- One global operation lock; a second invocation shows "Luka is busy". (§2.2)
- The ingest manifest records only sources that completed successfully. (§2.3)
- The model writes prose only; code writes all frontmatter, citation blocks,
  footers, and the index. (§2.5)
- `src/core/` never imports `obsidian` (`npm run check:boundary`). (§2.6)
- User-placed files in `raw/` get exactly three sanctioned in-place writes
  (frontmatter where absent, image-link rewrites, markers), on markdown/text
  only; `wiki/` is machine-owned and regenerated wholesale. (§2.7)
- `_`-prefixed basenames are infrastructure: never graph nodes, edges, or
  retrieval candidates. (§2.8)
- Model-call counts are deterministic functions of the worklist; compile on
  an unchanged vault makes zero calls. (§2.12)
- Frontmatter annotation is byte-stable across runs (unknown keys appended
  alphabetically) — §6.2's hash-after-annotation rule depends on it.
- Deletes go through Obsidian's trash (`trashSystem`/`trashLocal`), never a
  permanent unlink.

## Known coupling points

Places where fixing one thing has broken another, from the recorded history.
BUILD-NOTES' own summary: "in this project a fix has been the likeliest thing
to break something" — review fix diffs harder than feature diffs.

- **The invariant-7 write guard / rename-derivative subsystem**
  (`claimDerivative`, `chooseTarget`, `renames.ts`). Widening or loosening
  the guard destroyed user data twice and was reverted twice. Tripwire:
  deleting the float branch must fail exactly 7 tests; deleting
  `chooseTarget`'s recorded-path fallback exactly 1. If those counts move,
  the rename subsystem was touched.
- **Trace writer ↔ trace parser** (`writeTrace`/`parseTrace`, §8.3).
  *Resolved 2026-09-05 by changing the grammar, which is what three failed
  parser fixes were each missing.* The writer now emits one entry to a line;
  a newline cannot occur in a title or a path, so there is no second reading
  and nothing is lost. The parser still accepts the old comma-separated form,
  with its known loss counted via `Trace.unparsed`, because notes written
  before the change exist and §9 replays them. The coupling is now narrower
  but real: two grammars are read and one is written, so a change to the
  writer must keep the old reader, and dropping the old reader silently
  breaks every note already on disk.
- **The title/alias namespace.** One namespace with two identity rules —
  comparison (NFC fold) and length (200 UTF-8 bytes) — keyed by six tables.
  Fixes unifying one rule have fragmented the other; it took five review
  rounds to converge. Any change must apply to all tables at once.
- **Vendor error message ↔ retry behavior.** The provider error text is both
  display and a behavioral input (§11's temperature re-run regex). Clipping
  it for display broke compiles; `message` (clipped, display) vs
  `vendorMessage` (full, decisions) is a load-bearing split.
- **Settings are read live, per run.** Snapshotting them at plugin load broke
  invariant 9 (a freshly typed API key never reached the provider). The
  per-run copy must be deep for `models`.
- **Page table feeds both the graph and the rename path.** `GraphNode` /
  `buildGraph` changes can silently alter rename behavior; the 7/1 mutation
  counts above are the tripwire.
- **The readable/live seam** (`readable`, `bodyOfSource`, `isLive`,
  `readableFromManifest`, `readablePathFor`, `readablePathOf`,
  `cascadeScope.live`). Seven answers to two overlapping questions that
  disagree at the edges; deferred to its own milestone. Local fixes here
  drift the siblings — change all or none.
- **Compile's write phase ↔ the graph cache.** `runCompile` marks its write
  boundaries through `WritePhase`; a walk overlapping them publishes nothing
  and is not returned to its caller. Moving `writes.begin()` past the first
  write, or dropping the `finally` around `writes.end()`, changes which
  snapshots are trusted, and nothing outside `tests/graph.test.ts` notices.
  The predecessor asked `lock.busyWith` at walk start instead and was wrong
  four ways at once — the lock is a proxy for "writes are in flight" that is
  both too coarse (it covers the scope preview, which writes nothing) and too
  narrow (it cannot see a walk already running).
