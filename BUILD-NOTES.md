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
- Fixed §17 parameters are module-local constants rather than settings fields, since §17 marks them not user-tunable. Implemented so far: image fetch concurrency and minimums, repo caps, dataset head sample. The snapshot cap and the lexical weights arrive with the milestones that use them (M4 and M3). `PPR_EPSILON` is exported from `core/types.ts` because §12 lists ε in the advanced settings block while §17 marks it fixed — it is a constant, shown but not editable.
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
- Frontmatter annotation adds only the keys the document is missing, and splices them in as text between the existing fences. Existing keys are never re-serialized: a js-yaml load/dump round trip deletes comments, restyles flow sequences, reorders keys, and retypes scalars (`010` becomes `10`), all of which invariant 7 forbids in a user-placed file. (Supersedes an earlier entry here that had annotation skip any file with a `---` block at all; that reading would have permanently blocked `ingested`/`source-format` on filed answer notes, which arrive carrying frontmatter per §8.3.)
- A frontmatter block that does not parse, or that holds a sequence or a bare scalar rather than a mapping, is left completely untouched — there is no way to add a key to it without rewriting content the user owns. The file is still ingested; it simply is not annotated.
- Passthrough annotation happens only when the file's bytes survive a UTF-8 round trip. `TextDecoder` is non-fatal and replaces invalid sequences with U+FFFD, so writing a decoded legacy-encoded file back would silently destroy it. A file that does not round-trip is ingested and left exactly as the user wrote it.
- A UTF-8 byte order mark is stripped before annotation and put back afterwards; it is part of the file the user placed, so removing it would be a fourth unsanctioned write.
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
- The run of comments following an image reference is rewritten from scratch on each pass: Luka's own `image not fetched` markers there are dropped and re-derived. A marker therefore never outlives the problem it describes (an image that later fetches loses its marker) and never stacks a second copy when the failure reason changes. Comments Luka did not write are preserved.
- "Discard (with marker)" is implemented as "leave the remote link in place and mark it". §4 fixes the wording as "not fetched, never removed", so nothing is removed from the document; the reference simply stays remote.
- An absent `Content-Type` is treated as uncertain rather than disqualifying, per §6.3's "when uncertain, keep".
- Image fetches reuse the §17 provider timeout (120s) because §6.3 specifies "fetch with timeout" without a value. This is the largest stall a single compile can incur: unreachable images at concurrency 4 hold the operation lock while they time out.
- Path ordering everywhere uses code-point comparison, never `localeCompare`. Walk order is the input to the repo identity hash (§6.4), so a locale- or ICU-dependent collation would make the same repository hash differently on two machines and read as modified after a vault sync. §7.2's "node order lexicographic by path" will want the same helper.
- Repo derivatives are not run through image localization, unlike the html/pdf/dataset derivatives: all repo content sits inside code fences, where rewriting an image reference would corrupt the displayed source.
- The repo total-size cap is greedy rather than a hard stop — an over-budget file is marked and skipped, and a later smaller file may still be included.
- `.htm` is accepted as an html source alongside `.html`.
- A root `README*` is included regardless of extension, which is the only way §6.4's "include README* first" can cover an extensionless `README`. It therefore bypasses the extension whitelist.
- Notices carry no counts of ingest problems: invariant 4 says there is no ingest report and no aggregate count. Compile reports only that it finished or had nothing to do; unsupported files get §6.1's single naming notice, and a failed source gets one notice of its own per §11.

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

## M2a — Provider layer

- `CompletionRequest` adds an `images` field to §11's signature; the vision task cannot be expressed without one. Images are `{mediaType, data: bytes}` and become base64 content blocks ahead of the text.
- Base64 is hand-rolled in `provider/anthropic.ts`: core relies on neither Buffer (Node-only) nor btoa (binary-string awkwardness), and twenty lines are cheaper than either.
- Backoff is base 1s doubling per attempt, capped at 30s, with equal jitter (half fixed, half random); §11 says only "exponential backoff + jitter". `sleep` and `random` are injectable so tests assert exact delays.
- `Retry-After` is honored in its seconds form only; an HTTP-date value falls back to the normal backoff rather than being parsed.
- Effective max_tokens = min(requested, §11 task cap); a caller may go below the cap, never above.
- The JSON repair retry re-sends the original user message with the parse error appended, at temperature 0, and counts as a model call like any other. A second parse failure throws; there is no third attempt.
- The call counter counts transport attempts — retries and the repair call included — total and per task, exposed as `provider.stats()`. M2's "zero model calls on re-compile" acceptance check asserts against it.
- `anthropic-version` is pinned to `2023-06-01`, the current stable Messages API version.
- A missing API key or an empty model id fails before any HTTP attempt, so a misconfigured vault can never emit a request.
- A 2xx response whose body is not JSON (a proxy error page, say) is non-retryable: the endpoint answered, the answer is just unusable.
- `core/concurrency.ts` added to §3's tree: `mapWithConcurrency` moved out of `normalize/image.ts` because compile's §11 concurrency-2 fan-out needs the same helper.
- Live functionality tests live in `tests/provider-live.test.ts`, gated on `ANTHROPIC_API_KEY` in the environment — never in CI, real Messages API round trip on demand. `tests/helpers/nodehttp.ts` (fetch + AbortController) exists for them and moves to `eval/` at M3 alongside `nodefs`.
- The core façade exports `createProvider` and the provider types only; the raw Anthropic transport is deliberately not exported, so no future caller can reach the API around the wrapper (invariant 10 made structural). Tests import the transport by module path.
- §11 fixes JSON tasks at temperature 0, but some current Anthropic models reject sampling parameters with a 400. A 400 naming `temperature` re-runs the call once with the parameter omitted (counted like any attempt), so remapping a JSON task onto such a model degrades gracefully instead of failing every compile.
- A vendor `Retry-After` is honored but bounded at the same 30s cap as the backoff: an hour-long server-suggested wait would otherwise hold the single operation lock for that hour.
- Errors that are not a typed non-retryable failure — network rejects, timeouts, unexpected throws — are treated as retryable; they cannot be reliably distinguished from transient conditions.
- Nonsense `maxTokens` requests (zero, negative, NaN, fractional) fall back to or floor at the task cap rather than reaching the API as an invalid value.

## M2b — Page mechanics (no model)

- `src/core/compile/pagetable.ts` added to §3's tree. §4 names "the in-memory page table" but assigns it no file; the link post-pass, the index document, M2c's dedup, and M3's retrieval all read from it, so it gets one home rather than four private copies.
- These modules are not exported from `core/index.ts` yet. Nothing outside `src/core/compile/` consumes them until M2c wires generation, and a façade export with no caller is a bypass waiting to happen (the M2a audit made that point about the raw transport).
- `packUnderBudget` stops at the first item that does not fit rather than skipping it to fit a later smaller one. Both callers assemble in a meaningful order — §6.5's citation order, §7.4's rank order — which cherry-picking would silently reorder.
- §7.4 says "never split a page; a single page over the whole budget is tail-truncated", so only the *first* item is ever truncated. A later oversized item ends the packing instead, because dropping it is honest where truncating it would misrepresent rank order.
- `truncateToTokens` reserves room for the truncation marker, so its result fits the budget including the marker whenever the budget can hold the marker at all (10 tokens). Below that it returns the bare marker and is over budget: signalling the truncation is worth more than the handful of tokens. The cut never lands between the halves of a surrogate pair.
- A citation entry is parsed with a greedy pattern so a path containing `]` — `raw/[draft] notes.md` is a legal filename — round-trips. Render and parse have to be mutually inverse or §6.5's citer record silently loses sources, and a page whose last citer is lost gets deleted by the §6.6 cascade.
- The citation block is matched structurally (start fence, `## Sources`, entry lines, end fence) rather than by its markers alone, so a stray `<!-- citations:start -->` sitting in prose cannot pair with the real block and swallow everything between them. Every matching block is stripped on rewrite and the last one is read as authoritative, so a page can never accumulate two blocks for the next compile to disagree about. A fenced code sample of the exact block shape is still consumed — the same fence-blindness logged for the link post-pass.
- An entry containing a newline is dropped rather than written, since it would render as two lines that no longer parse back.
- `renderIndex` collapses whitespace in summaries and aliases to single spaces. Both come from the model's Call A JSON, and invariant 5 gives the model prose only — a newline in a summary would otherwise inject a heading or a phantom entry into the index, which §7.4 step 1 then feeds to the seed call.
- `_`-prefixed folders under `wiki/` are not descended into: §7.1 counts nodes as "every file under `wiki/` (minus `_`-prefixed)", and a folder marked as infrastructure holds infrastructure.
- `aliases` given as a bare string rather than a list is read as a single alias; hand-written vaults produce that shape, and dropping it would cost §6.5's dedup a match and create a duplicate page.
- Citation entries are deduplicated on render, first occurrence winning; the ordering policy itself (§6.5's "surviving entries ∪ this run's matches") belongs to the caller in M2c.
- `parseCitationBlock` returns the body trimmed at both ends. Removing a block that sat at the head would otherwise leave the page starting with blank lines.
- The link post-pass treats a case-variant of a title like an alias (`[[personalized pagerank]]` → `[[Personalized PageRank|personalized pagerank]]`) so the link resolves in Obsidian while the prose keeps the author's casing. An exact-title match is left alone rather than gaining a redundant pipe.
- Links whose target starts with `raw/`, or contains `#` or `^`, are exempt from rewriting: §4 makes source links full-path, and heading/block references address a location inside a page rather than a page.
- The post-pass is not code-fence aware, consistent with the same decision logged for M1 image localization; a page documenting wikilink syntax inside a fence would have the example rewritten.
- In the title+alias table a page's own title outranks another page's alias for the same string, and competing aliases resolve to the lexicographically first title, so the table does not depend on page discovery order.
- Title uniqueness is compared case-insensitively — the vault may sit on a case-insensitive filesystem, where two titles differing only in case are one file — and collisions take §8.4's `-2`, `-3` suffix idiom.
- A title that sanitizes to nothing becomes "Untitled" rather than producing an unnameable page.
- `renderIndex` always emits all three §4 headings even when a section is empty, and sorts entries by title using code-point comparison so the file does not churn across locales. §7.4 step 1 reuses this exact renderer rather than a second copy.
- A file under `wiki/` whose frontmatter has no recognizable `kind` is not a page: it is skipped rather than guessed at.

## M2c — Extraction and generation

### Call A (inventory)

- A reply that is not the documented top-level shape (`source_summary` string, `items` array) throws, which fails the source: §11 skips it with a notice and invariant 3 retries it next compile. An individual malformed *item* is dropped instead — one bad entry should not cost the user the whole document.
- `aliases` given as a bare string, or a list containing non-strings and blanks, is coerced rather than rejected; models produce both shapes and the alternative is losing a real page.
- Summaries and `source_summary` are flattened to one line at the point the model's words enter the system. Both reach `wiki/_index.md`, which §7.4 step 1 feeds to the seed call, and invariant 5 gives the model prose only — never structure.
- Temperature is not set here: §11 fixes JSON tasks at 0 and the wrapper applies it, so this module cannot get it wrong.

### Merge and dedup

- Matching goes through M2b's `buildTitleIndex` rather than a second table. It is already the case-insensitive title+alias table §6.5 names, and already resolves competing aliases deterministically.
- An item's title is matched before its aliases, and its aliases in the order the model gave them, so the result never depends on Map iteration order.
- The title is matched both as written and as sanitized. Sanitization is what names the file, so a model saying "Mercury/planet" must find the existing "Mercuryplanet" rather than queue a second page for one filename.
- §6.5's "kind ignored" is read as entity-vs-concept. **Source pages are not match candidates**: they are assembled by code from their own file's summary and have no Call B, so matching one would strand the citer on a page that never regenerates. They still hold their titles, so a new page cannot take a filename one occupies.
- Within a run, a second source naming the same new thing merges into the first page: citers union, aliases union case-insensitively, the first encounter fixes title and kind, and the latest non-empty summary wins.
- A page never carries its own title as an alias.
- When an item matches an existing page, the matched name itself is offered as a new alias — "Mercury" hitting "Mercury (element)" through an alias is a handle worth keeping — unless the page already has it.
- Sources are processed in path order and the work-set is sorted by page path, so the same vault produces the same work-set regardless of which source finished first.

### Call B and page assembly

- The prompt carries the page identity (title, kind, aliases) and then whole sources in citation order under the context budget, each behind a `--- source: <path> ---` delimiter. The head's own cost is subtracted from the budget so the assembled prompt stays under it without a second packing pass.
- Temperature is left unset for Call B: §11 fixes it only for JSON tasks, and there is no reason to pin prose generation to a value the spec does not name.
- The model's reply is used as prose and nothing more. It is not scanned for stray headers or frontmatter — the prompt forbids them, and a citation block it writes anyway is stripped by `withCitationBlock`, which already replaces every block it finds.
- A source page's title comes from the file stem, sanitized and uniquified. Call A's schema is fixed by §6.5 and carries no title for the source itself, so the stem is the only name available.
- Source pages are named **before** the merge and their titles are passed into it as reserved names. §4 requires titles unique across all of `wiki/`, and the two halves of a run allocate from one title space: without this, a source `raw/Obsidian.md` and a concept the model calls "Obsidian" both produce a page titled "Obsidian", and the link post-pass then resolves `[[Obsidian]]` to whichever the title index happened to keep.
- `PageMeta` gains an optional `source` key, unwrapped from §4's `source: "[[raw/<file>]]"`. It is how a re-ingested source finds its existing page and keeps that page's title stable across recompiles.
- "Surviving entries" in §6.5's citer union is read as "present in the manifest this run will write". Deleted paths are already dropped from it, so the union expresses §6.6's delete signal (a page with zero remaining citers) without the cascade being built yet.
- The citer union is existing-then-new with duplicates removed, so a page's oldest sources stay first and the Call B prompt does not churn between runs.
- The title index used for the link post-pass covers existing pages plus every page written this run, so a link to a page created in the same compile resolves immediately rather than waiting a compile.

### Pipeline and failure semantics

- Normalization stays serial; the §11 concurrency budget of 2 governs model calls, and normalization writes files. Call A and Call B each fan out through `mapWithConcurrency` at `compileConcurrency`.
- Invariant 3 is extended past normalization: a source is manifested only when its normalization, its inventory, and *every* entity/concept page its inventory queued all succeeded. A failed Call B therefore un-manifests exactly the sources that would have to be re-inventoried to retry it — retry with no extra state.
- A source whose Call B failed still gets its own source page written. That page describes the source, which ingested and inventoried fine, and writing it is idempotent — the next compile rewrites it identically. Only the manifest entry is withheld, which is what makes the retry happen.
- The provider is constructed in `createCore` and injected into `CoreDeps` as an optional test seam. The seam is at wrapper level, never transport level, so invariant 10 stays structural.
- A compile that queues no pages writes no index. `wiki/_index.md` is only regenerated when at least one page was written, so an unchanged vault still performs literally zero writes.
- `CompileResult` gains `modelCalls` (this run's delta against `provider.stats()`) and `pagesWritten`. §15's "assert via a call counter" reads the former.
- An unchanged source that still cites a regenerating page has its readable markdown located by trying `<stem>.md` and then the source itself; its format is not in hand at that point.

### Fixes from the M2c audit

- A citation entry and a `source:` value are **paths, not wikilinks with display text**, so neither is split on `|` any more. `|` is legal in a filename on macOS and Linux, and code never writes display text into either place; splitting truncated `raw/a|b.md` to `raw/a`, which then failed the citer union and silently dropped the source from the one record §6.5 calls persistent. (`resolveLinks` still splits, correctly — there `[[Title|Display]]` really is prose syntax, and `raw/` targets are exempt from rewriting anyway.)
- §6.2's "skip regeneration" for a rename is read as skipping *model work*, not bookkeeping. §4 makes the vault path a source's identity, so a rename now repoints the `source:` key and every citation entry naming the old path — a pure text rewrite, zero model calls. Without it the source page kept a dead `source:` key, was never matched again, and the next edit created a duplicate page while the index advertised both.
- A source dropped whole by the context budget now gets §6.5's truncation marker naming it. Dropping a source is the budget forcing truncation just as much as a tail cut is; without the marker the model wrote a page grounded in a subset of its sources while code wrote a citation block claiming all of them.
- The model's titles and aliases are flattened to one line alongside summaries. An alias with a newline serialized as a YAML block scalar in page frontmatter — the model determining the structure of a block invariant 5 gives to code — and `loadPageTable` reads those aliases back on every compile.
- `wiki/_index.md` is re-derived on **every** compile per §6.5's post-process order, not only when a page was written. Zero writes on an unchanged vault is preserved by comparing the rendered bytes against the file rather than by skipping the step. An empty vault with no index still writes nothing, so compiling nothing does not create `wiki/`.
- `mapWithConcurrency` now passes the item's index to its callback. The two M2c fan-outs were recovering it with `indexOf`, which is both O(n) and wrong under concurrency — progress notices could count backwards.

### Fixes from the seam review

A review scoped to where M2c's new callers meet older committed modules, rather than to M2c's own diff. That scoping is the point: the `|` truncation below lived in audited M2b code and only became reachable when M2c started feeding it real filenames.

- A path Luka cannot record faithfully is **skipped at discovery** with a §6.1-style notice rather than ingested. Two classes qualify: any of the four JavaScript line terminators (`\n`, `\r`, U+2028, U+2029), because a regex `.` matches none of them and both the citation block and `source:` are single-line forms — so the path would silently vanish from the citer record; and a literal backslash, because vault paths are forward-slash only and one in a filename is indistinguishable from a separator. This supersedes the earlier `|`-only fix, which addressed one character of a four-character class.
- The page-write loop catches. A model title can pass `sanitizeTitle` (which strips only the characters §4 names) and still be rejected by the host — too long, or `?`/`*`/a reserved name on Windows. An unguarded write threw past the manifest step, discarding the record for every source that had succeeded and making the next run re-spend every model call it had already paid for. §11's rule is that a failure costs one source, so this degrades the same way.
- `blockedBy` carries reasons rather than page titles, so a write failure and a Call B failure each report accurately instead of sharing one message.
- The derivative path is **claimed before extraction runs**, not after. §6.1 names every derivative `<original-stem>.md`, so `chart.csv` and `chart.png` both want `chart.md`; checking afterwards still failed, but only after paying for the vision call — on every compile, forever, since a failed source is never manifested.
- `readableFromManifest` reads the format from the path instead of guessing `<stem>.md`, and accepts a derivative only if it names this source as its origin. A passthrough source has no derivative, so the guess found an unrelated same-stem neighbour: a vault holding both `notes.txt` and `notes.md` fed the wrong document to Call B behind the right document's label.
- Marker values are escaped for HTML-comment safety. An image name comes from a URL the model or the source supplied, and a repo path from whatever the user named their files; a `-->` in either ended the comment early and turned the remainder into live markdown — a working wikilink is a graph edge (§7.1) that nothing actually cites. `smell.ts` already refused to put extracted text in a marker for this reason; the other markers now get the same treatment.
- `isLive` uses `Object.hasOwn`, so a hand-written citation entry of `constructor` or `toString` cannot resolve to an inherited member and read as a live source forever.

### Test infrastructure

- `StubProvider` stubs **transport** (`RawProvider`) and runs through the real §11 wrapper, rather than implementing `LLMProvider` directly. The first version sat *above* JSON parsing, the repair retry, the retry budget, the max_tokens caps and `ProviderError` — so invariant 12's call-count assertions were checked against a counter structurally incapable of the inflation the real provider shows, and every failure test threw a bare `Error` production never produces. A stub more forgiving than the real thing is a stub that manufactures confidence.
- Because the wrapper does not pass the task down to transport, the stub gives each task a distinct model id (`stub-<task>`) and recovers the task from it. This is also what lets a test assert the temperature and cap a JSON task actually reaches the wire with.
- `tests/demo-corpus.test.ts` gets a 30s timeout and a retrying temp-dir teardown. It is the only suite that touches a real filesystem and runs pdf.js, so a compile there costs seconds; the 5s default has no headroom on a loaded machine, and a timeout mid-write is itself what produces Windows `ENOTEMPTY` cleanup failures.

### Vision pass and images

- `derivativePathFor` now returns `<stem>.md` for `image`, which makes an orphan image a source with its own wiki page (§6.1's vision row). Inline images are unaffected: they are localized into `raw/assets/` and are never sources.
- Media types are mapped from exactly §6.1's five orphan extensions (`.png .jpg .jpeg .gif .webp`). Anything else throws rather than guessing a type the API would reject.
- The vision prompt leads with faithful transcription of visible text — a photograph of a whiteboard is the case that makes orphan images worth ingesting at all — then structure, then description.
- An empty vision reply throws rather than writing an empty derivative, so the source retries next compile.

### Smell test

- Thresholds, all of which §6.5 leaves open: fewer than 200 characters per page on average is "short output"; a line of 4+ characters appearing on 3+ distinct pages is a running header; and more than 60% of lines lacking terminal punctuation is a high fragment ratio, judged only once the document has 20+ non-empty lines.
- Running headers are counted by *pages* rather than occurrences, so a phrase repeated three times on one page reads as prose rather than as a header.
- The marker heads the derivative's **body**, not the file, so the frontmatter block stays first and Obsidian still parses it. It is re-derived with the derivative on every run, so it can never go stale or stack.
- The running-header search returns only a page count, never the winning line. The marker reports the count, so which of two equally-repeated lines "wins" is unobservable — and keeping the winner would mean deciding a tie no caller can see. It would also invite putting arbitrary extracted text into an HTML comment, where a `-->` inside a PDF would break out of the marker.
