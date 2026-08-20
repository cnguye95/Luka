# BUILD-NOTES

One line per decision made where `handoff.md` was silent (§0). Newest section last.

## M0 — Scaffold

- Node floor pinned to 20 in `.nvmrc` and `engines` even though the dev machine runs 24; §3 specifies ≥ 20 and CI should test the floor.
- `manifest.json` sets `isDesktopOnly: true`: the ingest path reads local files and bundles a PDF text extractor, neither of which is mobile-safe.
- Boundary check lives at `scripts/check-boundary.mjs`; §3's tree does not list a `scripts/` folder, and a root-level script is the smallest place to put it.
- Boundary check matches `obsidian` only in import/require positions (not any occurrence of the string), so prose and identifiers cannot trip it.
- `npm run build` runs `tsc --noEmit` before esbuild; esbuild does not typecheck, and §3 mandates TypeScript strict.
- Bundle format is CJS with `obsidian`, `electron`, `@codemirror/*`, `@lezer/*` and Node builtins external — the standard Obsidian plugin bundling contract.
- Build output is not minified: it aids debugging inside Obsidian and no size constraint is specified.
- `.gitattributes` forces LF for text and marks binaries, so SHA-256 content hashes (§6.2) are identical across checkouts and platforms.
- Fixed §17 parameters (image concurrency/minimums, repo caps, dataset head sample, snapshot cap, lexical weights) are module-local constants rather than settings fields, since §17 marks them not user-tunable. `PPR_EPSILON` is exported from `core/types.ts` because §12 lists ε in the advanced settings block while §17 marks it fixed — it is a constant, shown but not editable.
- Default model ids (§11 says "pick current model ids at build time"): `inventory` and `seed-selection` → `claude-haiku-4-5-20251001` (current small Anthropic model); `page-generation`, `synthesis`, `vision` → `claude-sonnet-5` (current mid-tier).
- Settings tab at M0 exposes only the API key and the task→model map, matching M0's acceptance criteria; the remaining §12 fields land with the milestones that consume them.
- `FsAdapter` is bytes-first (`read` → `Uint8Array`, `write` accepts string or bytes) with `delete` added: §3 lists read/write/list/stat/move/exists/mkdir, but deletion is required by the §6.6 cascade and there is no other way to express it.
- `HttpAdapter.request` resolves for every HTTP status and rejects only on network failure or timeout, so the §6.3 image filters can inspect status codes.
- Adapter paths are vault-relative with forward slashes; the node-fs implementation normalizes separators so Windows and CI agree.
- `scripts/install-vault.mjs` copies the build into a gitignored `test-vault/`, giving the M0 "loads in a test vault" criterion a repeatable step.
- `js-yaml` resolved to 5.x, which ships its own type declarations; `@types/js-yaml` (a v4 description) was uninstalled to avoid two competing definitions. `load`/`dump` are unchanged in v5.
- `vitest.config.mts` rather than `.ts`: the package has no `"type": "module"`, so Vite's native config loader warns on a `.ts` config using ESM syntax.
- §3 names a PDF library only "for M5", but §6.1 and M1's acceptance criteria require text-layer PDF extraction at M1. Hand-rolling a PDF parser would be the larger scope addition, so the allowance is pulled forward and `unpdf` (a maintained pdf.js wrapper that runs in both plain Node and the Electron renderer without worker setup) is the chosen library.

## M1 — Ingest

### Layout

- `src/core/paths.ts` added to §3's tree: `node:path` is unavailable to core, and vault paths need normalize/join/dirname/basename/extname/stem in nearly every module.
- `core/hash.ts` also exports `utf8`, `decodeUtf8` and `concatBytes`; they are byte-level helpers with no other home in §3's tree.
- `tokens.ts` and `normalize/smell.ts` are deferred to M2, which is where the context budget and the smell test are first used.
- The node:fs adapter lives in `tests/helpers/nodefs.ts` for now; it moves to `eval/` when M3 builds the harness that §3 assigns it to.

### Manifest and the four rules

- A corrupt manifest is treated as a first run, like a missing one: every source reprocesses, which is idempotent, rather than blocking compile.
- The manifest file is written only when its contents actually changed, so an unchanged vault performs literally zero writes.
- At M1 a deleted source simply drops out of the manifest. The §6.6 cascade is M2's, and there is no wiki to cascade over yet.
- A failed source is never manifested. A new one therefore reappears as new; a modified one keeps its previous hash and so reappears as modified. Both retry next compile.
- Orphan images and unsupported extensions are skipped and never manifested, so they resurface each compile. Images become sources in M2 with the vision pass.
- Only `.md` files are inspected for `derived-from`, because Luka only ever writes `.md` derivatives; this avoids decoding PDFs and images as text during discovery.
- Rename detection pairs equal hashes in lexicographic order so the result never depends on directory walk order. When a renamed source's derivative is not already at the new path, §6.2's missing-derivative rule wins and it reprocesses as modified instead. The now-stale derivative at the old name is left alone; deleting orphaned derivatives is cascade work, which is M2.

### Normalization

- A derivative may only overwrite another derivative of the same origin. If the target path holds a user-placed file, or a derivative of a different source, that source fails rather than performing an unsanctioned write to `raw/` (invariant 7).
- Frontmatter is written only when the document has no `---` block at all; a file with its own frontmatter is left untouched.
- `origin-url` is always omitted at M1: a locally dropped file has no known origin.
- A derivative names its original in `derived-from` and repeats it as a plain path, never as a wikilink, so derivatives contribute no graph edges.
- pdf.js takes ownership of the buffer handed to it and detaches it, which silently made the PDF's manifest hash the hash of an empty input and reprocessed it on every compile. `pdf.ts` now passes a copy, and `normalize/index.ts` takes the hash before normalization runs.

### Repositories

- A repo's derivative is `<directory-name>.md` beside the directory, the closest reading of "persisted next to the original".
- Nested repositories: the outer one wins, because a detected repo is never descended into.
- The identity hash covers the selection-filtered file set (whitelist and exclusions applied) but ignores the size caps, so a change to an over-cap file still registers as a modification.
- "README* first, then `docs/`, then files by extension whitelist" is read as ordering only: `docs/` and the remainder are both whitelist-filtered, and each group is emitted breadth-first. `README*` matches at the repo root only.
- Files excluded by the whitelist are not omissions and get no marker; markers are for files the size caps dropped. A file over 100KB is omitted whole rather than truncated.
- Every included file is wrapped in a fenced block whose fence is one backtick longer than the longest run inside it, so file content cannot break out of the section.

### Inline images

- Only inline `![alt](url)` references are considered: turndown emits that form, and reference-style links and raw `<img>` do not survive normalization.
- Remote means `http:` or `https:`. Everything else — relative paths, absolute vault paths, `data:` URIs — is left untouched and never fetched.
- "under 100×100" is read as both dimensions below 100, so a wide banner survives; §6.3's "when uncertain, keep" governs the tie.
- "the prose does not reference it" is read as: neither the alt text nor the filename stem (3 characters or more) appears anywhere in the body outside image syntax.
- A network failure is recorded coarsely as "network error" or "timeout" rather than quoting the underlying message, so the annotation a source receives does not vary with platform or DNS resolver.
- The asset extension comes from the content-type first, the URL second, and `.img` as a last resort. Assets are written to `raw/assets/<sha256>.<ext>` and links are rewritten to that full vault-relative path.
- Marker insertion is idempotent: an identical marker already following the reference is left alone, so re-processing an edited source cannot stack duplicates.

### Datasets

- Header detection: the first row is a header when every cell is non-empty, unique case-insensitively, and non-numeric; otherwise columns are named `c1..cn`.
- Inferred column types are integer, number, boolean, date, string, or empty — enough to describe a table without becoming a schema language.

### Plugin surface

- M1 registers "Luka: Compile" only. §8.1's scope preview is triggered by deletions and modifications of wiki state, which does not exist until M2.
- `ObsidianFs.mkdir` walks the path segment by segment; Obsidian's adapter does not promise to create intermediate folders.
- `requestUrl` is called with `throw: false` so HTTP status codes reach the image filters as data. It offers no abort, so the timeout is a `Promise.race` that stops waiting without cancelling the request in flight.
- `main.js` is roughly 2.4 MB because pdf.js is bundled. That is accepted for a desktop-only plugin; the alternative would be fetching a parser at runtime, which invariant 1 and the offline-first design rule out.

### Fixtures

- `demo/raw/paper.pdf` and `demo/raw/orphan.png` are generated fixtures rather than found files: an uncompressed two-page PDF with a real text layer, and a 160×120 RGB PNG. Both are byte-stable, so hashes in tests do not drift.
- `demo/raw/note.md` points its figure at `luka.invalid`, a reserved TLD that can never resolve, so the "image not fetched" marker appears deterministically on every machine.
