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
- "Surviving entries" in §6.5's citer union is read as "present in the manifest this run will write". Deleted paths are already dropped from it, so the union expresses §6.6's delete signal (a page with zero remaining citers) without the cascade being built yet. (Superseded at M2d: once an empty union deletes the page rather than trimming a line, "surviving" has to mean the file is still in the vault — see the `isLive` entry below.)
- The citer union is existing-then-new with duplicates removed, so a page's oldest sources stay first and the Call B prompt does not churn between runs.
- The title index used for the link post-pass covers existing pages plus every page written this run, so a link to a page created in the same compile resolves immediately rather than waiting a compile.

### Pipeline and failure semantics

- Normalization stays serial; the §11 concurrency budget of 2 governs model calls, and normalization writes files. Call A and Call B each fan out through `mapWithConcurrency` at `compileConcurrency`.
- Invariant 3 is extended past normalization: a source is manifested only when its normalization, its inventory, and *every* entity/concept page its inventory queued all succeeded. A failed Call B therefore un-manifests exactly the sources that would have to be re-inventoried to retry it — retry with no extra state.
- A source whose Call B failed still gets its own source page written. That page describes the source, which ingested and inventoried fine, and writing it is idempotent — the next compile rewrites it identically. Only the manifest entry is withheld, which is what makes the retry happen.
- The provider is constructed in `createCore` and injected into `CoreDeps` as an optional test seam. The seam is at wrapper level, never transport level, so invariant 10 stays structural.
- A compile that queues no pages writes no index. `wiki/_index.md` is only regenerated when at least one page was written, so an unchanged vault still performs literally zero writes. (Superseded later in this same milestone — see "re-derived on **every** compile" below, which keeps the zero-write property by comparing bytes instead of skipping the step.)
- `CompileResult` gains `modelCalls` (this run's delta against `provider.stats()`) and `pagesWritten`. §15's "assert via a call counter" reads the former.
- An unchanged source that still cites a regenerating page has its readable markdown located by trying `<stem>.md` and then the source itself; its format is not in hand at that point. (Superseded twice: by the M2c seam fix, which reads the format from the path and requires the derivative to name this source, and again at M2d for repo sources, which are directories with no extension to read a format from.)

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

## M2d — Cascade and scope preview

### What the cascade is

- The cascade cannot chain, so §6.6's "runs to completion" is one pass over the page table and its "visited set" is that pass keyed by page path. Pages cite *sources*, never other pages — a wikilink between pages is §4's future-article signal, not a citation — so deleting a page can never orphan another one. A page cited by three deleted sources enters the queue once.
- Scope is computed twice, deliberately. `cascadeScope` is **advisory**: a pure function over (page table, citation records, diff) that answers "what would this touch" without normalizing, calling a model, or writing, and it is what `previewCompile` and the confirm gate report. The **authoritative** decision stays M2c's `citerUnion` against the manifest this run will write. That split is what makes §6.6's second list a "may": a modified or new source whose inventory re-cites a page has added itself to the union by then, and the page regenerates instead of being deleted.
- A deleted source's own source page needs no rule of its own. §4 gives it exactly one citation — its own raw file — which has just left the manifest, so the uniform zero-citer rule deletes it like any other page.
- Only deletion can empty a citer set. §6.5's record survives on the source still *existing*, not on it still *mentioning* the page (M2c's reading of "surviving entries"), so a modified source that dropped a topic still cites that page, and the page regenerates from the source's new text rather than being deleted. Revoking a modified source's citations instead would let one non-deterministic Call A delete a page the source still discusses.
- `pagesDeleted` and `cancelled` join `pagesWritten` on `CompileResult`; §15's acceptance check reads the first, and the plugin's notice reads the second.
- `ScopePreview` carries page *paths*; the modal displays the stem, since §4 makes the filename the title.

### Ordering

- Doomed pages are dropped from the title index the link post-pass builds, so a page written this run cannot resolve a link against a page that is about to leave the vault — and cannot lose an alias contest to one.
- Page deletions run after the write loop and before the index is re-derived, because the index re-reads the page table from disk; deletions therefore reach `wiki/_index.md` with no change to the index step at all. Doomed and written pages are disjoint by construction: everything in `toWrite` has at least one live citer. (That argument was true but insufficient — doom is read from a different record than the one a source page is queued from. Superseded by the by-path exclusion below.)
- The orphaned-derivative sweep runs before normalization, so a new source with the same stem can claim the freed derivative path in the same run rather than failing to claim it.

### Derivatives and deletion safety

- A derivative orphaned by a source leaving its path is deleted — both halves of "leaving": deletion, and the old side of a rename. This supersedes M1's "the now-stale derivative at the old name is left alone", which deferred exactly this to the cascade.
- The candidate is computed as `<stem>.md` beside the departed path without consulting the format: a deleted repo directory has no extension to read a format from, and the file is gone either way. Safety comes from content, not from the path — only a file whose `derived-from` names that exact departed path is Luka's to delete (invariant 7), so a user file or another source's derivative sitting there is never touched.

### Confirm and cancellation

- The confirm gate fires on §8.1's literal wording — the diff includes deletions or modifications — and only when a callback was supplied. An adds-only or pure-rename diff never confirms.
- Confirm is a callback inside `CompileOptions` rather than an exposed acquire/release pair or a third façade method. The core's single `lock.run("compile", …)` then spans preview → confirm → work exactly as §8.1 requires, a second invocation during the modal gets invariant 2's notice verbatim, and there is no lock a caller can forget to release.
- No callback means proceed unconfirmed. Tests and the headless eval harness want that; the modal is the plugin's concern, and §5's core contract has no UI in it.
- `previewCompile` deliberately does **not** take the lock: it does no work and writes nothing, the same reason §9's pane is never blocked by it. §8.1's flow does not use it — compile's own callback is what holds the lock — so it exists for §5's contract and for M4's pane.
- A declined preview returns `CompileResult{cancelled: true, noop: true}` carrying the diff counts, with zero model calls, zero writes and the manifest untouched. The gate sits before the first write, so "nothing happened" is structural rather than undone.

### Retry after an interrupted cascade

- A deleted source's manifest entry is removed only if its cascade completed. If a page it affected fails to regenerate, fails to be written, or fails to be deleted — or if its orphaned derivative could not be removed — the entry is put back, so §6.2's rule 3 (path present, file absent) fires again next compile and the cascade re-runs idempotently. Without this the deletion is unrecoverable: the entry is gone, nothing re-detects it, and the stale citation survives forever.
- This is the same shape invariant 3 already gives a failed ingest — retry expressed entirely through the manifest, with no extra state — and it degrades the same way: a blocked cascade costs one source, not the run.
- A rename whose stale derivative could not be deleted is reported in `failed` but has no entry to restore; the old path is not in the manifest to begin with. (Wrong, and superseded below: the old path is a manifest key — that is how the rename was detected.)

### Fixes from the M2d reviews

Three independently scoped reviews — the diff itself, an audit against §2/§5/§6.6/§15, and a seam review of where M2d's callers meet older modules. The seam findings are again the sharpest: most of them are M1/M2c code that was correct until a caller started *deleting* things based on it.

- **A rename whose derivative did not travel is a rename *and* a modification, not a delete plus an add.** `discover` previously demoted it, which was harmless while deletion cost nothing. Under §6.6 it was destruction: moving a file into a subfolder always leaves the derivative behind, so the old path was reported deleted, `repointRenames` never ran, and every page citing that source was regenerated with a dead citer — or deleted outright when this run's Call A happened not to re-name it. The two §6.2 rules now compose: identity follows the file, and the new path re-normalizes.
- **`hasDerivative` checks ownership, not existence.** Any file at `<stem>.md` used to satisfy it — a user's own note, or another source's derivative. That marked the source fully ingested while its readable markdown did not exist; the §6.6 sweep then deleted the real derivative as an orphan, and every later compile read the source as unchanged and fed Call B an empty body under its label. It now reads `derived-from`, which is the same check `readableFromManifest` and `claimDerivative` already make.
- **A rename repoints its derivative's `derived-from`.** Sources sharing a stem share the derivative location, so an extension-only rename (`data.csv` → `data.tsv`) moves the source while the file stays put; a folder move can carry it along. Either way only the key went stale, and with the ownership check above that turned into a permanent failure — the source could never claim a path that now looked like a stranger's. Repointing is the same bookkeeping a rename already gets everywhere else, and costs no model call.
- **The sweep never deletes a derivative a living source still claims.** The candidate for a departed `data.csv` *is* `data.tsv`'s derivative when both share a stem. Content alone could not tell them apart, so the sweep now also takes the set of locations still claimed this run.
- **A blocked cascade is recorded as `CASCADE_PENDING`, not the old hash.** A restored real hash sits in the manifest for as long as the failure lasts, waiting to pair as a rename against any unrelated file with the same bytes — a copied template, a second empty note — which would inherit the dead path's identity and its pages while the cascade was never retried. Nothing hashes to the sentinel, so the entry can only read as "still gone, still owed a cascade".
- **The restore covers the old side of a rename too.** That path is a manifest key — it is how the rename was detected — so the earlier note claiming it had "no entry to restore" was simply wrong, and a rename whose stale derivative failed to delete was orphaned with no retry path.
- **A page this run writes is never deleted by the cascade.** Doom is read from the citation block, but a source page is queued from its `source:` key — two different records for one path. A block naming only a dead source made the run write the page and then delete it, with `failed` empty and the source manifested, so it never came back. The disjointness is now enforced by path rather than argued from citer counts.
- **`isLive` means the file is still in the vault.** It previously meant "manifested, or succeeded this run", so a source that failed to normalize could not hold its citation — and under §6.6 losing the citation costs the page, not just a line in the record. Deleting a page because one run went badly is not recoverable the way retrying an ingest is. This is also the set `cascadeScope` calls live, so the preview and the run now agree by construction.
- **A rename that is also a modification does not keep its manifest entry when the modification fails.** The rename pass writes the new path unconditionally, which was correct when a rename implied no processing; it is a claim the run has not earned once the source also has to re-normalize (invariant 3).
- **`readableFromManifest` handles a repo source.** A repo is a directory, so `formatForPath` finds no extension and the function handed back the directory itself — Call B then read a folder and the whole page failed. Its readable markdown is §6.1's derivative location, the same as every other converting format.
- **Paths whose segments are padded with whitespace are skipped at discovery.** Both readers of the citer record trim, so `raw/my repo ` reads back as a different path. A file needs an extension to be a source, but a repo directory does not, so this was reachable — and a citer that no longer matches now costs the page, not just a line.
- **`pagesWritten` counts pages actually written**, not pages attempted; a failed write no longer inflates it.
- **The modal settles its promise before emptying its element.** If `empty()` ever threw, the promise would never settle and compile would hold the operation lock for the rest of the session.
- **The failure notice says "skipped", §11's own word.** A blocked cascade is not an ingest, and "could not ingest" was wrong for it. A failed derivative delete also produced two notices for one problem; the reasons are now collected per source, like `blockedBy`.
- **A cancelled run still reports §6.1's skipped files.** Which files are unsupported is a discovery fact, true whether or not the user confirmed.
- **The completion notice names the number of pages removed.** The user approved a list of pages that only *might* go; saying how many actually went closes that loop. This is not invariant 4's forbidden ingest report — it counts what compile did, not the problems it found.
- **§15's first two M2 criteria are now asserted on the demo corpus itself.** They were proven on a synthetic vault while the demo suite stubbed Call A to zero items — so "compiles into a three-kind wiki" was never exercised there, and its zero-call assertion checked `http.requests`, which a stubbed provider never touches anyway.

### Fixes from the second M2d review round

The first round's fixes reached into M1's discovery code, so a second round was scoped at that risk. It found that one of those fixes was itself destructive.

- **A renamed source keeps its derivative instead of re-extracting it.** The first round had a rename whose derivative did not travel classified as *also modified*, which re-normalized at the new path and let the sweep delete the old file. That is what an ordinary folder move looks like — and §6.2 says a derivative "persists until the original changes", calling a hand-edited one "the sanctioned repair path for bad extractions". A rename does not change the original: identical bytes are how it was detected. So compile now carries the derivative over, moving the file when the rename moved its location, and a folder move costs zero model calls and preserves the repair. `reprocess` is the last resort — nothing usable to carry, or a file that is not Luka's already sitting at the destination — and only then does the missing-derivative rule apply.
- **One decision, two callers.** `renameDerivativeAction` is called by discovery to classify and by compile to act, so the two cannot disagree about whether a rename needs work. `Rename` gains the new path's `format`, which is what decides where the derivative belongs; without it compile would have to guess a format for a path it never classified.
- **Repointing rewrites one line, not the block.** `replaceFrontmatterValue` splices the new `derived-from` value in place. A full re-serialize would drop the user's comments, reorder their keys and retype their scalars — exactly the damage M1's annotator was built to avoid — on a file §6.2 invites them to edit. Invariant 7 would permit the rewrite; there is just no reason to spend it on one word.
- **`IngestManifest`'s doc comment now names the sentinel.** §3 describes the file as path → SHA-256, and `CASCADE_PENDING` widened that. §7.1's graph node set and §10's health check both read the manifest as "these files exist and are ingested" and must skip such an entry; the type is where they will look.
- **All four of §15's M2 criteria now run on the demo corpus.** The delete criterion's "regenerates" half was asserted only by inference, and "modified source reprocesses" was proven only on a synthetic vault.

### Fixes from the second round's correctness review

- **A skipped source is never a deleted one.** §6.1 has an unsupported or unrecordable file "surface again each compile", which means it is still in the vault — so its path must not reach §6.6's cascade. It could: `vanished` was every manifest key not in `present`, and a skipped path is in neither. The damage shows up exactly when the skip rules change, as they just had: a vault holding `raw/ notes/a.html` compiled fine one day and, on the next compile, lost that source's derivative and its wiki page without the file moving. That is the same bug this milestone set out to fix, re-entered through a different door.
- **The unrecordable-path test is `path !== path.trim()`.** Both readers trim the recorded value as a whole rather than segment by segment, so only padding at the very ends fails to round-trip — and since every source path starts with `raw/`, that means a trailing-space basename. The per-segment version rejected ordinary spaced folders like `raw/my notes/`, which round-trip perfectly.
- **A citer whose markdown cannot be found fails the page instead of becoming an empty body.** §6.5 gives Call B "the full normalized bodies of *all* citing sources"; passing `""` had the model write a page grounded in a subset while code wrote a citation block claiming the lot — and since `wiki/` is rewritten wholesale, the old page was gone. Failing costs the page one run: its existing text stands and the citers retry, which is §11's rule that a failure costs one source rather than the run.
- **The sweep's shield is built from each source's format, not its stem.** A passthrough source writes no derivative, so shielding the location its stem points at left a real orphan permanently unsweepable — and permanently blocking that path, because a later source trying to claim it hits "already taken by a derivative of" a source that no longer exists.
- **A failed derivative carry-over removes the half-carried file.** A derivative that still names the old path is worse than none: the source reads as missing its derivative every run and can never claim the location back, so it fails forever. Deleting it lets the next compile re-extract, and the old path is recorded pending so the sweep retries too.

### Fixes from the third review round

Every finding here traces to one mistake: `renameDerivativeAction` reads ownership off a filename, and both callers treated that name as proof the file describes this source's content.

- **A derivative already naming the *new* path is stale by definition, not a match.** A renamed source only just arrived at that path — that is what made it an addition to pair — so any derivative naming it was written for some earlier occupant and describes a different document. Adopting it grounded the wiki in an unrelated file under the right label, permanently and invisibly, since every later run read the matching name as consistent. It now re-extracts, which `claimDerivative` allows because the origin named is this very source.
- **The rename's derivative decision is taken once, at discovery, and carried on the `Rename`.** Compile re-deriving it asked a vault its own earlier iterations had been mutating: two renames landing on one derivative location both classified as carry-over, the first moved its file there, and the second silently became a no-op — leaving a source manifested with no derivative of its own, failing forever, and a hand-repaired file destroyed by the sweep. Discovery now detects the collision (it can: it sees them all against one vault state) and sends the loser to `reprocess`, which keeps it in the worklist.
- **The sweep's path shield is gone entirely.** The carry-over pass runs first and repoints every file a living source is taking over, so those no longer name the departed source and the sweep skips them on content alone. Shielding by path meant a live source could shield a derivative belonging to a *dead* one, so deleting the source that caused a stem collision — the user's obvious remedy — was exactly the move that made it permanent: nothing could sweep the file, and nothing could claim the path.
- **`replaceFrontmatterValue` declines rather than guessing.** It now requires the key exactly once, at column zero, holding a plain single-line scalar. A folded or literal block value had its indicator replaced while the continuation line survived and folded into the new value; an indented key of the same name won by first-match, rewriting the user's nested data and leaving the real key stale. Both produced a run reporting `failed: []` and a source that failed on every run after. A `null` return is now a thrown error at the caller, not a silent success.
- **A skipped folder covers the sources beneath it.** They drop out of the scan without leaving the vault, so cascading on them deletes the pages of sources sitting right there.
- **A failed carry-over withdraws its manifest claim, verifies ownership before deleting, and exempts itself from the sweep.** The claim was written by the rename pass and only taken back when the rename was *also* modified, so a half-carried source read as fully ingested at the correct hash while its derivative belonged to a stranger. The cleanup delete was the one delete in the module gated on existence rather than `derived-from` — and `fs.move` can fail precisely because something else arrived at the destination.

### Fixes from the fourth review round

A round scoped to one subsystem, because the previous three had each concentrated there. It ran 1,200 randomized vault-churn scenarios with injected IO failures and found no case where the vault fails to settle — the defects it did find are all data loss *on the way to* a correct steady state. Its verdict on the design question was that the carry-over machinery is worth keeping: the simpler rule (always re-extract unless the derivative is already correctly keyed) would turn every folder move into a modification, costing a Call A per source, which contradicts §6.2's "skip regeneration" and invariant 12 more than the complexity does. The problem was ordering, not the idea.

- **A re-extracting rename keeps its old derivative until the replacement exists.** Sweeping first destroyed a §6.2 repair on behalf of an extraction that had already been refused — the stem collision at the destination is exactly *why* the rename fell back to re-extracting, so the sweep paid the user's work for nothing and the source stayed unmanifested forever.
- **A failed carry-over deletes nothing and re-presents the rename instead.** The half-carried file still names the old path, which is what lets the next compile recognise the same rename and finish the job; withdrawing the new path's manifest entry and restoring the old one is what puts the rename back in front of it. The previous "recovery" — delete the file so the next run re-extracts — destroyed the repair the retry existed to preserve, and left the source permanently refused whenever the delete itself failed.
- **Removals from `raw/` are reported.** `CompileResult` gains `derivativesDeleted` and the completion notice names it. `raw/` is the user's folder and §6.6's preview lists only pages, so the sweep was the one thing a compile could take from them silently — which is also how the two losses above went unnoticed. A third list in the preview would be scope §6.6 does not ask for; saying what happened is not.
- **Rename pairing prefers the vanished path sharing the addition's basename, then its directory.** Two byte-identical sources make the pairing ambiguous and §4's content-hash identity offers no tiebreak — but the vault usually does. Without it, deleting one copy and moving the other made the survivor inherit the deleted file's history, its repair, and its wiki page.
- **Discovery sorts by code point, not `localeCompare`.** That ordering decides which addition pairs with which vanished path when several share a hash, so a Turkish or Estonian collation could produce a different rename from an English one — the exact hazard `comparePaths` was written for. `discovery.renamed` also keeps the order its decisions were taken in rather than being re-sorted afterwards.
- **`readableFromManifest` refuses an unsupported extension** instead of handing back the source path, whose raw bytes would otherwise reach a Call B prompt under a source's label.

### Fixes from the fifth round (verification of the fourth)

A pass scoped to the previous commit rather than a fresh review. It re-ran the convergence sweep (1,500 seeds, both commits) and found no non-convergence on either — but three of the six fixes had introduced new regressions, one of them worse than what it replaced.

- **A failed carry-over rolls the move back.** Removing the previous delete-based recovery left a file that had moved but not been repointed, and nothing could reach it: the sweep looks at the *old* location, and the retry only re-presents the rename while the source's bytes are unchanged — so an ordinary edit in between wedged the source permanently. Undoing the move leaves the vault exactly as it was found, which is a state both the sweep and the retry can act on. Deleting the stranded file remains the last resort if the rollback itself fails: losing the repair is better than a source that can never be ingested again.
- **A rename whose re-extraction failed restores its old path too.** Its derivative is deferred and still on disk, but nothing was re-presenting the rename, so the file was stranded with nothing able to reach it and nothing saying why — and it went on refusing that derivative path to any later source. Now the rename comes back each compile, which keeps the deferral justified and the failure reported.
- **Rename pairing scores both signals instead of ranking them.** Preferring the basename outright cross-paired two siblings that swapped names inside their own folders, transplanting each one's page, identity and repair onto the other — a clear regression on the previous first-in-order rule. Same folder now scores 2, moving deeper into it 1, and keeping the name 1, with ties falling back to the bucket's own order. That also fixes the case the fourth round's tiebreak missed, where two copies share a basename in different folders.
- **A page that fails because a citer is unreadable does not block its other citers.** Re-inventorying them would not produce the missing markdown — the file is in the vault but outside what compile can process, and §6.1 already names it in a skip notice. Blocking them left a healthy source unmanifested and re-inventoried on every compile, indefinitely, which is an invariant-12 problem rather than a degraded page. The page keeps the text it has and the failure is reported.

### Known limitations, accepted

- `previewCompile` is deliberately lock-free, so a preview taken *while* a compile runs can read a half-written vault, and a page deleted between its `list` and its `read` makes it reject. Nothing calls it in the plugin today — §8.1's flow uses compile's own confirm callback — but M4's pane will, and that is where the tolerance belongs.
- Deletions are permanent, not routed to Obsidian's trash. `FsAdapter` has only `delete`, the spec never mentions trash, and a derivative is already overwritten wholesale when its original changes — so a trash concept would be new scope (§0), not the smaller option.
- The scope preview lists pages, not the derivatives the sweep will remove. §6.6 enumerates what the preview shows, so a third list is scope the spec did not ask for; the README checklist covers the behaviour for a human tester.
- A failed page deletion leaves `wiki/_index.md` naming a page that this run's other pages resolved their links as though gone. It self-heals on the retry the manifest restore forces.
- Checking derivative *ownership* rather than existence costs a read and a YAML parse per unchanged converting source per compile, where it used to cost one `exists`. Reads are not writes: an unchanged vault still performs literally zero writes, which is what §6.2 and M1's acceptance criterion actually require.
- A carry-over that fails restores the old path's real hash so the rename is re-presented, which leaves that entry able to pair with an unrelated byte-identical file the user adds before the retry. The window is the same one an ordinary rename has — §4 makes content the identity, so duplicates are ambiguous by design — except that it persists while the failure does. `CASCADE_PENDING` is not usable here: the whole point is for the entry to pair again.
- A folder renamed to a name Luka cannot record (trailing whitespace, a backslash, a line terminator) reads as a deletion: the old paths are gone and the new ones are skipped, and nothing can establish that they are the same files. The §6.6 preview lists the pages before anything is removed, which is where the user sees it and can decline.

### Known cosmetic edge

- When a source is deleted and an unrelated new source in the same run wants the doomed page's title, the new page takes the §8.4 suffix (`a-2`) even though `a` frees up moments later. Titles are allocated before the merge and the doomed set is only known after it; subtracting the preview's "may delete" list from the claimed titles instead would let a rescued page collide with a new page at the same path, which trades a cosmetic suffix for a lost page.

## M2e — Recorded ownership and a single commit point

M2d shipped functionally correct but took five review rounds, and each round's fixes bred new defects — all concentrated in the rename/derivative subsystem. Two root causes were diagnosed: derivative ownership was *inferred* every compile (filename stems plus a user-editable `derived-from` key) instead of being recorded, and failure recovery was a web of bespoke compensations enabled by an optimistic manifest write that three later sites clawed back. This milestone replaces that subsystem rather than patching it again.

### Manifest shape

- **The manifest value is an object, not a bare hash.** §3 describes the file as "path → SHA-256 content hash"; the entry is `{hash, derivative?}` instead. This deviates from something §3 is explicit about, and is taken on the user's instruction rather than as a §0 smallest-option call: deriving a source's derivative from its filename stem every compile is what produced the M2d defect cluster, while `NormalizeOutcome.derivativePath` already computes the exact datum on every successful normalize and discards it. Ownership is now recorded at the one point it is known.
- **A bare string value is read as `{hash: value}`**, inside `loadManifest` — the single choke point every reader passes through, so no call site needs to know both shapes exist. A manifest written before this change therefore loads; its *converting* sources re-extract once, because their derivative is unknown and §6.2's missing-derivative rule fires, and that re-extraction records the pointer. Passthrough sources have no derivative and are unaffected. No committed manifest exists anywhere, so this is the entire migration burden.
- **A value that is neither a string nor an object with a string `hash` is dropped**, as any unreadable value always has been. A non-string `derivative` is dropped while the entry's hash is kept: the hash alone is still a usable record, and the source simply re-extracts.
- **`saveManifest` sorts keys with `comparePaths`**, not the default `.sort()`. Every other path ordering in the codebase is code-point ordered for the reason recorded under M2d's "Discovery sorts by code point"; this one site was left on the locale-sensitive comparator, which is the same hazard in the manifest file's own bytes. Each entry is written key by key rather than spread, so the serialized key order is fixed at the write rather than inherited from however the entry happened to be built.
- **`isSameManifest` compares structurally.** With object values, reference equality would report every compile as a change, since every run rebuilds its entries. Entries are `readonly` and never mutated in place, which also removes the shallow-spread aliasing hazard the old `{ ...manifest }` copy carried.
- **`CASCADE_PENDING` moves from `compile/cascade.ts` to `manifest.ts`**, with its reader `isPending`. It is entry-value vocabulary and belongs with the shape that defines it. A pending entry now *retains* its `derivative` pointer — that is the file the retry still has to sweep — while still bucketing by `.hash`, so it remains un-pairable as a rename for the reason recorded under M2d.
- **`readablePathOf(path, entry)` is added and re-exported from `core/index.ts`**, ahead of its M3 consumer: §7.1's node set ("the source itself if `.md`/`.txt`, else its derivative") is literally this value per entry, and recording ownership is what turns it from an inference into a lookup. It is `null` for a source whose cascade is pending, which is not in the vault to be read.
