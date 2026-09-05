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
- `previewCompile` deliberately does **not** take the lock: it does no work and writes nothing, the same reason §9's pane is never blocked by it. §8.1's flow does not use it — compile's own callback is what holds the lock — so it exists for §5's contract and for M4's pane. *(M4 correction: the pane does not call it. §9 never asks for a diff — its states are the Mode-A banner and the empty-vault pointer, both answerable from `getGraph()` alone — and §0 forbids resolving that silence by adding a consumer. `previewCompile` exists for §5's contract and for nothing else today.)*
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
- *(Superseded by M2e: there is no restore, because the manifest is written once from completed outcomes. A leftover the carry cannot delete is reported and not chased — see "M2e".)* **The restore covers the old side of a rename too.** That path is a manifest key — it is how the rename was detected — so the earlier note claiming it had "no entry to restore" was simply wrong, and a rename whose stale derivative failed to delete was orphaned with no retry path.
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

- `previewCompile` is deliberately lock-free, so a preview taken *while* a compile runs can read a half-written vault, and a page deleted between its `list` and its `read` makes it reject. Nothing calls it in the plugin today — §8.1's flow uses compile's own confirm callback. *(M4 correction: this entry predicted the pane would call it and place the tolerance there. It does not, so the tolerance is still unowned — the looseness is real but nothing exercises it, which is the honest state rather than the predicted one.)*
- Deletions are permanent, not routed to Obsidian's trash. `FsAdapter` has only `delete`, the spec never mentions trash, and a derivative is already overwritten wholesale when its original changes — so a trash concept would be new scope (§0), not the smaller option.
- The scope preview lists pages, not the derivatives the sweep will remove. §6.6 enumerates what the preview shows, so a third list is scope the spec did not ask for; the README checklist covers the behaviour for a human tester.
- A failed page deletion leaves `wiki/_index.md` naming a page that this run's other pages resolved their links as though gone. It self-heals on the retry the manifest restore forces.
- Checking derivative *ownership* rather than existence costs a read and a YAML parse per unchanged converting source per compile, where it used to cost one `exists`. Reads are not writes: an unchanged vault still performs literally zero writes, which is what §6.2 and M1's acceptance criterion actually require. (Still true under M2e, and for the same reason — but the file is now the one the entry names rather than one guessed from the stem, so the parse answers "is this still ours" instead of "whose is this". See "M2e".)
- *(Superseded by M2e's single commit point: nothing is restored, because nothing was written. The pairing window it describes survives, for the different reason that the untouched entry keeps its real hash — see "M2e".)* A carry-over that fails restores the old path's real hash so the rename is re-presented, which leaves that entry able to pair with an unrelated byte-identical file the user adds before the retry. The window is the same one an ordinary rename has — §4 makes content the identity, so duplicates are ambiguous by design — except that it persists while the failure does. `CASCADE_PENDING` is not usable here: the whole point is for the entry to pair again.
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

### Recording ownership

- **The manifest entry's `derivative` comes from `NormalizeOutcome.derivativePath`.** Normalization already computed and returned it on every successful convert and then threw it away; the ready loop now writes it alongside the hash. That is the one moment in a compile where ownership is known for certain rather than reconstructed, which is the whole premise of M2e.
- **§6.2's missing-derivative rule becomes a lookup.** Discovery no longer guesses `<stem>.md` from the source path and parses the file's `derived-from` to see whose it is; it reads the recorded pointer and asks whether that file still exists. This **supersedes** M2d's "Checking derivative *ownership* rather than existence costs a read and a YAML parse per unchanged converting source per compile", which is now zero reads and zero parses. The ownership check existed to defend against a *guessed* path — a stranger's file sharing a stem — and there is no longer a guess to defend. *(Superseded — see "Fixes from the first review round". The pointer is now checked against the file it names, so a derivative the user has overwritten reads as missing and the source re-extracts, audibly, every compile. What that check no longer does is **guess** which file to look at, which is the part that caused the M2d defects; the read and the parse are back, and cost what M2d's own note said they cost.)* The residual case was a user overwriting a derivative in place and stripping `derived-from`: the source then read as unchanged rather than re-extracting, and the problem surfaced only on whichever compile happened to queue a page citing it, once, and then went quiet.
- **A renamed source's entry takes its pointer from where the carry actually left the file, not from the old entry.** Copying the old entry whole would record a pointer to a file a folder move had already relocated, and the next compile would re-extract over a hand repair — at the model call the rename exists to avoid. *(At S2 the decision was taken in discovery; the cutover moved it to `carryRenames`, which decides against the vault at the moment it acts. Discovery no longer classifies derivatives at all.)*
- **A re-extracting rename records no pointer until the replacement exists.** *(Written for S2, when an entry was still written before normalization. The cutover removed that write entirely — see "The cutover" below — so the mechanism described here no longer exists; what survives is the principle, now enforced by the manifest being built only from completed outcomes.)*
- **`readableFromManifest` reads the entry instead of reconstructing a candidate.** It no longer stats the source to tell a repo directory from a file, and it can no longer hand back a document that merely shares a stem. The `derived-from` guard stays: locating a file and *serving it as a source's content* are different risks, and only the second one is worth a read. This makes M2d's fifth-round fix ("refuses an unsupported extension instead of handing back the source path") structural rather than a check — the source path is served only for a passthrough format, and a citation naming a path that is not in the manifest at all is refused before any of it.
- **A pre-ownership entry for a repo source is unreadable rather than reconstructed.** With no pointer and no extension to read a format from, there is nothing to serve; such a source is in the re-extraction wave anyway, so this is only reachable when that re-extraction also fails, where refusing is the conservative side.

### Design invariants

The list M2e is built to, mirrored as a comment block in the rename module. It is the rubric every fix and every review round is checked against — the point being that a reviewer-found bug gets fixed at this level, never by adding another compensation mechanism, which is what turned M2d into five rounds.

- **(I) Single commit point.** The manifest is written once, at the end, entirely from completed outcomes; no earlier phase mutates it; failure recovery is always "the untouched entry re-presents the work".
- **(II) Ownership is recorded, never inferred.** The entry names the derivative. `derived-from` is read only as a guard — before a destructive write, or before serving a file as a source's content — never to locate a file.
- **(III) No destructive operation is ever a failure-recovery step.** Deletes and overwrites are forward completion of successful outcomes only, always behind the guard.
- **(IV) Every phase before the manifest write is idempotent.** A crashed or failed run re-runs to the same state.
- **(V) Classification happens once.** The four rules and rename identity are decided at discovery against the un-mutated vault; carry outcomes are decided in one deterministic `comparePaths(to)`-ordered pass before extraction begins.
- **(VI) Readable markdown is looked up, never reconstructed.** A source's body comes from this run's normalization outcomes, or else from the file its entry names; no candidate path is ever derived from the source path. "This run's outcomes" means every source whose *normalization* completed — a later failure of that source's own inventory or pages does not un-write the derivative it produced. And a recorded pointer counts only when a *file* stands at it.

Invariant VI was added by the mid-build check rather than designed in, per the rule that a missing invariant is extended deliberately in the same commit as the fix it explains. Both defects that check found were violations of it.

### Fixes from the mid-build behavior-identity check

A differential harness — thirty scenarios, each compiled two or three times, snapshotting the result object, the whole vault, the manifest and the IO counters — run against both `7312832` and the S1+S2 tree, and diffed. Thirty-one differences; two were defects, both in code that had looked obviously equivalent.

- **A citer's body comes from every source that normalized, not only those that also inventoried.** The map `bodyOfSource` reads was keyed off `ready` (normalized **and** inventoried), so a source whose own Call A failed lost the derivative normalization had just written for it — and because such a source has no usable manifest entry either (an addition has none yet; a re-extracting rename records none until it completes), the fallback found nothing. §6.5's citer set is about who cites the page, not about whose inventory succeeded, so a page lost a citer it still claimed in its block and was left un-regenerated. The old code hid this by reconstructing `<stem>.md` from the path, which is exactly the inference invariant II removes — so removing it exposed a gap that had always been there in principle. Violates VI.
- **A recorded pointer counts only when a file stands at it.** `fs.exists` is true for a directory, so a folder built over a derivative read as a present derivative and the source went quiet as unchanged. `fs.stat().kind === "file"` is still a lookup — no guess, no parse. Violates VI.

Re-running the differential after both fixes leaves nineteen differences, in four families, all intended:

- The compat re-extraction wave from an old bare-string manifest (logged above).
- The stripped-`derived-from` trade-off (logged above).
- **A latent bug closed.** A rename that had to re-extract, whose page generation then failed, was left manifested under its new path by the optimistic pre-normalization write, which the later withdrawal only covered for normalize and inventory failures — not for a blocked page. The source read as unchanged forever and the owed page never regenerated: the differential shows the very next compile as a silent `noop`. Recording no pointer until the replacement exists makes that same compile read the source as modified, retry the page, and settle. This is what invariant I removes structurally in the cutover; here it falls out of the entry shape.
- **One extra, accurate failure report.** With a directory at the derivative path, the old code threw a raw `ENOENT` out of the path-reconstruction helper, which was not classified as an unreadable citer and so blocked a source that had already failed and been dropped — the page silently kept its old text. The lookup returns "not readable" instead, which is the case M2d's fifth round already decided should be reported. Same vault, same counters, same `noop`; one more line in `failed`.

### The cutover: one commit point, and policy B

- **The manifest is built once, at the end, from completed outcomes.** The optimistic write that recorded every rename before any work happened is gone, and with it the three sites that clawed it back. Failure recovery is now a single fact rather than a mechanism: the entry that was never rewritten still describes the vault as it was, so §6.2 presents the same work again next compile. This supersedes, by name: the second round's **"removes the half-carried file"**, the fourth round's **"a failed carry-over deletes nothing and re-presents the rename instead"**, and the fifth round's **"a failed carry-over rolls the move back"** and **"a rename whose re-extraction failed restores its old path too"**. Each was a different answer to "how do we undo the entry we should not have written"; not writing it removes the question. A test pins the property directly — a failed carry followed by a failed fallback leaves the manifest file byte-for-byte unchanged.
- **The carry repoints before it moves.** The old order moved the file and then repointed it, so a failure left a file the manifest no longer located — which is what a rollback existed to undo, and what a *failed* rollback then needed a third recovery for. Repointing first keeps the entry's pointer true at every instant: a failed move leaves a file exactly where the manifest says, already naming the new path, and re-running finishes it. Nothing needs undoing, so nothing does (III).
- **The ownership guard reads `derived-from` at two different strengths, and the difference is deliberate.** At the location the entry records, a file naming *either* end of the rename is ours — `from` is the untouched case and `to` is a previous run that repointed and could not finish, which must re-run to the same state (IV). At any other path only `from` counts: a file already naming `to` where the entry does not point was written for an earlier occupant, since the source arrived at `to` only just now — that being what made it an addition to pair in the first place. The relaxed half is also what lets a fallback clean up the file it managed to repoint before failing to move.
- **Policy B: any complication falls back to plain re-extraction, and says so.** A carry that cannot complete puts its source on the same worklist as any other, in the same run. This costs a model call and loses a hand repair, and both are reported — where the M2d answers tried to preserve the repair across runs and generated a defect per attempt. This supersedes the third round's **"decision taken once at discovery"** for the *derivative* decision (rename identity is still decided once, at discovery — what moved is where the markdown goes) and the fourth round's **"a re-extracting rename keeps its old derivative until the replacement exists"**, whose deferral machinery was the reason a second sweep pass existed at all.
- **A fallback may overwrite markdown naming its own old path.** An extension-only rename (`data.csv` → `data.tsv`) lands on the very file it failed to repoint, which the invariant-7 guard refuses by default. `claimDerivative` takes a list of accepted origins, and the fallback adds exactly one entry to it — the source's own previous path. Every other file is still refused, so this widens lineage, not permission.
- **`CompileResult` gains `reported`.** Distinct from `failed`: nothing in it retries, because nothing is owed. A rename that fell back got its markdown, it just cost a call; a file left alone was never Luka's to remove. Both would otherwise be invisible — the first because the run succeeded, the second because §6.6's preview lists pages only. When a fallback *also* fails, only the failure is reported: M2d's **"one problem, one notice"** applies, and describing a detour that led nowhere is not a second problem.
- **The sweep names its file instead of computing one.** A departed source's entry says which file was its markdown, so there are no stem candidates and no collisions to reason about. One guard stands before the delete; when it fails the file is left alone, named in the report, and the entry is dropped anyway — retrying cannot change whose a file is, and re-presenting the deletion would only repeat the notice every compile. This supersedes M2d's **"the candidate is computed as `<stem>.md` beside the departed path without consulting the format"**, which no longer has to be safe because it no longer happens.
- **The sweep runs before the carry and before normalization.** Same reason as M2d's ordering note, now with a second beneficiary: a derivative location a departed source was holding is free for a rename to carry into, not only for a new source to extract into.
- **Only outright deletions are swept.** A renamed source has not left the vault, and its old path is where its markdown currently sits — which the carry is about to use. The old code swept renamed-away paths too and needed a deferral set to stop itself destroying what it was about to need.
- **`Rename` carries the discovered source, not a copy of its fields.** The plan slimmed it to `{from, to, hash, format}`; it is `{from, source}` instead, because a fallback rename rejoins the normalize worklist and needs the source's `kind` — and reconstructing `kind` from the path would be an inference of exactly the sort invariant II removes.
- **A rename is no longer counted as `modified` when its derivative cannot be carried.** It is one event, and §6.2 calls it a rename. Two consequences, both accepted. A pure-rename diff whose carry hits a complication no longer opens the §8.1 confirm modal — correctly, since nothing page-*destructive* happens on that path: no page is put in the requeue list and none is deleted. It is not, however, true that no page is rewritten: a fallback re-extracts and re-inventories, and §6.5's merge regenerates any existing page its items match, wholesale, without a modal. That is the same thing any modified source does, and §8.1 asks for the modal on deletions and modifications rather than on every write. And pages are not requeued on the *rename's* account, which is right, because the source's content is identical — that is how the rename was detected.
- **A format-changing rename carries rather than re-extracts.** `a.html` → `sub/a.csv` moves the markdown and repoints it; the markdown still records `source-format: html`, which remains true of *it* — a rename does not re-extract, and §6.2 keeps a derivative until the original changes. Rebuilding it because the new extension would extract differently would spend a model call to restate the same content.

### Known limitations, accepted (M2e)

- **A pre-ownership entry leaves its old derivative behind.** A manifest written before ownership was recorded names no file, so a source that renames or is deleted under such an entry has nothing for the sweep to act on, and the markdown at its old stem stays as an unreferenced `.md`. Finding it would mean guessing `<stem>.md` — the inference invariant II exists to remove. *(This entry originally claimed the leftover was "invisible rather than harmful" and that the case had no instances in the wild. The first round of M2e review disproved both by running them: the leftover is a `.md` carrying `derived-from`, which the invariant-7 write guard then honours forever, so it held that filename stem against every future source. The rule below — Luka's own markdown, whose source has left the vault, is Luka's to rewrite — is what makes it harmless. It is still not swept.)*
- **A leftover the carry could not delete is reported once, not chased.** The rename completed, so its entry names the new derivative; keeping the old one reachable would need a second pointer per entry and a retry path for it, which is the extra failure state this milestone exists to remove. This supersedes M2d's **"The restore covers the old side of a rename too"** (first M2d review) — that restore made the *rename* re-present in order to retry a *file deletion*, which is why it also had to defend against the restored entry pairing with an unrelated file. *(An earlier draft of this line cited the name of the test rather than the note entry; the claim was right, the citation was not.)*
- **A crash between the carry's move and the manifest write costs the repair, not the source.** The file is at the new location naming the new path, with the entry still pointing at the old one, so the next compile falls back and re-extracts over it. Adopting it instead would mean trusting a file that names `to` at a path the entry does not record, which is indistinguishable from an earlier occupant's markdown. Policy B pays a model call rather than risk handing a source somebody else's document.

### Fixes from the first review round

Three strands run in parallel against the cutover: a correctness review of the diff, an invariant and §0 audit, and an adversarial sweep — randomised vault churn with injected transient IO failures over 1,500 seeds, in two modes, one of which aborts the run mid-flight at the unguarded index and manifest writes. All three found the same top defect independently, which is the first thing worth recording about the review design.

- **A carried rename's markdown is one of this run's outcomes.** `bodyOfSource` resolved a citer's body from the normalize outcomes or the manifest as found. A carried rename is in neither: it skips normalization by design, and its new path is an addition, so the manifest as found still names only the old one. Any page citing both a carried rename and a *modified* source therefore failed to regenerate, kept a body naming the old path while its citation block named the new one, and — because an unreadable citer is reported rather than blocking its co-citers — never came back. Invariant VI named one source of outcomes where there are two; it now names both. This defect was introduced by the cutover itself: before it, the optimistic pre-normalization write happened to put the new path in the manifest, so the lookup resolved for the wrong reason.
- **A recorded pointer counts only while the file standing at it still names this source.** Discovery checked that *a file* was there. A user who overwrites a derivative in place then leaves the source reading as unchanged for good, with its markdown unreachable — audible only on whichever compile happens to queue a page citing it. The guard is back, and this **supersedes the S2 decision** that removed it: what caused the M2d defects was *guessing* which file to look at, not looking. The entry says which file; the parse says whether it is still ours. One read and one YAML parse per unchanged converting source, and still zero writes.
- **The entry's own file outranks anything else on disk.** The carry checked the destination first and adopted any file there naming the source's old path — even when the entry named a different file that was sitting right there, hand-repaired. It deleted the repaired one afterwards, and reported nothing. Now the recorded file is tried first; when the destination holds something the entry does not name, there are two candidate files and nothing to choose between them, so nothing is chosen and the source re-extracts and says so.
- *(Half true, corrected in the second round: the computed path survives in one branch, now carved out of invariant II by name.)* **The carry never adopts a file when the entry records no pointer.** With no pointer, the only thing locating a file was `<stem>.md` computed from the source path — the inference invariant II exists to remove, present in the one module that names it. Such a rename now falls back, which needs no guess.
- **A rename that vacates the location another rename wants goes first.** The pass is ordered by the new path, so whether the vacating rename ran first was decided by the code-point order of two unrelated filenames — and if it ran second, the other rename found the destination occupied, fell back, spent a model call, and had its hand-repaired derivative replaced. The pass now visits a blocker before its dependant; a cycle stops the recursion and both are decided against the vault as it stands.
- *(Re-rooted in the second round — the "on every path" part was wrong and destructive. See below.)* **Blocked means not settled, on every path.** A source whose markdown is written but whose page could not be is not a source that completed, so §2 invariant 3 keeps it out of the manifest — no special case for renames, which previously recorded a hash without a pointer. The old entry stays, presenting the same rename again, which is what brings the page back. A carried rename never reaches the worklist, so the loop that reports blocked sources cannot see it; it is reported here instead, because withheld-and-silent is the one combination that leaves a user with nothing to act on. Cost: a re-presented rename re-extracts, one call per blocked page per compile until it succeeds.
- **The commit point does not abandon the run.** `removeSupersededDerivative` and `sweepDeparted` do IO, and an unguarded throw there discarded a compile that had already spent its model calls and written its pages — to be re-spent next run. Both now convert a failure into one notice.
- **A passthrough citer's path is checked, not assumed.** Returning it unchecked meant a file that had gone produced a raw read error, which no caller classifies as an unreadable citer, and that blocks every *other* citer of the page — the failure mode M2d's fifth round fixed for the other branch.
- *(Reverted in the second round: the test it used was not a test for that. See below.)* **Luka's own markdown, whose source has left the vault, is Luka's to rewrite.** §2 invariant 7 says exactly that; `claimDerivative` was stricter, refusing anything not naming an accepted origin. A derivative whose named source exists nowhere is not another source's markdown — and refusing it held that filename stem against every future source for good, because a file carrying `derived-from` is never a source and so nothing else ever looks at it. One `exists` on the named origin, on the path that was about to refuse anyway. A source that is merely *skipped* this run still exists, so its markdown is still spoken for.

### Known limitations, accepted (first review round)

- **A transient IO failure can turn a zero-call compile into an N-call one.** §2 invariant 12 makes model calls a deterministic function of the worklist. Under the failure policy a complication — including a `move` that fails once because a file was briefly locked — moves the source *into* the worklist, where it costs an inventory call, a vision call if it is an orphan image, and a page-generation call for every page its inventory matches. The count is still determined by the worklist; the worklist is no longer determined by the diff alone. Accepted on the user's decision, as the direct consequence of the failure policy they chose: the alternative is to distinguish transient failures from permanent ones and defer the first kind, which is the retry machinery this milestone deleted.
- **A crash between the carry's move and the manifest write costs the repair.** Restated from the cutover's entry because the first round sharpened it: this is the single window where invariant IV is "so far as it can" rather than absolute, and the invariant block now says so in those words rather than claiming idempotence and accepting a counterexample three paragraphs later.

### Fixes from the second review round

Scoped to the first round's fix diff, because in this project a fix has been the likeliest thing to break something. Two reviewers and the randomised sweep ran against it; both reviewers independently found the same two defects, and both were **regressions the first round's fixes introduced** — the vault was safer before them. That is the pattern M2e exists to break, so both were treated as design errors and taken out rather than narrowed.

- **Reverted: the widened invariant-7 write guard.** The condition was `!fs.exists(derivedFrom)` — read as "the origin is nowhere, so this markdown is abandoned". It is not a test for that. A *renamed* source's old path does not resolve either, and its markdown belongs to a source that is alive: a hand repair was silently overwritten by an unrelated new file landing on the freed stem, with nothing in `failed` and nothing in `reported`. It also treated any unresolvable `derived-from` — an empty string, a relative path, anything a copied or hand-edited file might carry — as a licence to overwrite a user's file wholesale, against invariant 7's own first clause. The asymmetry is what settles it: on the delete path an unmatched `derived-from` earns a refusal *and* a notice, so the write path may not answer the same evidence with silent replacement. This restores the limitation below, which is the smaller option §0 asks for and which was on the table when the widening was chosen.
- **Re-rooted: a carried rename is never blocked by a page failure.** The first round applied invariant 3 "on every path", which for a carried rename meant withholding an entry after the carry had already moved and repointed the file — leaving the old entry naming a vacated path, so the retry could not recognise its own work and re-extracted over §6.2's sanctioned repair. Withheld-and-silent had been replaced by withheld-and-destructive. The root error was accepting the premise: a page can name a carried rename among its citers, but §6.2 skips regeneration for a rename, so it contributed no inventory this run and re-running it cannot regenerate anything. Blocking it was never going to help. This is M2d's fifth-round rule ("re-inventorying them would not produce the missing markdown") applied to a case that round did not reach. The page still comes back, through whichever source actually queued it. A *fallback* rename does reach the worklist, so invariant 3 applies to it exactly as to any other source, and that half of the first round's fix stands.
- **`derivativeOrigin` no longer swallows IO failures.** It answered "not a derivative" for a file it could not read, which the restored missing-derivative check then read as "not ours" — so a single transient read reclassified an unchanged source as modified and re-extracted over it, with nothing in `failed` and nothing in `reported`. An unreadable *document* and an unreadable *disk* are different answers; only the first is decided there now. Discovery treats a read failure as "the entry still stands" — the conservative side, since the alternative destroys a file over a blip — while the two readers that serve content answer "no readable markdown", which costs one page one run instead of blocking that page's other citers.
- **`readableFromManifest` catches a throwing `stat` as well as a missing file.** The first round closed the `read` half of this and left the `stat` half, which fails in the same way: an unclassified error blocks every co-citer.
- **A leftover another outcome claims is kept silently, not reported.** `removeSupersededDerivative` takes the set of locations this run records as some source's markdown. Behaviour change from the first round that went unlogged; it is what stops a completely successful two-rename run from reporting a leftover that is in fact this run's own freshly recorded derivative.
- **Two comments that were wrong.** A two-rename cycle leaves *both* renames falling back, not one. And the `readable` map's two loops write provably disjoint keys, so their order settles nothing today — worth saying, since the ordering was justified by a case that cannot arise.

### Known limitations, accepted (second review round)

- **An orphaned derivative holds its filename stem.** Markdown carrying `derived-from` whose named source is nowhere is never a source (discovery skips it) and never swept (no entry points at it), and the invariant-7 write guard then refuses that path to every future source. Reinstated deliberately: the alternative tried in the first round could not tell an abandoned file from a live source's, and there is no test that can, because `derived-from` is the only evidence either way. The notice names the file, so a user can delete it. A guarded sweep over `raw/` — discovery already parses every `.md` there — remains the option if this ever bites in practice; it is not built, because §0 asks for the smaller thing until it does. *(How often it bites, measured after the third round rather than assumed: on the churn sweep this entry is the substrate of a family of permanent blockages — a source barred from its derivative path with no genuine rival wanting it — hitting 114 of 1,500 seeds when the generator hand-edits `derived-from` keys, and 1–6 of 1,500 under ordinary user actions only (add, delete, rename, edit, repair). So it is overwhelmingly a hand-edit phenomenon, not the migration-only rarity earlier wording implied — and the name-swap deadlock the third round documented is one member of the family. Separately, 45–63 of 1,500 seeds settle into genuine §6.1 stem collisions, which are permanent by design.)*
- **Unguarded IO outside the guarded phases still ends a run.** Discovery's source collection, `repointRenames`, the `wiki/_index.md` write and `saveManifest` have no try/catch, so an IO failure in any of them propagates out of `compile()` after model calls have been spent. The first round's entry claiming "the commit point does not abandon the run" is true of the two functions it names and not of this wider class, which predates M2e and is unchanged by it. Recorded here rather than fixed: converting every IO site into a per-source failure is a change to how the whole pipeline reports, which is not this milestone's.
- **A rename may still adopt markdown at a computed `<stem>.md`** when the entry's own file is gone. Now carved out of invariant II by name rather than claimed not to happen. It is what lets a user move a source and its markdown together in one gesture, and it can only ever adopt a file naming that source's own old path.

### The convergence sweep is in the suite

`tests/churn.test.ts`. Randomised vault churn with injected IO failures and page-generation failures, checking that the vault settles once the trouble stops and reports the same thing about itself every compile afterwards. It found five defects across the two review rounds, three of which no hand-written test in this repo would have caught, and it is the only check that exercises several renames interacting in one run.

**What mutation testing showed about it.** Re-introducing each of the two regressions the second round removed, and re-running 1,500 seeds: the sweep passed both times. It checked *convergence*, and a destroyed hand repair converges perfectly — it is a stable state. The instrument was blind to the exact class of defect that round had just found, while citing it as evidence. Two checks were added as a result, both derived from §6.2 rather than from the bugs:

- A repaired derivative whose original was **unchanged** going into the compile must still carry the repair afterwards, unless the run reported something. That is §6.2's "a derivative persists until the original changes", made checkable.
- Repaired markdown must never be found afterwards **naming a different origin** with nothing reported — that is another source's markdown being taken over, which invariant 7 forbids outright.

Both were shaken out against 1,500 seeds in each mode before being trusted: the first false-positived on stale copies sharing an origin (fixed by following the *recorded* derivative rather than any file carrying the marker), the second on a source deleted and its stem legitimately reused in the same run (excused by name).

Known limits, stated rather than papered over. The third round re-ran the mutation test against the strengthened sweep and **neither regression is caught even now** — the earlier note claimed this only of the first. Three reasons, all real:

- The generator does not reach the first regression's shape: a fallback rename whose re-extraction also fails, plus an unrelated source landing on the vacated stem in the same run.
- ~~The `reported.length > 0` escape is per-*run*, not per-file, so one unrelated notice disables both data-loss checks for that whole compile — and a fallback rename always reports, which is exactly the first regression's setting.~~ *(Fixed after M2f: a notice now excuses only the file it names or the source that owns it. Neither regression is caught even with the stricter escape, and the closing round measured why: the escape is **never reached at all** — zero times in 1,500 seeds in both modes — because neither data-loss check ever fires on this generator. The change is behaviourally inert here, not validated by the sweep. Correct on its own terms and worth keeping; it simply is not evidence of anything.)*
- 284 of 1,500 seeds settle onto a vault that reports the same failures every compile. Some are §6.1 stem collisions that are permanent by design; the sweep cannot tell those from a genuine deadlock, which is why it did not find the name-swap one.

Both regressions are covered by tests written directly against them. The sweep covers the neighbourhood.

It is committed rather than kept as a scratch file for a §0 reason: the review rounds cited seed counts as evidence, and evidence nobody can re-run is not evidence. Default 120 seeds, a few seconds; `CHURN_SEEDS=1500` is what the rounds ran, and `CHURN_FIRST` pins a single seed for diagnosis. Every seed is deterministic — the generator and the fault injector share one seeded PRNG, so a failing seed reproduces exactly.

### Fixes from the third review round

Scoped to whether the second round's revert and re-root settled it. On that question the answer was yes: all four behavioural changes hold, and re-introducing either regression fails tests written for it. What the round found instead was a claim, and a hole the second round's fix had only half closed.

- **Two sources that swap names deadlock, permanently, and the second round wrote down that they converge.** Each rename's destination holds the other's markdown, so both carries fall back — and then neither can re-extract, because the invariant-7 guard rightly refuses a file naming a source that is not its own. Both sources stay un-ingested for good. This predates M2e's review rounds entirely: the strict guard was there at the cutover, and the first round's widening masked it by accident, so the second round's revert did not cause it — it revealed it. The comment added at the deciding site claimed the opposite, which is worse than saying nothing, and is fixed. Pinned by a test that also pins the way out: removing either derivative lets one source ingest, whose commit then sweeps the markdown the other one needs, and the compile after that finishes the job. Not resolved in code — see the limitation below.
- **A citer's body read was still unguarded.** The second round guarded `readableFromManifest`'s `stat` and its origin read, and stopped there; `bodyOfSource` then reads the file it was handed, outside any guard. A passthrough citer whose file becomes unreadable between the two therefore still escaped unclassified and blocked every *other* citer of its page — the exact failure the fix was written for, one step further along. Found by writing the test the round said was missing: the fix had no test at all, and deleting both of its guards left the suite green.
- **The rationale for "a carried rename is never blocked" was one step too strong.** It said re-running such a rename "could not regenerate anything". It could: withholding leaves the entry naming a vacated path, so the next run falls back, re-inventories and does regenerate the page — at the price of the repair. The correct argument is the one that sat beside it: a page is only ever queued by a source that was added, modified or deleted, so the source that owes it is un-manifested anyway and the destruction buys nothing. In a milestone where an over-strong rationale has already licensed a bad fix, the weaker true argument is the one to keep.
- **Invariant II said its carve-out "is logged".** It is written up here; it is not `reported` at runtime, and "logged" means the latter everywhere else in that block. Reworded, with the reason it needs no notice: the carry succeeded and nothing was lost.

### Known limitations, accepted (third review round)

- *(Superseded by M2f: a derivative may stay where it lies, so a swap needs nowhere to park a file. See "M2f".)* **Two sources that swap names cannot be resolved by this pass.** A swap needs somewhere to park a file while the other moves. The way out without new machinery is to record the pointer wherever the file already lies — recorded ownership makes that representable — but §6.1 names derivatives after their original, so that is a spec question rather than this pass's to decide. It is loud: both sources are reported with their reasons on every compile, nothing is destroyed while it waits, and removing either derivative ends it in two compiles. Deliberately not fixed by widening the write guard: that is the third time this milestone that widening a guard would have looked like the answer, and the first two both destroyed user data.
- *(Fixed after M2f: it is reported. See "Reporting markdown that cannot be read".)* **An unreadable derivative is silent and self-perpetuating.** When the missing-derivative check cannot read the file it names, it keeps the entry standing — the right call, since the alternative destroys a file over a transient blip — but says nothing. The source reads as unchanged, and the condition surfaces only on whichever compile happens to regenerate a page citing it.

## M2f — Floating derivatives

The third round left one defect standing: two sources that swap names deadlock for good. Each rename's destination holds the other's markdown, so neither can be placed at `<stem>.md`, and the invariant-7 guard then rightly refuses each one's re-extraction over a file naming somebody else. Both sources stay un-ingested. The measurement under the M2e orphan-stem entry shows the wider family it belongs to.

Every attempt to fix that family by *loosening a guard* has destroyed user data — twice, in the first review round. This milestone fixes it by loosening a *convention* instead.

### The decision (user-directed, in two parts)

§6.1 says normalized output is "persisted next to the original in `raw/`, named `<original-stem>.md`". Read as a rule about where a derivative must forever live, a rename whose stem is taken has nowhere to go. Read as a rule about **where a normalization writes** — which is what the sentence is about — a rename may leave the file exactly where it is and record that location. Recorded ownership already made that representable: the entry names the file, and every reader in the codebase already goes through the pointer. This is a deviation from a natural reading of §6.1, taken on the user's instruction, and logged as such rather than as a §0 smallest-option call.

The second part was forced by the design pass and approved separately. Floating only in the carry is **unsound**: once a swap settles as two floats, modifying either source re-extracts toward a canonical path the other's live float holds, is refused, and fails permanently — the same family rebuilt one step later. So a **re**-extraction whose canonical path is refused may rewrite the source's *own recorded* file in place. That file is this source's, confirmed by the same guard that refuses everyone else's, and rewriting it is invariant 7's plain sentence: derivative files Luka wrote are Luka's to rewrite. Nothing is widened — the only address ever reached this way is one the manifest already recorded for this very source, and an *empty* non-canonical path is never taken.

### What changed

- **The carry floats instead of falling back.** When the entry's file is intact and ours but the destination is occupied, the file is repointed where it lies and recorded there. The occupant is not read, not judged and not touched — there is no second candidate, because the entry already named the first. Cost: nothing. A swap now converges in one compile at zero model calls with both repairs intact.
- **Normalization prefers the canonical path and falls back to the recorded one.** `chooseTarget` claims `<stem>.md` first, always, so floats *decay*: a floated source lands home the moment the obstruction clears. Only when canonical is refused does it continue the file its entry records.
- **A returning float's vacated file is swept at the commit point**, behind the same guard as every other removal — forward completion of a re-extraction that succeeded (III), and a structural no-op for every source that wrote where its entry already pointed.
- **Invariant VII added**: the pointer is the address; `<stem>.md` is a preference. IV notes that a float never opens the move window (repoint-in-place is the whole operation). V notes that the ordering pass now buys tidiness rather than correctness — a mis-ordered dependant floats rather than re-extracting. II is unchanged: its carve-out fires only when the entry's file is *gone*, and a float exists only while it is intact.
- **Policy B**: a float is a happy path, not a complication, so it reports nothing. What still falls back is a carry that cannot *write* — no pointer to follow, or a repoint that fails.

### Behaviour that changed, with its new expectation

Five existing tests pinned the old outcome and were rewritten: the swap now converges; a destination held by a user's note floats rather than failing; two renames competing for one stem both carry (one lands, one floats); a stale copy at the destination is left byte-identical and never consulted; and a copy the user made in the new folder no longer triggers a re-extraction. In every case the new outcome costs less and destroys less than the old one.

### Known limitations, accepted (M2f)

- **A stem held by a live float is contention, reported.** After a float, `raw/a.md` may belong to a source named `b.html`; a later `a.csv` wanting that stem is refused, exactly as for a genuine §6.1 collision. It decays on the float owner's next modification or rename, both of which prefer canonical. There is deliberately no standing re-homer: it would have to write on an unchanged vault, which §6.2 forbids, and it is precisely the extra machinery that turned M2d into five rounds.
- **A float can leave a stale copy in place.** The occupant of a contested canonical path is never read and never rewritten, so a copy the user left there stays. It is litter, not damage — the pointer outranks it permanently — and it is overwritten the next time that source re-extracts canonically.
- **A float is silent.** Nothing is `reported`: the carry succeeded, nothing was lost, and the manifest records where the file is. Same rule as invariant II's carve-out.
- **§7.1 cosmetic**: a float node's basename will not match its source's stem in the graph. Noted for M3.

### The sweep's deadlock classifier

`tests/churn.test.ts` gained a check for the property this milestone establishes: nothing may settle into permanent failure while holding intact markdown of its own — directly, or under the vanished path it pairs with as a rename. A genuine §6.1 collision loser has no such file, which is exactly why it is trying to write one, so the check separates deadlock from collision without hard-coding either.

Getting it honest took three corrections, each a flaw in the *check* rather than the code: it first paired on any entry sharing a hash (the generator makes byte-identical sources on purpose), then on entries whose file is still in the vault (a live source, never a rename partner), and it resolves ambiguity by requiring *every* candidate to have intact markdown rather than guessing which one `bestPairing` chose. A fourth correction went the other way — the "every entry names existing markdown" check had to learn that an entry whose *source* is gone is a departure awaiting its cascade or an unsettled rename, both deliberately kept so the work re-presents.

Stated rather than papered over, and corrected by the closing round's measurements: the classifier **has produced no signal in either direction**. It returns zero hits at 1,500 seeds in both modes on a healthy tree, and — measured, not assumed — *also* zero with the float branch deleted, with the settled-failure count identical (310 and 655). The earlier explanation here, that the generator almost never produces a swap, is true but not the whole reason: removing the float branch no longer recreates the deadlock at all, because `chooseTarget`'s recorded-path fallback resolves a swap on its own (converging at two model calls, with both hand repairs destroyed and both losses reported). So the classifier is sound but unexercised, and it does not yet evidence the property it names. What does evidence it is the tests written directly against the swap, mutation-verified: removing the float branch fails seven of them, the recorded-path fallback one, the commit-point sweep one.

### Reporting markdown that cannot be read

The missing-derivative test reads the file an entry names to ask whether it is still that source's. When the read itself fails, that answers neither question, and the entry is kept — the alternative re-extracts over whatever is there on a transient blip, which is the round-2 defect that decision exists to prevent. What was wrong was the silence: the source read as `unchanged` forever with unreachable markdown, and the condition surfaced only on whichever compile happened to regenerate a page citing it.

`DiscoveryResult` gains `unreadable`, which compile folds straight into `reported`. Discovery does not classify differently and does not fail the source — it just stops being quiet about a source it could not verify. `reported` is the right channel rather than `failed`: nothing is owed and nothing retries, which is exactly what that field is for.

### The instrument's fourth blind spot, and what it costs

The sweep's "Known limits" listed three reasons it misses the two regressions the second round removed. The closing round found a fourth, and it is the structural one: `repairsLost` skips every entry whose manifest key moved —

    if (entry?.derivative === undefined) continue;   // deleted or renamed

— on the grounds that the convergence checks cover renames. They do not cover *this*: M2e's own mutation note established that a destroyed repair converges perfectly well, which is why the data-loss checks exist at all. Renames are this subsystem's entire subject, so the one check built to catch silent repair destruction is blind precisely where destruction happens. A stress that follows a source through a rename by content hash instead of by manifest key finds losses at 18 seeds per 1,500.

Recorded rather than fixed, deliberately: following renames by content hash inside the sweep is a second pairing implementation living alongside `bestPairing`, and a check that has to guess which source it is looking at is how the classifier above produced three rounds of false positives before it produced none. The finding it exposes is real and is logged below on its own terms.

### Accepted: a derivative dropped by a passthrough rename is counted, not named

`raw/data.csv` with a hand-repaired `raw/data.md`, renamed to `raw/notes.txt` — identical bytes, so it pairs as a rename, and `.txt` is passthrough. The carry returns "carried, no derivative" (correct: the source is now its own markdown), and the commit point sweeps the recorded file behind the ownership guard (also correct: keeping it would strand an orphan holding the `data` stem, the limitation directly above). `reported` stays empty.

**Correcting this entry as first written.** It claimed "the run says nothing", and that is false — `derivativesDeleted` is incremented on this path, so the completion notice reads "compile finished — removed 1 file from raw/", which is the line M2d added for exactly this reason ("Removals from `raw/` are reported… `raw/` is the user's own folder"). The removal is announced; what is missing is *which* file. The entry also filed this under "work already destroyed, and the run has to admit it", which overstated a counted removal into a silent one. Both claims came from this milestone's own closing round and were repeated here without being checked against `notices.ts` — the same failure the two corrections above are about, committed in the act of recording them.

What actually remains is an inconsistency, not a defect: everywhere else in this subsystem a file superseded or left alone gets a named `reported` entry, and this one destructive path gives a count instead. **Left as it is, deliberately.** The deletion is correct and expected — the user changed the source's type, and the descriptor card genuinely stopped being anyone's markdown — and M2d chose a count here on purpose. Naming every correct deletion is how a notice channel becomes noise, and §0 prefers the smaller thing until the larger one earns itself. The fix, if it ever does, is one `reported` entry in the passthrough branch of the carry.

Predates M2f and is provably unchanged by it: both code paths are byte-identical to `d73f8b4`, and a 1,500-seed stress finds the same 18 instances on both trees, differing only in which file holds the repair.

## The M1 / M2a–M2c review campaign

M2d–M2f came through a heavy adversarial campaign — disjoint-scope reviewers, a mutation-validated randomized instrument, failing-test-first, and a stop-rule — which caught a defect that had survived every prior review, including silent data loss. The four older milestones had their original tests and audits and nothing like that. This campaign closed the gap so M3 starts on a floor that has been stressed rather than assumed.

The organising lesson from M2d–f held again, and is worth restating because this campaign is evidence for it: **a clean review round means that round's methods found nothing, not that the code is clean.** Every round here found something, including the rounds reviewing the previous round's fixes.

### The instruments

Three, each committed on its own and each mutation-validated before it was trusted. Defaults keep every one under about ten seconds so they stay in the suite; env knobs raise them for review rounds.

- **`tests/fuzz-compile.test.ts`** — whole-pipeline hostile bytes. `FUZZ_SEEDS` (default 150). Oracles: no `raw/` content makes `compile()` reject; runs 2 and 3 are `noop` with zero model calls and a byte-identical vault; every non-derivative placed file is byte-identical after, BOM preserved and invalid UTF-8 untouched; the loaded manifest and every `parseFrontmatter` result has `Object.prototype`; no `-->` breakout in any derivative or marker.
- **`tests/fuzz-localize.test.ts`** — localizer and marker injection. `FUZZ_LOCALIZE_SEEDS` (default 200). Oracles: the localized link names exactly the file written; no marker escapes its comment; re-localizing its own output is a no-op.
- **`tests/provider-matrix.test.ts`** — a scripted fault matrix, deliberately *not* a fuzzer. The wrapper's state space is small and its failures are typed conditions needing exact count and delay assertions, so it is enumerated rather than sampled.

**The instrument lesson, recorded because it nearly cost the campaign its evidence.** Wave 1 found the provider matrix was self-referential: it derived its expectations from the code it was testing, so setting `maxRetries: 0` passed the entire matrix. An instrument that cannot fail is not evidence. Every assertion added after that was mutation-checked — red against the unfixed code, green after — and the ones that could not be made red are named as such in the code rather than left to read as coverage.

### Decisions taken by the user, not by §0

- **Live-API tests stay skipped.** The four tests needing `ANTHROPIC_API_KEY` remain skipped; the stub-versus-real reply gap is a named, untested assumption carried into M3.
- **The plugin layer gets a reading review and a manual checklist**, not an automated suite. One exception emerged: `fs-obsidian.ts` only `import type`s from `obsidian`, so its adapter is stubbable, and it now has tests. The other six files remain checklist-only.
- **The §6.5-versus-§11 conflict stands as §6.5 reads it.** A source whose Call A failed still grounds Call B for pages citing it, and those page calls repeat every compile.
- **Orphan-stem stays documented only** — no guarded sweep, no widening of `claimDerivative`. An earlier widening destroyed user data and was reverted.
- **Unguarded IO at the top of the pipeline is deferred to its own milestone.** The index write was carved out and fixed here because its severity was materially worse.
- **Two design re-opens were approved** when the stop-rule fired: the title/alias namespace, and the length rule inside it. The readable/live seam was deferred instead, because re-opening it would have rewritten part of M2d–f and made the intactness check vacuous.

### The stop-rule, and what it actually cost

The rule is: two consecutive rounds whose fixes the next round faults means re-opening the design rather than continuing to patch. It fired, and honouring it was the most valuable thing in the campaign.

Round 1's fixes were faulted by round 2. Round 2's were faulted by round 3. The re-open that followed was faulted by round 4, and that fix was faulted again by round 5. Five rounds on one subject, and the last round's findings were two one-line divergences and a comment that was untrue. What made it converge was not more care; it was noticing that the subject had two rules, and that every fix had been unifying one of them while fragmenting the other.

§4 gives titles and aliases one namespace, and a page's title *is* its filename — so the namespace has two properties that both decide identity: **how two names compare**, and **how long a name may be**. The history:

- Six tables keyed the namespace and only `sanitizeTitle` folded Unicode form, so an NFD title on disk did not match the NFC title a model returned and the second page overwrote the first. That is the data loss the NFC fold had been added to prevent, still open because the fold was applied to the producer of names and not to the namespace they were checked against.
- Closing that with `handleOf` left the length rule where it was: inside `sanitizeTitle`, which §6.5 matches through — so the matching key was lossy and two concepts sharing a long opening merged into one page.
- Moving the bound to `uniqueTitle` closed that and split the stored key from the lookup key: a long title never re-matched the page it had just created, so a new page appeared every compile, for ever, each with its own Call B. Measured thresholds: 201 ASCII characters, 67 CJK, 51 emoji.
- Tagging the cut with a digest of the whole title closed that, and left two sites on half a rule: the tag hashed the unfolded string while `handleOf` folds case, and §4's uniqueness suffix produced a stored name (`X-2`) that no lookup key could reconstruct.

The end state is two named rules, each applied at every site: **`handleOf`** answers how names compare, **`titleStem`** answers how long a name may be, and the lookup inverts the uniqueness suffix, because appending one is part of how a page was named.

The suffix case deserves its own line, because it needs no long title and predates the campaign. §4 requires titles unique across all of `wiki/`, but §6.5 matches only against non-source pages — deliberately, since a source page has no Call B and matching one would strand the citer. So a concept whose name a source page already holds is named `X-2`, and nothing a model returns ever spells `X-2`. A vault with `raw/PageRank.md` whose inventory names the concept `PageRank` produced `PageRank-2`, `-3`, `-4`, `-5` over four compiles, each page keeping a citer so §6.6 never doomed it.

### Fixes — M1 and the shared utilities

- **The frontmatter fence closes only at a line start.** The highest-severity find of the campaign. A `---` accepted mid-line meant `derived-from: raw/notes.pdf---` parsed as a value, so `derivativeOrigin` reported ownership a document did not carry and a user's own file was accepted as Luka's and overwritten. The whole rename subsystem stands on that guard.
- **A document that opens a fence is never given a second one.** Anchoring the close was right in the direction it was aimed — the new pattern is a strict subset of the old, so no document can still claim ownership it lacks — but every shape it began refusing flipped from "left untouched" to "a second block prepended in front of the first": a close written `----`, one indented by a space, one never written. Those are the hand-edits §6.2 invites. Unparseable frontmatter is still frontmatter. This also closed the separately-found case of an unterminated fence gaining a block.
- **`loadManifest` cannot be reparented.** A manifest containing a `__proto__` key with an object value reparented the loaded object. It never polluted global `Object.prototype` and self-healed on the next save, but the fix lands in shared `manifest.ts`, which is what forced the M2d–f intactness re-run.
- **Localizing an image rewrites the link, not the prose.** `full.replace(url, …)` with a *string* pattern takes the first occurrence in the whole match, which is the alt text whenever the alt repeats the URL — a fourth in-place write to prose the user owns, counted as a success so it earned no marker, and because a passthrough's hash is taken after the write the file read as unchanged for ever, making the remote link permanent and orphaning the asset. Now spliced at the offset of the link target. The replacement side had been fixed one round earlier, for `$&` expansion out of the extension; the pattern side stayed open because the comment reasoned only about the half that was closed.
- **The dataset descriptor is bounded.** A 478KB ragged CSV cost 53 seconds holding the global operation lock, because the render is O(columns × rows) independent of cell count.
- **Repo identity is length-framed.** Two different repositories hashed identically, which is a missed modification under §6.2.
- **Repo reads no longer amplify.** Every whitelisted file was read before the size caps applied.

### Fixes — the provider layer

- **A bound written for a notice is not a behavioural input.** Clipping the vendor error message to 500 characters bounded a `Notice` and silently changed behaviour, because §11's temperature re-run decides by regexing that same message. A vendor enumerating unsupported parameters at length pushed the word past the clip, so a model that refuses `temperature` failed every compile instead of degrading — the outcome the entry for that fix said could not happen. `message` stays clipped for display; `vendorMessage` carries the vendor's own text for anything that decides on it.
- **A truncated reply is not a complete one.** `stop_reason: "max_tokens"` was never inspected. A JSON task burned the repair retry and then failed saying the reply was not valid JSON — true, but not the reason. A prose task was worse: the fragment went into `wiki/` under a citation block claiming the full citer set.
- **`Retry-After: 0` falls back to the ladder.** Zero is a value, so it beat the backoff ladder and took the jitter with it, spending the whole retry budget in microseconds against a server that had just said it was rate-limited. Filtered at the parse boundary, not in the wrapper: honouring means using the value, not max()-ing it against the ladder, since a vendor that says 100ms knows something the ladder does not.
- **Bracketed alt text is admitted.** Valid CommonMark link text may contain balanced brackets; excluding `]` to keep alt text on one line had excluded it.
- **Settings are read at call time.** Centralising §17's numeric validation turned two live settings references into snapshots taken at `onload`, which broke invariant 9: a freshly typed API key never arrived, while the settings tab and `data.json` both reported success. Found independently by two reviewers. Settings are read live again and made safe per *run*, which is also the right scope — one consistent state for a compile, not a state frozen at plugin load. The per-run copy has to be deep for `models`, or a keystroke in the model field reaches the vendor mid-run.

### Fixes — page mechanics

- **The title namespace has one spelling rule and one length rule**, as above.
- **An alias belongs to one page.** Resolution and ownership are now two projections of one walk; kept apart they had already drifted, one keyed in path order and one in title order.
- **The index write cannot discard the run.** It happens after the model calls are spent and the pages are on disk but before the manifest commit, so an unguarded throw took the whole run with it, and a persistently unwritable index made that a loop with no way out. Filed under `reported` rather than `failed`, because nothing is owed — the index is re-derived every compile — and because `failed` is rendered to the user as "skipped `<path>`", which `wiki/_index.md` is not.
- **A page names every source the model did not receive in full.** §7.4 truncates the first source rather than dropping it, so it stayed in the packed set while the model saw only part of it — and at a budget too small to hold the marker, none of it. Naming only what was dropped implies the rest arrived whole; with a single citer the page said nothing at all. A source that fitted but has no body gets its own marker, because §4 fixes the budget marker's wording and an empty file under a 40,000-token budget was neither truncated nor over budget.

### Fixes — the plugin surface

- **Deleting goes through Obsidian's trash.** Every delete used `adapter.remove()`, a permanent unlink, while `trashSystem` and `trashLocal` sat unused on the same adapter. What goes through it is cascade-doomed pages — §5's modal calls them pages that *may* be deleted, so the user approves a superset and cannot know which went — and derivatives under `raw/`, including one a user hand-repaired, which §6.2 names as the sanctioned repair path. Not §16's forbidden backup rotation: the platform's own default recovery path, which Luka was opting out of.
- **`mkdir` survives its own race.** Check-then-act with an await between, driven at §6.3's fixed concurrency of four, so on the first compile of a document with two or more kept remote images three calls lose the race and the throw failed the whole source — where §6.3 asks only that the link be left and marked. It also asks `stat` rather than `exists`, because a *file* standing where a folder belongs is "exists".
- **Listing uses core's ordering.** `localeCompare` in the shipped adapter is why three consumers defensively re-sort, and a fourth would not have known to.
- **`FsAdapter.delete` states its contract**: the path ends up free, a host trash is used where there is one, and deleting a missing path may reject — the three implementations disagree, and the two core is tested against are the forgiving ones.

### §15 acceptance: what the criteria did not measure

Nine of twelve M1/M2 criteria were genuinely constrained. Three were not, and each is the shape worth having — a test that passes because it never asked:

- *"modified source reprocesses, and only the pages citing it"* measured the first half and nothing of the second. A regression requeueing all seven entity pages is six extra Call B invocations against invariant 12, and every assertion passed, because the settle-compile at the end regenerates nothing either way.
- `raw/orphan.md`, §6.1's vision-pass derivative, was never asserted to exist. It appeared only as a *value* in the manifest-ownership map, which asserts what the entry says rather than that a file stands there.
- Frontmatter was asserted completely for one file. `derived-from` is the invariant-II ownership guard — a derivative without it is disowned and re-extracts every compile — and three derivatives had no frontmatter assertion at all.

### §0 decisions taken in code and never recorded

Found by a claims-versus-code audit and recorded now rather than changed, except where noted above.

- `MAX_TITLE_BYTES` is 200 **UTF-8 bytes**, not code units, because 255 is a byte limit and 120 code units of CJK is 363 of them. The cut lands on a code-point boundary, because a split surrogate pair encodes as U+FFFD and the name on disk would stop being the title in memory.
- `MAX_COMPILE_CONCURRENCY` is 16. §11 budgets concurrency at 2; a raised value is the user's call, an unbounded one is not, because every extra worker is another request holding the operation lock.
- `MAX_RETRY_BUDGET` is 10 and `MAX_VENDOR_MESSAGE` is 500.
- `MAX_SCHEMA_COLUMNS` is 200, with the measurement above behind it.
- A §17 number that is not finite falls back to §17's default; one with a range is clamped into it. The fallback is the default and not the range floor, because `"compileConcurrency": "4"` — a quoted number, the likeliest hand-edit of all — is not finite, and falling back to the floor would silently answer 1.
- `sanitizeTitle` deliberately exceeds §4: it strips `?*"<>` and C0 controls beyond §4's set, NFC-normalizes, collapses whitespace and trims trailing dots and spaces. Every one is a filesystem refusal §4 does not name, and a title that reaches the write unusable does not cost one page — every source citing it is blocked, so nothing in the run is manifested, and inventory at temperature 0 returns the same title next compile.
- `yaml.ts` appends unknown frontmatter keys alphabetically. §4 fixes the order of the keys it names and is silent on others; alphabetical is what makes annotation byte-stable across runs, which §6.2's hash-after-annotation rule depends on.
- Repo file bytes are decoded with a non-fatal UTF-8 decoder and no round-trip guard, so a Latin-1 source renders with replacement characters. The passthrough path takes the opposite decision for the same hazard and logs it. Recorded, not changed: the mangled derivative is what Call A's prompt is built from, and the repair belongs with the ingest-side round-trip work.
- Dataset column count comes from row 0 only; wider data rows are truncated with no marker, while the 200-column cap in the same module does emit one. Same question, two answers.
- `buildTitleTable` resolves competing *titles* last-wins and competing *aliases* first-wins. Deterministic either way, and previously undocumented in the table that decides every wikilink.
- The Anthropic response concatenates multiple text blocks with no separator, drops non-text blocks, and yields `""` for a reply with no text block. Pinned by tests, so deliberate; now written down.

### Known limitations, accepted (this campaign)

- **Image localization rewrites links inside code fences and HTML comments** in a user's own file.
- **Reference-style `![x][r]` and raw `<img>` are neither fetched nor marked.** The stated rationale covers HTML sources only, not passthrough markdown.
- **A non-round-tripping file is ingested with no marker**, and image localization is skipped on it. Its mojibake is then served to Call B as that source's body.
- **`comparePaths` is UTF-16 code-unit order**, where the docs say code point.
- **`renderCallBPrompt`'s omitted-for-budget line is appended outside the prompt budget** — a 3.5× overshoot measured at a small budget.
- **Fence-blindness in the citation and link post-passes** — bounded and cosmetic.
- **One unreadable file under `wiki/` aborts the compile** with a raw error. Same family as the deferred IO work.
- **A deletion frees a derivative stem before normalization; a rename frees it at the commit point.** A source wanting a stem a rename is vacating waits one extra compile. Reported both times, converges; the churn sweep runs one extra clean compile with this documented in-code.
- **`matchNew`'s `titleStem` candidate cannot currently fire** — `newIndex` already keys the raw title's handle — and is kept for symmetry with `matchExisting`, with a comment saying so. A lookup that differs from its sibling is how this namespace fragmented twice.
- **A source page and a concept of the same name still take two pages**, `X` and `X-2`. That is §4's uniqueness rule working; what was fixed is only that `X-2` is found again instead of spawning `X-3`.
- **A concept whose name is a prefix of a real `Name-<digits>` concept can be merged into it**, when a source page holds the prefix. A vault with `raw/GPT.md` and a concept `GPT-4` merges a later concept `GPT` into `GPT-4` rather than creating a page for it, and there is no frontmatter breadcrumb, because the ownership guard correctly refuses to hand `GPT` out as an alias. This is the cost of §4 storing a title only as a filename: nothing on disk records *why* a title carries `-N`, so a genuine `-4` and a uniqueness `-2` are indistinguishable. Resolving it needs a frontmatter key, which is added scope under §0. The alternative shipped previously was worse — a separate page under a wrong name, proliferating one per compile.
- **The stem's tag folds case; the kept prefix does not.** Two long titles differing only by `İ`/`i̇` or `ẞ`/`ß` have handles §4 calls equal but UTF-8 prefixes of different lengths, so they still take two stems. Every other case pair folds. Strictly better than before, where every case pair of a long title split, and narrow enough to leave.
- **Neither `sanitizeTitle` nor `handleOf` strips a lone surrogate**, so a title carrying one does not survive a disk round trip. Pre-existing and independent of the length rule; it needs a model to emit an unpaired surrogate inside a JSON string.

### Refuted, with one rationale corrected

- **The js-yaml alias bomb is not reachable.** In 5.3.0 `__proto__` becomes an own key and the prototype stays intact; deep nesting throws a catchable exception `parseFrontmatter` already swallows. Kept as a regression-guard oracle, not fixed.
- **`parseRetryAfter` being seconds-only is safe, but the reason written down was wrong.** The 30-second cap only bounds a value that is *honored*; an HTTP-date parses to `undefined` and falls to the ladder, which retries at 750ms — *sooner* than the vendor asked, not later. The conclusion stands; the justification did not, and this is the same shape as two other entries the audit found: a defensible choice resting on a premise that does not hold.

### Deferred to their own milestones

- **Unguarded IO at the top of the pipeline** — `collectSources`, `repointRenames` and `saveManifest` throw past the per-source catch. The index write was carved out and fixed here.
- **The readable/live seam.** `readable`, `bodyOfSource`, `isLive`, `readableFromManifest`, `readablePathFor`, `readablePathOf` and `cascadeScope.live` answer overlapping versions of two questions — is this source live, and where is its markdown — and no two agree at the edges. `hasDerivative` catches an IO error on `derivativeOrigin` optimistically while `readableFromManifest` catches the *same call on the same file* pessimistically. Each carries a well-argued comment defending its local choice and none acknowledges the other, which is exactly why they drifted. Measured: one compile can report a source unreadable and serve its content to the model in the same run, and a run can classify one source three ways.

  Two findings belong to that milestone rather than here. The `UnreadableCiter` branch blocks no citers, so co-citing sources are manifested even though the page their inventory queued was never written; its logged rationale assumes a *permanent* unreadability, but the same branch is reached by a transient one — a locked file, a sync conflict, an un-hydrated cloud placeholder — and there a user's edit is lost permanently and the next compile reports `noop`. The obvious repair is to use `discovery.unreadable` to separate the two cases, and that does not work as built: a derivative under `raw/` is read up to four times per compile, and which read a transient failure lands on decides whether the source is reported unreadable, silently served anyway, or fails the page. Deferred because it spans the M2d–f rename subsystem and the IO work above, and re-opening it inside this campaign would have made the intactness check vacuous.

### M2d–f intactness

Re-verified after every fix landed, because the fixes touched `yaml.ts`, `manifest.ts` and the modules feeding the rename subsystem. All seven M2e invariants hold, and the named mutation checks reproduce at their recorded weights: removing the float branch fails **exactly seven** tests, removing `chooseTarget`'s recorded-path fallback **exactly one**. `CHURN_SEEDS=1500` green in both fault modes; the demo corpus green on a real filesystem with real pdf.js; `FUZZ_SEEDS=800` and `FUZZ_LOCALIZE_SEEDS=800` green. Not one file of `renames.ts`, `discover.ts`, `normalize/index.ts`, `manifest.ts`, `paths.ts` or `hash.ts` changed across the fix range.

## M3 — Retrieval + Ask + Filing

Built against `handoff.md` §7–§8 and §13, with the plan's ordered steps. Two
decisions were taken by the user before any code: the **health check is in M3**
— §5, §8.1 and §10 all specify it while §15 assigns it to no milestone at all,
so it would otherwise never be built — and the **eval fixture vault is
stub-compiled** rather than generated with a live key, so regenerating it is
byte-deterministic and costs nothing.

### The graph (§7.1)

`src/core/graph/build.ts`. Nodes are the page table minus `_`-prefixed
infrastructure (invariant 8) plus every manifest source's readable markdown —
the first consumer of `readablePathOf`, which was put on the façade for exactly
this and had sat unused since M2e. Edges come from `linkTargets` over the
*whole file*: §7.1 names body, citation block and frontmatter `source:`, so
stripping frontmatter first would drop every source page's edge to its own raw
file. Undirected, deduplicated per pair, degree counted from the deduplicated
set. Built in memory only — §7.1 says "no cache file", and a cache would be a
fourth thing that can disagree with the vault.

- **A raw node is its readable markdown, reachable by either name.** The node's
  path is the readable path, but citation blocks and `source:` keys name the
  *manifest* path — the PDF, not the markdown extracted from it. Both names
  resolve to the one node; without that a source page has no edge to the file it
  describes.
- **A pending source is not a node.** `readablePathOf` answers `null` for a
  source whose cascade is still owed, and §7.1's node set is files that exist.
- **A heading or block reference resolves to nothing**, exactly as `resolveLinks`
  treats one. A wiki title can never contain `#` (`sanitizeTitle` strips it), so
  the guard is only reachable through a raw path — where it costs something: a
  source named `C#.md` cannot be linked into. One rule for what `#` means is
  worth more than reaching one awkwardly-named file.
- **A self-link is not an edge**, and a node whose file cannot be read
  contributes no edges but stays a node — the page table and the manifest have
  both already said it is one, and dropping it here would make the node set
  depend on a transient read.
- **`getGraph()` is lazy, cached, and returns a promise**; concurrent callers
  share one build. `onGraphRebuilt` returns an unsubscribe, and fires after the
  load-time build and after every non-cancelled compile — §5's "after compile
  and after load". A declined preview changed nothing, so it rebuilds nothing.

Four mutations were run against the tests before they were trusted: dropping the
manifest-path alias, admitting pending entries, letting heading references
resolve, and removing pair deduplication. The heading-reference test needed
rewriting to be falsifiable at all — the first version asserted a link the
lookup would have missed anyway.

### PPR (§7.2)

`src/core/graph/ppr.ts`, pure and synchronous — it is arithmetic over a
snapshot, and keeping it free of IO is what lets an instrument compare it
against an independent solution of the same equation.

- **Adjacency is built in node order and neighbour lists are sorted**, so every
  sum runs in one fixed sequence. Floating-point addition is not associative;
  this is what makes two runs bit-identical rather than merely close.
- **A degree-0 node is a zero column.** Its mass is not redistributed — it
  leaves — and the node holds only what teleport puts back. Seeded alone, an
  isolated node scores exactly `1−α` and everything else scores zero, which is
  §7.2's sentence made checkable.
- **No valid seed means every score is zero and no iteration runs.** A uniform
  vector would be the other option and it is worse: it ranks every node equally
  and looks like a result.
- **`SNAPSHOT_CAP` is 100, module-local**, per the standing convention for §17's
  fixed parameters. §7.2 bounds retained vectors independently of the iteration
  limit, so a hand-edited `pprMaxIterations` cannot grow the pane's memory.
- **`pprAlpha` falls back rather than clamping.** Outside (0,1) the update stops
  being a contraction — at 1 it never teleports, at 0 it never walks — so
  neither boundary is a usable value to clamp to. `pprMaxIterations` does clamp,
  1..1000; the ceiling only stops a mistyped value from iterating a converged
  vector while holding the lock.

The §14 fixture is solved by hand as a linear system in the test — by symmetry
`v_b = v_c`, giving `v_a = 1380/3131` — and never by running the product. It
agrees with the iteration to 8 decimals; the residual ~1.5e-9 is the L1
tolerance of 1e-8, and that gap is itself the evidence the two derivations
agree. Four mutations turn the tests red: dropping degree normalization,
swapping α and 1−α, letting a degree-0 node retain its own mass, and loosening
convergence by 10⁴.

One test needed rewriting to be honest. The snapshot-cap case first tried to
force more than 100 iterations with α = 0.999999 and got 62: a small dense graph
converges in tens of steps whatever the damping, because the rate is set by the
second eigenvalue and not by α alone. It uses a 60-node chain instead.

### The PPR instrument

`tests/fuzz-ppr.test.ts`, default `PPR_SEEDS=250` and well under a second; 2,000
seeds runs in about half of one.

PPR earns an instrument for the reason churn did: a transposed normalization, α
and 1−α exchanged, or a mishandled zero column all produce numbers that look
entirely plausible, and no hand-written fixture would flag them. The oracle is a
*different algorithm* reaching the same equation — dense Gaussian elimination
solving `(I − αA)v = (1−α)p` directly, written in the test file and sharing no
code with the product. Two routes to one equation is the whole point; an
instrument that derives its expectations from the code it checks cannot notice
that code being wrong, which is what the provider matrix did before Wave 1
caught it.

Beyond agreement to 1e-6 it asserts: no score negative or non-finite; total mass
never above 1; mass conserved *exactly* when the graph has no degree-0 node,
which is the sharpest form of §7.2's zero-column rule; and bitwise-identical
output when the node and edge lists are reversed, since `comparePaths` pins the
arithmetic order and anything less than bitwise equality would be hiding a
reordering.

The generator gives each unordered pair an independent chance, so the sweep
meets isolated nodes, trees, dense clusters and disconnected components without
any of them being constructed on purpose. α is sampled across (0.05, 0.95)
rather than fixed at §17's default.

Mutation-validated before it was trusted, each named in the file header:
row-normalized instead of column-normalized adjacency, α exchanged with 1−α, a
degree-0 node retaining its own mass, and the L1 threshold loosened by 10⁴. All
four turn it red.

### The lexical scorer (§7.4 step 3)

`src/core/retrieve/lexical.ts`. Weights 10/8/4/2/1 are module constants, §17
marking them fixed.

- **The signature takes keywords and nothing else.** §8.2's follow-up round
  scores the model's `missing_information` strings with this same function, and
  there is no question to score against there — a scorer that needed one would
  have to be two scorers.
- **A keyword takes its best tier and only that one.** Adding the tiers a match
  satisfies would let an exact title also collect substring, summary and body
  points for being its own substring, which ranks pages by verbosity rather than
  by match quality.
- **A blank keyword scores nothing.** The empty string is a substring of every
  string; left in, it hands every page the body tier and flattens the ranking.
- **Substring matching runs both directions** — the keyword inside the title and
  the title inside the keyword. §7.4 says "title/alias substring" without naming
  which contains which, and both readings are the same fuzzy-match intent.
- Comparison goes through `handleOf`, so case and Unicode form fold exactly as
  they do everywhere else in §4's namespace.

Six mutations turn the tests red: removing the title-exact, alias-exact or
summary tier; admitting blank keywords; making substring one-directional; and
taking the maximum across keywords rather than the sum.

### The retrieval pipeline (§7.3, §7.4)

`src/core/retrieve/pipeline.ts` and `assemble.ts`.

- **The index text comes from `renderIndex`**, the same renderer that writes
  `wiki/_index.md`. Its doc comment asked for this in M2b: the seed call and the
  file the user reads must never drift apart, so there is one renderer, not two.
- **An invented seed path is dropped, not fatal.** Same treatment Call A gives a
  malformed inventory item, for the same reason: one bad entry should not cost
  the user the whole answer. A reply that is not an object at all still throws —
  that is a broken call, not a bad item.
- **Force-included seeds are additive and uncapped.** §17's caps bound what the
  *model* may return; a page the question names outright is not a guess that
  needs rationing.
- **Mode A keeps a seed no keyword touches, at score 0.** The model chose it
  from the index, which is a judgement the lexical score has no way to express.
  Mode B drops a zero score, because there it means the walk never reached the
  node at all.
- **`modeOf` is inclusive on both thresholds** — §7.3 says "≥ 20 AND … ≥ 1.5" —
  and answers Mode A for an empty vault rather than dividing by zero.
- **Assembly consumes `packUnderBudget` rather than reimplementing §7.4 step 4.**
  Whole nodes in rank order, stop at the first that does not fit, truncate the
  first item rather than dropping it: all three are already that function's
  contract, and §6.5's page assembly shares the definition of "fits" on purpose.
  Only the first node can carry the truncation flag, because nothing else is
  ever split.
- **Reading stops at K, not just packing.** `packUnderBudget` caps the output
  either way, so this is invisible in the result — and without it a large vault
  is read end to end to assemble twelve pages. The test pins the read count, not
  just the node count, because that is the only way the guard can fail.
- A node that cannot be read, or has no body, is skipped rather than failing the
  query: it was ranked from the page table or the manifest, either of which can
  name a file the user has since moved.

Eight mutations turn the tests red, including both mode thresholds made
exclusive, invented paths admitted, a chosen seed dropped, ties left unbroken,
and the truncation flag never set.

### The retrieval trace (§8.3)

`src/core/answer/trace.ts`. §5 names `writeTrace` and `parseTrace` together
because §9's pane replays a trace it did not write, so parsing has to recover
exactly what rendering put down. That is `citations.ts`'s contract, and this
reuses its discipline rather than inventing a second one: fences anchored to a
line start, a required heading, the last block authoritative, every block
stripped so regeneration cannot accumulate them, and a greedy link capture so a
title containing `]` or `|` round-trips.

- **An empty list renders `(none)`**, not an empty line, so a reader can tell
  "nothing was seeded" from "the writer forgot the line".
- **`top:` caps at ten while K is twelve.** §8.3 says so outright; the trace is a
  summary of the ranking, not a second copy of the assembled set.
- **A block whose `mode:` is unreadable yields no trace but is still stripped.**
  Leaving it would let a second accumulate beside it — the failure
  `citations.ts` was written to avoid.
- **The heading requirement protects the user, not the parser.** A filed answer
  note lives under `raw/` and is the user's to edit (§8.4), so `parseTrace` runs
  over text nobody promised Luka wrote. A complete but heading-less fenced pair
  is not this module's block, and recognizing it would strip the user's own
  prose out of their own file.

Six mutations turn the tests red: no ten-entry cap, scores not fixed to four
decimals, first block winning over last, the heading requirement dropped, an
unreadable mode accepted, and a non-greedy top-entry capture.

*(M4 correction: the sixth is not a mutation at all. `parseTop` is anchored with
`^`/`$`, and against those anchors plus a maximal numeric tail, greedy and lazy
are provably equivalent for every string `writeTrace` emits — changing `(.+)` to
`(.+?)` there leaves every trace test green. The anchors do the work the
sentence credits to greediness. Greediness is load-bearing in `parseLinks`,
which has no anchors, and that one is now pinned. This claim was false when
written in M3 and survived seven review rounds before anyone ran it.)*

Two of those needed the tests strengthened before they could fail. The greedy
capture only matters for a label containing `]`, and the first version used one
containing only `|`. The heading requirement is not what stops a stray fence
pairing with the real block — the "no inner fence" rule already does that — so
it needed the case where it is the only thing that matters: a complete fake
block, which without it is stripped as though Luka had written it.

### Synthesis and the answer note (§8.2, §8.3)

`src/core/answer/synthesize.ts`. Invariant 5 draws the line this module keeps:
everything below the answer prose — frontmatter, callout, sources block, trace —
is written by code.

- **Synthesis runs in prose mode, not JSON mode.** §8.2's reply is markdown that
  *ends with* a fenced block; asking the wrapper to parse the whole thing as
  JSON would reject every valid answer. Temperature is left unset, as page
  generation leaves it — §11 fixes temperature 0 for JSON tasks only.
- **Only a fence at the very end is the footer**, and the block's content may not
  itself contain a fence. Without that second rule a lazy match backtracks
  across an earlier code block and swallows everything between it and the
  footer: an answer that opens with an example loses its entire body. A test
  caught this, not review.
- **A missing, unparseable or wrongly-shaped block reads as an empty list**, and
  the block still comes off. The answer is sound either way, and failing the
  query over a malformed footer throws away model calls already paid for.
- **An out-of-set link keeps its display text.** §8.3 says "unlinked to plain
  text plus marker"; using the target instead of the display half would leave
  the sentence reading differently from what the model wrote.
- **The sources block is sorted by path**, so two answers over the same set list
  it identically, and a raw source is named by path while a page is named by
  title — §4's rule for which form a link takes.
- **Timestamps are UTC**, matching `ingested`'s convention: a vault synced
  between zones would otherwise name two notes for the same local minute.
- **An empty slug falls back to "answer".** A question in a non-Latin script
  slugs to nothing; the timestamp already makes the name unique, so the slug
  only has to be a legal, non-empty component.

Nine mutations turn the tests red, including the callout dropped, links left
unvalidated in the note, the marker omitted, display text lost when unlinking,
sources left unsorted, and local time used instead of UTC.

### ask() (§7.4 into §8.3)

`runAsk` in `src/core/index.ts`, under `lock.run("ask", …)` — the
`OperationName` M2 reserved and never used.

- **Atomicity is structural, not defended.** Every model call happens, the whole
  note is rendered into one string, and only then is anything written. There is
  no partial state a failure could leave and nothing to roll back — the same
  single-commit shape as the manifest, which is how invariant 11 is kept rather
  than merely asserted.
- **Two questions in one minute do not collide.** §8.3's path has minute
  precision, so the second answer takes §8.4's suffix idiom rather than
  overwriting the first.
- **`grounded` is `assembly.nodes.length > 0`** — what the model was actually
  given, not what ranking produced. A page that ranked but could not be read
  contributes nothing and must not be claimed.
- **The seed call runs in Mode A too**, per §7.3. Mode A saves no model call;
  the mode governs ranking only.
- **`modelCalls` is a `stats().requests` delta**, compile's convention, so it
  counts transport attempts. Invariant 12's bound is on *logical* calls, and the
  test asserts `byTask` for exactly that reason.

Thirteen assertions, five mutation-checked: ask taken outside the lock, the
collision suffix removed, `grounded` hard-coded true, force-include dropped, and
Mode A left ranking nothing. The lock test drives both directions — an ask
refused during a compile and a compile refused during an ask — and asserts
`BusyError.message` verbatim, since §2 pins that string.

### A process fix, recorded because it hid a broken build

Step 7 was committed with a failing typecheck. The gate command piped each
check through `| tail`, which returns *tail's* exit status, so `npm run build`
failing still reported success and the `&&` chain ran on to `git commit`. Every
gate run in this milestone had the same hole; the earlier steps were green, so
it never showed. Gates now run under `set -o pipefail`, and the step-7 commit
was amended rather than followed by a fix-up.

### The follow-up round (§8.2)

In `runAsk`, and deliberately self-contained: §15's cut-order names this the
third thing to go under schedule pressure, so removing it is deleting one block
rather than unpicking a seam.

- **Lexical in both modes**, per §8.2 — the expansion scores the model's
  `missing_information` strings over wiki pages with the same scorer Mode A
  uses. No second seed call, no second PPR.
- **A second synthesis only runs if something new was appended.** Nothing new
  means the round would ask the same question of the same context and spend
  invariant 12's third call on it. Two ways that happens: the missing strings
  match nothing, or they match pages that turn out to have no text to read.
- **Pages already assembled are excluded from the candidates.** Without that, a
  missing string naming something already in context appends it a second time —
  one page listed twice in `## Sources consulted`, and a model call spent
  re-reading what the model has already seen.
- **`followUpEnabled` takes §17's default for any non-boolean.** A string or a
  number in `data.json` is not a decision either way, so it falls back rather
  than taking JavaScript's idea of whether it is truthy.

Six mutations turn the tests red. Three of them were green at first, and each
exposed a path nothing exercised: the "nothing new" guard was never reached
because the missing string matched no page at all; the already-assembled filter
was never tested with a keyword that actually matches an assembled page
(`ranking` shares no substring with `PageRank`); and the toggle had no
normalization test. All three tests were rewritten rather than accepted.

### Filing (§8.4)

`src/core/answer/fileback.ts`.

- **Nothing teaches compile about answers, and nothing needs to.** §4's
  discovery already walks `raw/` recursively and names `raw/answers/` outright,
  and a `.md` source is passthrough. §8.4's "through the normal path" is a
  statement that no special case exists, and §16 forbids the one anybody would
  be tempted to add — a redundancy gate.
- **The trace goes and the sources block stays.** That asymmetry is the point of
  filing: the trace is this run's working, while the sources block's links
  become real graph edges once the note is compiled (§7.1). Filing densifies
  the graph rather than merely archiving prose.
- **Written before the original is removed.** A failure part-way leaves the
  answer where the user can still see it, rather than between two folders.
- **Only an answer note is filed.** Everything under `raw/` becomes a source on
  the next compile, so filing an arbitrary file is a vault edit nobody asked
  for. The check is `kind: answer` in frontmatter.
- **Outside the operation lock**: no model calls, no compile, and §8.4 ends at a
  notice.

Nine assertions, five mutation-checked: the trace left in, the kind check
removed, the collision suffix removed, the delete moved before the write, and
the suffix applied after the extension rather than to the stem.

### The plugin surface for asking and filing (§8.1)

`src/plugin/ask-modal.ts`, two commands, two methods on `LukaPlugin`. Untested
by the suite, per §14's rule that UI is exercised by the README checklist — the
checklist gained nine M3 items.

- **The modal runs before the lock is taken.** Compile's preview is held under
  the lock deliberately (§8.1) so it cannot go stale; an ask modal is different,
  because the user may leave it open indefinitely and holding the lock across
  that would block compile for no work.
- **An empty question is a cancellation.** There is nothing to retrieve for, and
  a blank query would spend a seed call to learn that.
- **`File this answer` uses `checkCallback`**, so it hides itself rather than
  failing when the active file is not an answer. What makes a file an answer is
  `kind: answer` in its frontmatter, not its folder: a note the user has moved
  is still an answer, and a file that merely sits in `answers/` is not.
- **Two notice strings bypass the `Luka: ` prefix helper**, because the spec
  pins them verbatim — `BusyError.message` for invariant 2, and §8.4's
  "Filed. Run Compile to integrate."
- **A failed ask says only that it failed.** Invariant 11 means nothing was
  written, so there is no partial note to point the user at.

### The settings tab (§12)

`src/plugin/settings.ts` gains §12's retrieval controls: context budget, K, both
mode thresholds, the follow-up toggle, and a collapsed advanced section with α,
maximum iterations, and ε.

- **ε is shown and disabled.** §12 lists it among the controls and §17 marks it
  fixed; showing it because the walk's stopping rule is worth knowing, while
  refusing to edit it, is what satisfies both readings.
- **`details`/`summary` supplies "collapsed"** — the platform's own disclosure
  element, needing no stylesheet, which §3's dependency list leaves us without.
- **A number is written back only when the field parses.** That keeps a
  half-typed value out of `data.json` mid-keystroke; it is a convenience, not
  the guard. The guard is `normalizeSettings`, which is where the rule for a
  hand-edited file lives.

Three README checklist items cover it, per §14.

### The node adapters move to eval/ (§3)

`tests/helpers/nodefs.ts` and `nodehttp.ts` are now `eval/nodefs.ts` and
`eval/nodehttp.ts`, where §3's tree puts them: "eval and tests implement them
over `node:fs` and `fetch`". Both files carried a comment promising this move
once M3 built the harness that needs them; those comments now describe where
they are rather than where they are going.

Moved rather than copied. Two implementations of one adapter is exactly the
divergence `fs-obsidian.ts`'s ordering bug came from, and the tests that use
them import across the boundary instead. `tsconfig.json` and the lint script
now include `eval/`, so the harness is typechecked and linted like everything
else.

### The eval fixture vault (§13)

`eval/fixture-vault/`, committed: 18 hand-written sources under `raw/`, and 44
wiki pages, a manifest and an index produced by running the **real** compile
pipeline over them with a scripted provider and a frozen clock
(`eval/build-fixture.ts`, `npm run eval:fixture`).

- **Compiled, not imitated.** The manifest, the citation blocks and the index
  are structurally exactly what compile writes, because compile wrote them. A
  hand-authored manifest is a second implementation of a format, and the two
  drift.
- **No model call, ever** — not at build time and not at eval time. Rebuilding
  is byte-identical, verified by copying the vault, rebuilding, and diffing.
  That is what lets the fixture be regenerated without moving the floors in
  `queries.yaml`.
- **The manifest sits at the vault root**, not in a plugin folder: §13 wants it
  committed *with* the vault, and the runner passes `manifestPath` explicitly.
- **Mode B is reached with margin.** The first build landed at a ratio of
  exactly 1.50 — passing §7.3's `≥ 1.5` by nothing at all, so any edit to the
  corpus would flip the harness into Mode A and quietly stop measuring what it
  claims to. The link structure was enriched to 1.71, and the guard test
  asserts margin rather than passage.
- **The corpus is shaped, not arbitrary**: two hubs, chains that make a two-hop
  question meaningful, an alias-rich page, and the near-miss pair "Turing
  machine" / "Turing test" that a ranker has to tell apart.

One thing the bundling taught: `import.meta.dirname` is the *output* directory,
because the script is bundled into `.eval-cache/` before it runs. Paths anchor
to `process.cwd()`, which npm scripts set to the package root.

### The eval harness (§13)

`eval/run.ts`, `eval/metrics.ts`, `eval/queries.yaml`, and a fifth CI step.

- **It ranks through the product's own `rankModeA`/`rankModeB`.** An eval that
  reimplements what it measures reports on the copy — the same trap the provider
  matrix fell into when it derived its expectations from the code under test.
- **CI seeding is `forceIncludeSeeds`, verbatim.** §13 asks for "exact
  title/alias match only (no model)", which is the rule §7.4 step 2 already
  applies to every query, so CI measures the product's own seeding minus the
  model rather than a harness-shaped imitation of it.
- **Both modes run every time**, not just the one the fixture's density selects.
  A change that only harms the small-vault path would otherwise hide behind the
  graph one.
- **`eval/metrics.ts` is not in §3's tree.** It exists for the reason
  `pagetable.ts` did: the arithmetic several places depend on gets one home
  where it can be checked against hand-computed numbers, rather than living
  inside a script that has to be executed to be tested.
- **A query expecting nothing scores recall 1**, because there was nothing to
  miss — the alternative lets a malformed entry drag the mean down as though
  ranking had failed. **MRR is uncapped** while the recalls stop at 10, because
  a hit at rank 40 must stay distinguishable from no hit at all: that is what
  separates a regression that demoted a page from one that dropped it.
- **The floor comparison carries 1e-9 of slack.** A floor is a number written
  down from a previous run of the same code, and failing CI on the last bit of a
  float is noise.
- Floors are the first measured means less 0.05. Verified that an inflated floor
  really does exit nonzero, rather than trusting that it would.

**The fixture was silently three pages short.** Two inventory phrases in the
builder had stopped matching because the source text wrapped across a line
(`allocate\nwithout having`), so those sources were inventoried as
"unremarkable" with no items, and the garbage-collection cluster never existed.
Nothing failed: the build succeeded, the eval ran, and two queries simply scored
zero — which a floor set from that run would have enshrined as normal. The
builder now fails loudly when any source matches no phrase, and the corrected
fixture has 47 pages rather than 44.

### §15's M3 acceptance, end to end

`tests/demo-ask.test.ts`, over the corpus §15 names, on a real filesystem with
real pdf.js: compile → ask → the answer's links all validate → file it → the
next compile ingests it and its source page exists → the sources block it kept
is now graph material.

**It found a defect no unit test could have.** An **alias** of a retrieved page
was being unlinked as though it named something outside the retrieved set.
`AssembledNode` carries a title and a path and nothing else, so
`validateAnswerLinks` had no way to know that `[[PPR]]` and
"Personalized PageRank" are one page — and §8.3's rule is that a link *outside
the retrieved set* is unlinked, which an alias of a retrieved page plainly is
not. Resolution now goes through `buildTitleIndex`, the same title table §4
resolves every other link with, so there is one rule for what a handle names
rather than two.

The unit tests could not have caught it: they construct `AssembledNode`s
directly, so the aliases were never in play. It took a real vault, where the
pages have aliases because inventory gave them some.

**One assertion of mine was stricter than the criterion.** The first version
required every link in the prose to appear verbatim in `## Sources consulted`,
which lists pages by title — so a correct alias link failed it. "Inline links
all validate" means each resolves to a page that was retrieved, not that it
spells that page's title; the test resolves through the vault's own title table
now.

### The eval harness's `--live` mode (§13)

One argv branch in `eval/run.ts` and one npm script, kept deliberately small
because §15's cut-order names it the fourth thing to go under schedule pressure.

- **Same metrics, real seed call.** The only difference from CI mode is where
  the seeds come from: `selectSeeds` against a real provider rather than
  `forceIncludeSeeds`. Everything downstream — ranking, scoring, floors — is
  identical, so the two numbers are comparable and the gap between them is
  exactly what the model's seeding is worth.
- **The key comes from `ANTHROPIC_API_KEY` and nowhere else.** Invariant 9 keeps
  it out of the vault; keeping it out of the repo is the same rule one step
  further out. Without one, `--live` exits **2** — distinct from **1**, which
  means a metric came in under its floor, so a CI misconfiguration can never be
  mistaken for a ranking regression.
- **Never in CI**, per §13. The workflow has no reference to it.

Not exercised by the suite: it makes real calls by definition. Its CI-mode twin
covers everything except the seeding source.

### The health check (§10)

`src/core/health.ts`, and the third command. Included in M3 on the user's
decision — §5, §8.1 and §10 all specify it while §15 assigns it to no milestone,
so it would otherwise never have been built.

One vault scan, no model calls, rewritten wholesale. Every section answers a
question that has a different right answer tomorrow, so a merged report would be
half stale, and §16 forbids the LLM-driven alternative outright.

- **Article candidates are ordered by how many pages want them**, not
  alphabetically. §4 calls an unresolved link "a future-article signal, not an
  error", so the section reads as a queue of things worth writing.
- **Resolution goes through `buildTitleIndex`**, so a page reached by an alias
  is not reported as missing — the same table §4 resolves every link with.
- **An age comes from the answer's own `asked` frontmatter**, and reads
  "unknown" when that is missing rather than falling back to a file mtime: §4
  records when the *question* was asked, and a sync or a copy would make the
  filesystem answer a different question.
- **The report is `_`-prefixed**, so invariant 8 keeps it out of its own graph:
  it links to many pages, and as a node those links would be edges and it would
  list itself among the orphans.

Six mutations, five red. The sixth is recorded rather than dressed up: the
`Object.hasOwn` guard on the manifest lookup **cannot currently fire**, because
the `raw/` prefix test runs first and no `Object.prototype` key starts with
`raw/`. It is kept as the right idiom for the question it asks, and the test
beside it now pins the behaviour that actually exists — a citation entry naming
no raw file is ignored — instead of claiming coverage it does not have.

The ordering test also had to be rewritten. Its first version used the names
"Nowhere" and "Rare", where alphabetical order and demand order happen to agree,
so it passed whichever sort was in place.

### The full-scale testing pass

Run before any reviewer, so a wave spends its attention on what the instruments
cannot reach.

| | |
|---|---|
| `CHURN_SEEDS=1500`, both fault modes | green, 31s |
| `FUZZ_SEEDS=1500` | green |
| `FUZZ_LOCALIZE_SEEDS=1500` | green |
| `PPR_SEEDS=2000` | green |
| demo corpus + demo-ask (real fs, real pdf.js) | green |
| `npm run eval` | green |
| Fixture rebuilt and diffed | byte-identical |
| Full suite / build / boundary / lint | 801 passed / 4 skipped, all green |

**M2's named mutation checks still hold at their recorded weights** — removing
the float branch in `renames.ts` fails **exactly 7** tests, and removing
`chooseTarget`'s recorded-path fallback **exactly 1**. M3 added a graph, a
ranker and three new modules on top of the rename subsystem without moving
either number.

Five of M3's own guards were re-checked against the whole suite rather than
their own file, to be sure nothing else silently covers for them: α exchanged
with 1−α (4 red), the graph's manifest-path alias dropped (1), the ungrounded
callout dropped (2), `ask` taken outside the lock (2), and the mode predicate's
node threshold made exclusive (1).

Tree byte-identical afterwards.

### Fixes from the M3 review wave — invariants

Three reviewers took disjoint scopes: §7's mathematics, §8 and the invariants,
and eval honesty. Two died mid-run to API errors and a watchdog stall and were
relaunched narrower; running three sets of gates at once on one machine is what
killed the second, and the lesson is recorded here because the M1/M2 campaign
learned it too and it did not stick.

**Invariant 5 was violated, and this is the review's headline.** A synthesis
reply containing `<!-- sources:start -->…<!-- sources:end -->` survived verbatim
into the note *above* code's real block — two fences, two headings — and the
links inside the forgery that happened to name retrieved pages passed
validation, so it read as authentic. Both blocks then survived filing into
`raw/answers/`, where the fake block's links became real graph edges (§7.1).
Nothing in the codebase parsed, de-duplicated or stripped a sources block, so
nothing downstream could have caught it. An *unterminated* forged trace fence
was worse: `stripTrace` needs a matching end, so §8.4's filing could not remove
that either.

The fix is at the invariant's level rather than the symptom's: code-owned
sentinels are removed from the model's prose before the note is assembled. Only
the sentinel lines go — what the model wrote around them stays, because §4 says
the model writes prose and a heading it chose is prose. What it may not produce
is something that *parses* as a structure code owns.

**A heading reference into a retrieved page was being unlinked and marked.**
`links.ts` guards `#` and `^` in those words — "a place inside a page, not a
page" — and `validateAnswerLinks` had not carried the guard over, so
`[[PageRank#Details]]` lost a correct in-set citation and gained a marker that
was untrue. A link is now judged on the page it points into. A piped link with
an empty display half also falls back to the target, so §8.3's "unlinked to
plain text" leaves a sentence that still reads.

**Invariant 12's number was not the number the invariant is about.**
`stats().requests` and `byTask` both count transport *attempts* — they increment
together inside the retry loop — and there was no logical-call counter anywhere.
Measured: a repaired seed reply plus a follow-up round reported **4**; 503
retries reported **6**. The bound held structurally the whole time, but every
assertion guarding it was green only because `StubProvider` defaults
`maxRetries: 0` and every scripted reply parses. `runAsk` counts logical calls
now, at the three places they are made.

**And the BUILD-NOTES entry for it was false.** It claimed "the test asserts
`byTask` for exactly that reason", of a counter that counts the same attempts
`requests` does. That is precisely the entry-contradicting-the-code shape the
M1/M2 audit was created to find, written here by me. Corrected above.

**The trace named things two ways.** `seeds:` carried vault paths while `top:`
carried labels, where §8.3's example shows both title-shaped and §5 hands the
same block to the pane's replay. Both use §4's link form now: a wiki page by
title, a raw source by path.

Two decorative assertions removed: `expect(modelCalls).toBeLessThanOrEqual(3)`
written directly beneath `expect(modelCalls).toBe(2)` cannot fail, and those
were the only three places invariant 12's bound was written down as a bound.
Three new assertions cover what nothing covered: that the trace's `seeds:` and
`top:` carry the values actually retrieved and ranked with — `seeds: []` and
`score: 0` for every entry both used to pass the entire suite.

### Fixes from the M3 review wave — filing, §7, and five tests that could not fail

**Filing left two copies when the delete failed.** Write-then-delete is the
right order — it never loses the answer — but if the delete failed the note
stood in both places, and the next compile ingested the copy whatever the user
had been told. Retrying then landed at `-2`, so §8.4's collision suffix, which
exists to separate two different answers, silently produced two identical
sources: both manifested, both with a source page, both costing a compile's
calls. The copy is now withdrawn on that path, leaving the vault as it was.
Best effort — if the withdrawal fails too, the original error is still what
surfaces, because that is the one the user can act on.

**An answer is filed once.** `activeAnswerPath` offers the command on any note
whose frontmatter says `kind: answer`, which a *filed* one still does, so filing
a filed answer renamed it `-2`, `-2-2`, … churning the manifest through §6.2's
rename path each time. Refused now.

**The blank-alias filter in the lexical scorer was load-bearing and untested.**
`contains` asks `keyword.includes(name)`, and every string contains `""` — so a
single empty entry in a page's `aliases:` scores *every* keyword at the
substring tier and floats that page to the top of every Mode A ranking. The test
named for it passed a blank *keyword*, which is short-circuited before any alias
is consulted, so it exercised a different guard entirely and passed with the
filter deleted.

**Nothing pinned `comparePaths` against `localeCompare`.** Every fixture path in
M3 — `a`,`b`,`c`,`d`,`e`; `n00`–`n11`; `Alpha`/`Beta` — sorts identically under
both, so the comparator could be swapped at every call site with the suite
green. That is a cross-machine determinism break: collation changes the index
assignment, hence the summation order, hence the low bits of every score, hence
tie-broken ranking — differently on two users' vaults. Pinned now with a fixture
whose paths separate the two orders.

**The neighbour-list sort does not do what its comment claimed.** Summation
order is fixed entirely by the `comparePaths` sort of the node order: the outer
loop walks that index space, and sorting each neighbour list only decides which
distinct slot is written first within one source node, which cannot change any
sum. The sort is kept for legibility; the comment now says what actually holds.

**PPR truncates at §17's own defaults, and said nothing.** At α = 0.85 with a
100-iteration cap, a chain of twelve nodes stops at the limit with the vector
still moving. That is spec-compliant — §7.2 says "max 100" — and the residual is
about 1e-8, but nothing distinguished a settled answer from a truncated one, and
a change that made convergence worse would have been invisible. `PPRResult` now
carries `converged`, and the instrument gained a sweep at the shipped
configuration: a converged answer must sit at the fixed point, a truncated one
need only be honest about being truncated.

**The graph determinism test compared a build against itself.** `loadPageTable`
sorts its own result and manifest keys are sorted before use, so `build.ts` sees
one input order whatever an adapter hands back — the test passed with every sort
in `build.ts` deleted. It asserts the observable guarantee instead: the returned
node and edge lists are in `comparePaths` order, and every edge is
canonicalized.

**`src/core/graph/build.ts` had two literal NUL bytes**, used as the edge-pair
separator. Git classified the file as binary, so no change to it could be
reviewed as a diff. The M1/M2 campaign found exactly this in a test file and
fixed it the same way — an escape is the identical string to the compiler — and
it was reintroduced here in new code.

**S-2's premise was wrong, and the weakness underneath it was real but smaller.**
The finding said the eval cannot catch a PPR regression, evidenced by quartering
the damping factor in `computePPR` and watching `npm run eval` stay green. Both
halves of that inference fail on measurement. Quartering α is not a regression on
this fixture: it *raises* Mode B recall@5 from 0.7604 to 0.8229 and leaves MRR
untouched, so no floor could catch it — a floor only fires downward. And it is
already caught, loudly, by six tests in `ppr.test.ts`/`fuzz-ppr.test.ts`, which
compare `computePPR` against a dense solver at the same α; pinning α is the unit
suite's job, not the eval's. Four mutations that do degrade ranking — α to 0,
teleport dropped, propagation to one neighbour, a single iteration — were all
caught by the existing overall floors.

What is real is dilution. 8 of the 16 queries have every expected page
force-included as a seed by §7.4 step 2, so they score 1.00/1.00/1.000 whatever
the ranker does; §13 says the harness measures ranking, and for those queries it
measures seeding. Averaging them in halves the amplitude of any ranking change:
the one-neighbour mutation moves the overall recall@5 by 0.0625 and the
ranking-only recall@5 by 0.1250, against the same fixed 0.05 margin. So the
harness now reports and floors a second mean over just the queries whose expected
pages were not all seeded — marked `*` in the output — while keeping the overall
numbers unchanged for continuity. The `ranking` floor is required, not optional:
a mode that recorded only the overall floors would skip the new check silently,
which is the failure it exists to prevent.

Read that amplitude paragraph as a claim about *headroom*, not about detection.
The one-neighbour mutation moves the overall recall@5 by 0.0625, which is
already past the 0.05 margin — so the old instrument caught it too, and the
example proves less than it was offered as proving. Across all four degrading
mutations tried, the overall floors caught every one. No regression has been
demonstrated that the subset catches and the overall means miss. What the
subset buys is margin: on that mutation, 0.075 of headroom against the ranking
floor versus 0.0125 against the overall one.

**The fix was a no-op in one direction until the subset size was pinned.**
Mutating `run.ts` so `seeded` is always false widens the subset back to all 16
queries; every ranking floor then measures the overall means, which clear them
comfortably, and the eval stays green. That is the shape this project keeps
hitting — a fix that closes one direction of a two-way defect. `queries.yaml`
now records `rankingQueries: 8` and the harness fails if the measured subset
differs, checked under CI seeding only, since `--live` lets the model add seeds
and legitimately move the count. Both wiring mutations now fail: always-false by
the count, and `every` → `some` by the count and two floors.

**The eval's closing line claimed a floor failure for every failure.** With the
subset-size check added it can now fail without any metric being under a floor,
so the summary says the run did not match what `queries.yaml` records.

### Step 21 — one reviewer over the step-20 diff, and what survived it

**The subset pin closed one direction and left the mirror open — in the file the
fix itself added.** `rankingQueries: 8` was recorded precisely because this
project keeps shipping fixes that no-op in one direction. It catches `run.ts`
computing `seeded` wrongly. It cannot catch `metrics.ts` filtering the wrong way
round, because the fixture splits 8/8 and both halves count 8: inverted, the
ranking means come from the eight force-seeded queries, score a free 1.0000 on
everything, and clear all six floors. `npm run eval` stayed green. The unit
suite did catch it — three assertions in `eval-metrics.test.ts` fail — so the
gate set as a whole was never blind, but the instrument built to measure ranking
was. `summarize` now reports `rankingQueryNames` and `run.ts` cross-checks the
membership against the list it derives itself; the count and the membership
catch different breaks, so both stay.

**`--live` kept floors calibrated from a subset it does not measure.** The
count check was skipped under `--live` on the correct reasoning that a live
model adds seeds and moves the subset — and then the ranking floors, derived
from exactly those 8 CI-seeded queries, were applied anyway. A live model good
enough to name every expected page empties the subset, the means read 0, and
three floors fail while every overall metric is a perfect 1.0000. The realistic
case is worse than the degenerate one: the model seeds the *easy* queries out,
leaving the hardest few averaged against a floor set from all eight. §13 says
`--live` "prints the same metrics", so it now prints them and does not floor
them. `FloorCheck` carries a `scope` for that, rather than the caller matching
on the metric's name.

**A floor that was not a number switched its own check off.** `measured <
undefined - 1e-9` is `measured < NaN`, which is false, so deleting two of the
three numbers under `floors.B.ranking` left the eval green. The object guard
added in step 20 checked that `ranking:` existed, not that it held numbers —
the same half-a-fix shape, one level down, and the outer three floors had it
too. A non-finite floor is now a failure in its own right, reported as `NO
FLOOR` rather than `BELOW FLOOR`, because they are different faults.

**Compile's call counter was never converted, and nothing asserted its half of
invariant 12.** `runAsk` was given a logical-call counter in this milestone
precisely because the ≤ 3 bound could not otherwise be stated. `runCompile` kept
a `stats().requests` delta — transport attempts — and the entry recording that
called it "compile's convention". Invariant 12 bounds compile by the same kind
of number it bounds ask by: "S inventory calls + P page-generation calls (+1
vision call per orphan image)", a function of the worklist. §11's retries and
its one repair are transport, not worklist. Measured on one source whose
inventory needs repairing: S = 1, P = 2, so the invariant's number is 3, and the
delta read 4. The test there asserted `modelCalls === stats().requests`, pinning
the defect rather than the invariant. Compile now counts one call per
`complete()`, through a decorator sitting *above* the wrapper so invariant 10 is
untouched and §11's retries happen inside the call being counted — which also
catches the vision call `normalize` makes, that `index.ts` cannot otherwise see.
The test asserts the invariant's 3, that transport made 4, and that the extra
one is the repair; a second asserts one logical call under three 503 attempts.

Not changed: §15's acceptance criterion is "re-compile makes zero model calls",
and an empty worklist reads 0 on either counter, so that criterion was never
affected either way.

**`converged`'s documentation blamed the wrong variable, in both places it was
written.** Both said a chain of eight or more nodes needs about 118 iterations,
framing truncation as something large graphs do. Node count is not the variable.
Measured at α = 0.85 against a 5000-iteration cap: chains of 2, 3, 8 and 16 and
stars of 3 and 10 all need exactly 118, and all truncate against §7.2's cap of
100. A sparse graph converges at a rate set by α, so a two-page vault truncates
like a sixteen-page one and being small is no protection. The fixture this repo
ships (65 nodes, 118 edges) converges from every single seed in 69–82 — inside
the cap, but by less than a fifth of it, which is the fact worth knowing. The
truncation itself stays on the accepted list; what was wrong was the story told
about it. A test now pins the two-node case beside the twelve-node one.

**A comment claimed a tolerance the code beside it did not use.** The §17-defaults
sweep in `fuzz-ppr.test.ts` said "the tolerance is the spec's own bound rather
than 1e-6" two lines above `worst > 1e-6`. What differs in that sweep is the
configuration, not the tolerance; §7.2's 1e-8 is a bound on the L1 step, not on
the distance to the dense solution.

### Step 21b — the verification round, which faulted the fixes again

Five of the six findings were mine, from the round immediately before. Verified
each before touching anything; all five hold.

**Taking the newline with the sentinel silently dropped its end-of-line anchor.**
`-->[ \t]*\r?$` became `-->[ \t]*\r?\n?`. Both trailing pieces are optional and
the `$` is gone, so the pattern matched a sentinel followed by *anything* on the
same line — which `BLOCK` never treats as a block and which therefore was never
a forgery. Measured: the body `<!-- trace:start --> and <!-- trace:end --> delimit
the trace.` rendered as `and <!-- trace:end --> delimit the trace.` — the
line-initial sentinel deleted along with the sentence's subject, the identical
mid-line one untouched. Inside a fence, `<!-- trace:start -->   <- code writes
this` lost its delimiter and kept the dangling annotation, making the "honest
cost" of fence-blindness larger than the comment beside it claimed, for no parse
safety at all. `(?:\r?\n|$)` takes the newline and keeps the anchor. Two tests
pin it, including the asymmetric one.

**The comment written to correct a false claim about `parseTrace` was itself
false.** It said a forgery "eats whatever sits between it and code's real block".
`parseTrace` accumulates `rest += text.slice(cursor, match.index)`, so text
between two blocks is preserved verbatim — measured, `MIDDLE PROSE KEPT?` between
a forgery and the real block survives. What a forgery actually costs is its own
span, including any prose the model wrote inside it, and an unterminated one is
never matched at all so filing cannot remove it. That second half was right all
along. Third iteration of this docstring; the corrected version states only what
was measured.

**And the `converged` explanation was wrong a second time, in the same shape.**
Step 21 replaced "a chain of eight or more nodes" with "a sparse graph converges
at a rate set by α". Sparsity is not the variable either. At one edge per node
throughout: cycles of 4 and 6 need 118 and truncate; cycles of 3, 5 and 7 settle
in 24, 53 and 73. The variable is **bipartiteness** — a bipartite walk matrix
carries an eigenvalue of −1, so that error component decays at exactly α and no
faster, giving 118 at α = 0.85 whatever the size. Paths, stars and even cycles
are bipartite; the shipped fixture is not, and converges in 69–82. Having now
been wrong twice in prose, the odd/even cycle pair is pinned by a test instead.

**And that was wrong too — the third time at the same docstring.** Bipartiteness
is neither sufficient nor necessary, and both counterexamples were two lines
away from the ones that were run. Odd cycles are not bipartite and truncate as
soon as they are big enough: 3, 5, 7, 9, 11 settle in 24, 53, 73, 87, 96 — a
climb toward the cap, not a plateau — and 13, 31, 51, 101 need 101, 116, 118,
118. So the odd cycles chosen as evidence were simply small enough to settle,
which is the size confound the test was written to disprove. In the other
direction, bipartite graphs converge fast on more than one seed: a 4-chain
seeded at one end truncates, and seeded at all four nodes converges in 22;
`cycle(6)` seeded everywhere converges in 1. Mode B seeds several nodes, so the
converging case is the ordinary one.

**That last sentence was attempt #4, and it is wrong too.** It was written in
the commit that removed attempt #3 and declared no mechanism claimed — three
bullets after the declaration. Seed count predicts nothing: `chain(4)` seeded at
three of its four nodes needs 111 and truncates, `chain(5)` seeded at all five
needs 108, `chain(16)` seeded at eight needs 118. The 22-iteration figure is a
fact about that graph under that seeding, not evidence for a rule, and the test
built to pin it used the same example as the claim — the identical
agreeing-by-construction failure this entry diagnoses two paragraphs down. The
seed-set test now carries the counterexamples, so the wrong reading fails it.

The lesson taken is not "find the right mechanism". Three attempts produced
three confident wrong ones, each surviving because the test was built from the
same examples as the claim. The docstring now records measured numbers and
attaches no mechanism at all, and the tests were rebuilt to discriminate: one
holds density fixed and lets size decide, one holds the graph fixed and lets the
seed set decide. The removed assertion — `cycle(4).edges.length /
cycle(4).nodes.length === 1` — was a fixture self-check that could only fail if
the test file's own helper were edited.

**The `scope` label had no test that could see it inverted.** `scope` is the
whole mechanism that stops `--live` being held to floors calibrated from a
subset it does not measure, and `run.ts` is its only consumer — one CI never
exercises. Its test asserted three `overall` and three `ranking`, a symmetric
count satisfied just as well by every label swapped. Swapping them typechecks,
lints, passes all 23 unit tests and passes `npm run eval`, and would make
`--live` skip the overall floors and enforce the ranking ones. Asserted as a
metric→scope mapping now.

**The floor guard was written one level too shallow for the third time.** Step
20 checked that `ranking:` existed, not that it held numbers. Step 21 checked
the numbers, not that `ranking:` held anything — a bare `ranking:` key parses as
`null`, slipped `=== undefined`, and threw `TypeError: Cannot read properties of
null` mid-run, with mode B never measured. Rather than add a third guard beside
the other two, `validateFloors` now checks the whole shape once when the file is
read, names the offending key, and runs before any mode is measured. That fixes
one of the two `--live` ordering bugs found in the same area outright: the
container guard no longer fails a run for a floor `--live` would not have
applied. It does *not* fix the other. The scope skip still precedes the
non-finite check in `run.ts`, in that order, unchanged — what changed is that
`belowFloor` can no longer be reached from `run.ts` with a non-finite floor, so
the `NO FLOOR:` branch beneath it is now unreachable. It is kept, like
`health.ts`'s `Object.hasOwn` guard, as the correct thing for a function that is
also called directly by its unit tests. Precisely: those tests exercise
`belowFloor`'s `!Number.isFinite` filter, not the `NO FLOOR:` reporting branch
in `run.ts`, which has no coverage at all — nothing imports `run.ts`. Saying it
was removed, when it was only made unreachable, is the kind of claim this log
has already been wrong about three times.

Left open, logged not fixed: `buildTitleTable` (title order, titles-then-aliases
in two passes) and `buildGraph`'s `claim` loop (path order, titles and aliases
interleaved) can disagree on which page owns a contested alias, so §8.3 could
approve a link that §7.1 draws to a page that was never retrieved. `dedup.ts`
enforces one owner per alias at compile time, so a Luka-generated wiki should
not reach that state; it builds its table from non-source pages while both
consumers use the full table, which is where to look first if it ever fires.
Pre-existing, reachable only through a hand-edited vault, and not a property of
the forged-block path it was found beside.

### The stop-rule fired again, and what the re-open found

Two consecutive rounds of fixes were faulted by the round after them, which is
the rule from the M2d–f campaign: re-open the design rather than patch a third
time. Applying the lesson from that campaign — the question is not "should we
stop" but "does this subject have two rules that every fix has been unifying one
of and fragmenting the other" — there was such a subject, and it is the sentinel.

`CODE_OWNED_SENTINEL` (synthesize.ts) and `BLOCK` (trace.ts) both answer *what is
a code-owned sentinel*, from two sides, written separately and maintained by eye.
`BLOCK` demands column 0, single interior spaces, and a paired start/heading/end.
The stripper allows leading whitespace, loose interior spacing, and an unpaired
sentinel. Some of that difference is deliberate — strip defensively, so a
near-miss a parser might one day accept is already gone — but nothing said which
direction the slack was allowed to run, and both drifts went unnoticed:

- The `$` loss made the stripper match lines `BLOCK` would never accept, and it
  deleted prose. Slack in the wrong direction, caught only by a reviewer.
- Nothing at all would have caught the mirror: tightening the stripper so a line
  `BLOCK` *does* parse survives into `raw/answers/`.

Named as a property now, in the comment and pinned by three tests:

1. **Whole lines only.** Whatever the stripper removes, it removes as complete
   lines. `BLOCK` requires a sentinel to be its entire line, so a line with prose
   after one is structure to nobody and cutting it destroys prose for no gain.
2. **Covers the parser.** Every line `BLOCK` accepts as a start or end sentinel
   is removed.
3. **Slack runs one way.** More permissive than the parser about surrounding
   whitespace, never less.

Verified from both sides: dropping the anchor fails four tests including the
property; refusing trailing blanks fails coverage; demanding the parser's exact
spelling fails permissiveness. The two patterns can no longer drift apart
without a test saying so, which is what the earlier rounds were missing — not
more care.

`withoutForgedBlocks` is exported for this, matching `validateAnswerLinks` and
`stripMissingBlock`, which are exported and tested directly for the same reason.

Two standing conventions come out of this milestone's review waves, both earned
the hard way:

- **No causal claim in a comment unless it is measured and pinned by a test
  that could contradict it.** `converged`'s documentation asserted a mechanism
  three times — node count, then sparsity, then bipartiteness — and all three
  were wrong, while the numbers beside them were correct every time. The third
  attempt shipped *with* a test, and the test still did not help: it was built
  from the same examples as the claim, so it agreed by construction. The
  standing rule is therefore stronger than "measure it". Either state measured
  numbers and attach no mechanism, which is what the docstring now does, or
  pin the claim with a case chosen to break it rather than to confirm it.
- **Validate a shape at its boundary, once, not one guard at a time.** The
  floor guard was written three times, each a level deeper — existence, then
  leaf types, then container null — and each round's guard was correct about
  what it checked. `validateFloors` checks the whole shape where the file is
  read. One deliberate gap: an unrecognized mode key is accepted rather than
  refused. A mistyped *real* mode is already caught downstream by `floor ===
  undefined`, so refusing extras would buy nothing, and §0 takes the smaller
  option — but the convention above is stated as "the whole shape", and this is
  the part of the shape it does not check.

### M3 closeout — the review-wave record

Four review waves over the milestone, 28 commits from `f3d6e95`.

| wave | scope | outcome |
|---|---|---|
| step 19 | the M3 build (steps 1–18 + H) | three reviewers, disjoint scope |
| step 20 | fixes for that wave | R1 and R2 batches, then S-2 |
| step 21 | the step-20 diff, one reviewer | 9 confirmed; **faulted the fixes** |
| step 21b | the step-20b diff, one reviewer | 6 confirmed; **faulted them again** → stop-rule |

**S-2's premise did not survive checking, and this is the most useful thing in
the wave.** The finding was that the eval cannot catch a PPR regression,
evidenced by quartering the damping factor and watching CI stay green. Both
halves fail on measurement: quartering α *raises* Mode B recall@5 from 0.7604 to
0.8229, so it is not a regression on this fixture and no floor can fire on it,
and it already fails nine tests — seven in `ppr.test.ts`, two in
`fuzz-ppr.test.ts` — when α is quartered *inside* `computePPR`. Worth separating
the two mutations, because the sentence above ran them together: quartering
`DEFAULT_SETTINGS.pprAlpha` instead, which is what produces the 0.8229 figure,
fails **zero** tests in those two files, since both redeclare `SPEC_ALPHA`
locally rather than reading the setting. The rebuttal stands either way — CI
would not have stayed green — but the count belonged to one mutation and the
recall figure to the other. Four
mutations that do degrade ranking were all caught by the existing overall
floors. The real weakness — dilution, 8 of 16 queries scoring for free — was
worth fixing, but it buys headroom, not detection, and no demonstrated
regression is caught by the subset that the overall means miss.

**Two of step 21's nine confirmed findings were mis-diagnosed, and applying them
would have introduced defects.** Both concerned the synthesize seam. The claim
that a forged block's links become graph edges is false — rendered and filed,
the distinct link targets are exactly code's own, because `validateAnswerLinks`
runs over the whole body first; verified at `30101d7` too, so it was never true.
The claim that the stripper should spare code fences is worse than false: every
consumer downstream is fence-blind, so sparing sentinels hands `stripTrace` a
block to delete at filing, which empties the fence entirely, and sparing links
would let a model smuggle an edge to a never-retrieved page past §8.3. Measured
both ways before deciding.

That is the standing lesson for reading a reviewer: **verify a finding before
acting on it, including — especially — a confident one.** Seven of nine held and
two did not, and the two that did not were argued as fluently as the seven.

**The scoreboard on my own work is worse than on anyone else's.** Of step 21b's
six findings, five were mine from the round immediately before: a regex whose
anchor I dropped while fixing something else, two explanatory comments asserting
mechanisms I had not measured, a test asserting a symmetric count that could not
see its subject inverted, and a guard written one level too shallow. All five
held. The two prose failures are the ones worth remembering, because both were
written *while correcting a false explanation* — the failure mode reproduced
itself inside its own fix twice.

**Evidence set, re-run at HEAD.** Churn 1500 both modes, fuzz-compile 1500,
fuzz-localize 1500, PPR 2000, demo corpus and demo ask: all green. Removing the
float branch in `renames.ts` fails exactly 7; removing `chooseTarget`'s
recorded-path fallback fails exactly 1. Both numbers unchanged from the M1/M2
campaign, which is the strongest available statement that M3 left the rename
subsystem intact. 841 passed, 4 skipped; build, boundary, lint and eval green.

### Step 21d — the final check, which faulted it again

Four consecutive rounds of fixes, four rounds faulted. The subject was the same
every time: a causal claim about PPR convergence in a docstring, and a test
built from the same examples as the claim.

**Attempt #4 was written inside the commit that banned attempts.** "Mode B seeds
several nodes, so this is the normal case" appeared three bullets below "No
mechanism is claimed here, deliberately". Falsified by the helper the test
itself uses: `chain(4)` seeded at three of four needs 111, `chain(5)` seeded at
all five needs 108, `chain(16)` seeded at eight needs 118. The docstring now
records measurements with no rule attached, states plainly which of its numbers
are pinned by tests and which are only measurements, and the seed-set test
carries the counterexamples so the wrong reading fails it.

**Two retracted claims were left standing elsewhere in the file.** Attempt #3
survived verbatim in `cycle`'s helper docstring, 220 lines above the assertion
that disproves it, and attempt #2's sparsity claim survived in the comment on
the truncation test. Removing a claim from the place it was challenged is not
removing it; both are gone.

**The `citations` family is reverted.** It was added on the reasoning that §8.4
files an answer into `raw/answers/`, where the next compile reads it, so a
forged `citations:` block reaches `parseCitationBlock`. It does not: all three
call sites iterate the wiki page table, and `loadPageTable` seeds its walk with
`wiki/` alone. With no parse harm to avoid, the strip was pure cost — every wiki
page carries a citation block, so an answer quoting one would silently lose two
lines. A fix whose rationale is false is a fix that should not ship, even when
the diff is defensible on other grounds.

**And the count in this log was stale by one commit.** "Fails eight tests, six
in `ppr.test.ts`" was measured before the same commit split that file's cycle
test in two; it is nine and seven. Fifth wrong number here, and the first caused
by editing prose and code together without re-measuring the prose.

The pattern is now specific enough to name: **prose about mechanism is where
this project's defects live, not the code.** Every one of the four rounds
shipped correct numbers and correct behaviour beside a wrong explanation, and
each round's test agreed with its explanation because it was built from the same
example. The standing rule at the end of this section is written accordingly —
a claim needs a case chosen to break it, or it needs to not be a claim.

## M4 — Graph pane

§15: "Everything in §9 except the scrubber." §14 puts the pane itself under a README
manual checklist rather than automated tests, so the testable work is the core
surface the pane consumes — and that is where the §0 decisions below concentrate.

**A graph node carries its page's summary.** §9's hover tooltip is "title, kind,
summary", and the pane has no `FsAdapter`: it holds a `GraphSnapshot` and nothing
else. Reading frontmatter at hover time would mean either handing the view an
adapter or duplicating §4's parser in the plugin, and both cross the seam §3 draws.
`GraphNode` gains `summary`, filled from the `PageMeta` `loadPageTable` already
parsed — no new parsing anywhere.

- **S1** — a raw source node carries `summary: ""`. It is a file, not a §4 page, so
  there is no frontmatter to read one from, and deriving one from the body would be
  a model call §9 does not permit the pane to make.

**Trace labels resolve back onto graph nodes.** §9's replay reads a trace the pane
did not write, against whatever graph exists when it runs rather than the one the
answer saw. `labelFor` renders §4's link form — a wiki page by title, anything else
by path — so `resolveTraceNodes` reverses exactly that, and the two are written far
enough apart that only running the pipeline proves they still agree. The end-to-end
assertion does that: compile, ask, parse the note's own trace, resolve against the
real graph, expect no unresolved labels.

- **S5** — resolution is exact node path first, then title through `handleOf`. The
  path is the unambiguous name, and a raw node's title is its basename, so
  `raw/paper.md` is both; the path wins. `handleOf` is §4's own normalization, so a
  trace written before a title's case changed still lands.
- **S5b** — a label matching neither is counted in `unresolved`, not dropped. The
  pane replays against the current graph and a page deleted since the answer was
  written is ordinary; lighting fewer nodes than the note lists without saying so is
  the failure this prevents.

**`Core.inspect` runs §7.4 steps 1–3 and stops.** §9's button is labeled "Inspect
(1 model call)", which is a promise, and nothing on §5's contract could keep it:
`ask` runs steps 1–5 and writes a note. The first three stanzas are `runAsk`'s in
the same order reading the same settings, so the overlay shows what an ask *would*
retrieve rather than an approximation of it.

- **S2** — §5's contract gains `inspect`, plus `resolveTraceNodes`, `modeOf` and the
  `RankedNode`/`InspectResult`/`ResolvedTrace` types. §5 lists a contract without
  saying it is closed; the pane needs these and duplicating any of them in the
  plugin would put a second copy of a §7 rule outside the boundary check.
- **S3** — `inspect` takes no lock. It writes nothing, and §9 says the pane is never
  blocked by the lock. Pinned by a test that parks a compile on its first model call
  and inspects while `busyWith === "compile"`.
- **S4** — it ranks over the snapshot it is handed, not a fresh build. §9 has the
  pane render the last-built snapshot, and an overlay ranked over a graph the user
  cannot see would light nodes that are not on screen.
- **S4b** — stopping after ranking is what makes the label true. Assembly reads every
  candidate page to fill a context budget nothing here spends, and step 5's
  ungrounded branch is a property of an answer, not of a ranking.

**The pane's shell, and the two notes it corrected.** §9's view registers as
`luka-graph`, opens from §8.1's command and from the one ribbon icon §8.1 allows,
and renders the last-built snapshot. §14 puts everything below the façade under
the README checklist, so this step's evidence is seven checklist items rather than
assertions.

- **S15** — the pane does not call `previewCompile`. Two M2d entries predicted it
  would and placed the tolerance for its looseness there. §9 never asks for a diff:
  its states are the Mode-A banner and the empty-vault pointer, both answerable
  from `getGraph()` alone, and §0 forbids resolving that silence by adding a
  consumer. Both entries are corrected in place; the tolerance is still unowned,
  which is the honest state rather than the predicted one.
- **S21** — a `getGraph()` rejection becomes a notice and the empty state. One
  unreadable file under `wiki/` is enough to reject it, which is the deferred
  compile-side IO gap and stays deferred; what the pane owes is to say so rather
  than render a blank surface. The alternative — letting it throw into Obsidian's
  event loop — reports nothing to the user at all.
- **S22** — "Open graph" reveals an existing pane rather than opening a second.
  §9 describes one view of one snapshot, and a second copy would be a second
  simulation over the same data on a button users press more than once.
- **S23** — `styles.css` is layout only, and `install:vault` now copies it.
  Obsidian loads it from the plugin directory on its own, so it has to travel with
  the build; every colour is still sampled from CSS variables at render time, which
  is what §15's theme-switch criterion needs.

**The graph appears and settles.** Plan steps 5 and 6 landed as one commit: a
simulation with nothing drawing it and a renderer with nothing positioned are each
half a subject, and splitting them would have meant a commit whose behaviour no
checklist item could observe.

- **S7** — initial positions come from FNV-1a over the node path, module-local in
  `sim.ts`. §9 asks for positions "seeded by hashing page path" so a reopened pane
  starts from the same shape; `core/hash.ts` is SHA-256 and async, and a layout seed
  needs neither cryptographic strength nor a promise the first frame would wait on.
  The high and low halves of the hash drive radius and angle separately, with a
  square root on the radius so points spread over the disc instead of crowding its
  centre.
- **S8** — force parameters (link distance 60, charge −160, centre 0.05, collide
  radius 14, alphaMin at d3's own 0.001, drag target 0.3, reheat 0.3) are
  module-local constants. §17 names none of them.
- **S9** — render constants: `RADIUS_BASE` 3 and `RADIUS_SCALE` 2.6 over §9's
  log(degree+1), `EDGE_ALPHA` 0.25, `LABEL_OFFSET` 4. `LABEL_LIMIT` 10 and
  `LABEL_DROP_THRESHOLD` 500 are §9's own figures, not choices.
- **S24** — every frame is scheduled, and at most one is ever outstanding. There is
  no standing `requestAnimationFrame` chain: a tick storm, a resize and a theme
  change together cost one paint, and when the simulation cools past `alphaMin` no
  ticks arrive and nothing schedules anything. That is what makes §9's sanctioned
  loop end rather than idle forever, which invariant 1 would not permit.
- **S25** — the theme is sampled per redraw rather than cached at open, and
  `css-change` schedules a repaint and no data work. §15's dark/light criterion
  asks for the switch to be picked up without reopening the pane.
- **S26** — a refresh keeps surviving nodes at their current positions and their
  pins, hash-seeding only the new ones. Re-hashing everything on each compile would
  discard the arrangement the user has been reading.

**The pane's pure halves are tested after all.** §14 puts "UI" under a manual
checklist, and the `ItemView` genuinely is manual — lifecycle, canvas painting and
CSS-variable sampling need a host. But `sim.ts` and `render.ts` were written with
no Obsidian import and no DOM access so the view could be read for lifecycle and
they could be read for behaviour, and what is readable in isolation is testable in
isolation. §14 names a *minimum* set for `src/core`; it does not forbid covering
pure plugin modules, and the boundary check scans `src/core` only.

The camera transform earned it. Every §9 interaction resolves a pointer through
`hitTest`, which reverses `draw`'s own `toScreen` — so if the two ever disagree,
hover, drag, double-click and every overlay pick the wrong node together, and
nothing else in the milestone would have caught it.

**Two of the first ten assertions did not test what they claimed**, both found by
mutation and both fixed:

- Making the seed radius constant — every node on one ring instead of spread over
  a disc — passed all twenty. "Separates different paths" was satisfied by distinct
  *angles* alone. Now pinned by comparing the spread of radii.
- "Keeps a surviving node where it was, and its pin" set `x`/`y` *and* `fx`/`fy` on
  the same node. d3 copies a pin into `x` on every `nodes()` call, so the pin was
  answering the position assertion and re-seeding survivors passed clean. Split
  into two tests: an unpinned survivor for position, a pinned one for the pin.

A third finding was the harness, not the code: the first mutation batch restored
only the file it had mutated, so an earlier render mutation persisted into the sim
runs and showed up as four phantom failures. Worth recording because the phantom
looked exactly like a real cross-module coupling, and the fix was to re-run rather
than to explain it.

**§9's interactions, all resolved through one transform.** Pan, zoom, hover, drag
and double-click each turn a pointer position into a node or a graph coordinate,
and every one of them goes through `render.ts` — `hitTest` for what is under the
cursor, `toGraph` for where a drag is putting something. The inverse lives beside
the forward transform rather than in the view, because a second copy of the
arithmetic is a copy that can drift from the one the drawing uses.

`paint` now builds its frame from the same `currentFrame()` the hit tests read, so
what is drawn and what a pointer resolves against cannot be two different things.

- **S27** — interaction constants (`ZOOM_SENSITIVITY` 0.002, scale clamped to
  0.15–6, `TOOLTIP_OFFSET` 12) are module-local. §9 and §17 fix none of them.
- **S28** — the tooltip is a DOM element rather than canvas text: it themes itself
  from the same variables the rest of the pane uses, wraps without measuring, and
  needs no hit-testing of its own. Its content comes from the node — §9's "title,
  kind, summary" — so hovering costs no vault read. A raw source has no summary and
  the row is omitted rather than rendered blank.
- **S29** — double-click opens in the active leaf. §8.3 asks for a new leaf, and
  only for answer notes; §9 says only "opens the page".
- **S30** — listeners are registered through `registerDomEvent`, so Obsidian
  detaches them with the view. Invariant 1 leaves nothing listening after
  `onClose`, and the drag and pan state is cleared there too.

The inverse transform is mutation-validated in both the ways it can plausibly be
written wrong — offset applied in the wrong order, and multiplying where it should
divide — and each fails both the round-trip and the zoom-about-cursor assertions.

**§9's overlay: one shape, three producers.** Click-PPR, query inspection and trace
replay light the graph from different data for different reasons, but §9 describes
one visual language for all three — ring, stroke, ramp, dim. They converge on one
model in `overlay.ts` rather than each teaching the renderer a new vocabulary.

- **S31** — `scores: null` is a distinct state from an empty map. §9 gives Mode-A
  inspection "seeds and lexical top-K without a PPR heat ramp"; an empty map is
  still a ramp, just one painting every node at zero.
- **S32** — the ramp is normalized against the strongest node. PPR scores on a real
  graph are small absolute numbers and a ramp keyed to raw values is flat
  everywhere; relative is also the honest reading, since the overlay answers "what
  did this reach" rather than "how much mass".
- **S33** — filter and overlay dim independently and compose by multiplication. §9
  describes them as separate controls, so a node outside both is dimmer than one
  outside either. A minimum would make whichever was applied second invisible.
- **S34** — a press that travels more than four pixels is a drag, not a click. §9
  gives the two gestures different jobs on the same button, and without a distance
  test every drag-to-pin would also re-run PPR.
- **S35** — `DIM_OPACITY` 0.15, `TOP_K_STROKE` 2, `SEED_RING_WIDTH` 2,
  `SEED_RING_GAP` 3, `CLICK_SLOP` 4: module-local, none named by §9 or §17.
- **S36** — top-K stroke uses §17's existing `assemblyCap`. M4 introduces no
  tunable, and `normalizeSettings` is now on the façade so the pane reads the same
  clamped value an operation would.

**A dead guard that claimed to prevent a division.** `normalize` opened with
`if (peak <= 0) return out`, commented as the divide-by-zero protection. Removing
it left all 36 assertions green, because the `value > 0` filter is what actually
prevents the division: if no score is positive then the peak is not positive
either, and nothing enters the loop body. Found by mutation, not by reading. The
comment now describes what does the work, and two assertions pin the reachable
cases — an isolated seed holding only teleport mass (§7.2), and the negative score
a hand-edited trace can carry, since `parseTop` accepts `-0.5`.

**Trace replay, from the note the user is looking at.** §9 gives this a command
and a button, both gated on an active answer note, and both reach one method on
the view so the two entry points cannot drift.

- **S37** — the pane takes a `GraphHost` — `activeAnswerPath` and `readNote` — 
  rather than the plugin. `main.ts` imports the view, so importing it back would
  be a cycle, and the pane holds no `FsAdapter` by design: reading a note goes
  through the host, which is the plugin's vault API.
- **S38** — the replay button's visibility follows `active-leaf-change`. That is a
  workspace event rather than a vault one and runs no operation, so invariant 1's
  "no watchers" is untouched; §16's non-goal is auto-compile on vault events.
- **S39** — a note with no trace block gets a notice, not an error. §9 asks for it
  to be graceful, and the case is ordinary: a user deleted the block, or the
  answer predates the trace.
- **S40** — replay overlays recorded data and never re-ranks. §9 gives it zero
  model calls, and the graph on screen may not be the graph the answer was written
  against — re-running PPR would show what retrieval *would* reach now, which is a
  different claim from the one the note is making.

**The maturity banner asks the predicate rather than restating it.** §9's banner
reports which mode a query would get, so it calls `modeOf` on the façade with the
plugin's live settings. Writing "≥ 20 nodes and ≥ 1.5 pairs per node" a second
time in the view would be a copy that can disagree with the one retrieval uses,
and the disagreement would be invisible — the banner would simply be wrong about
the thing it exists to report.

- **S41** — the banner and the empty-vault pointer are exclusive. §9 gives an
  empty vault a pointer at Compile; telling it its link ratio instead would be
  answering a question nobody asked.
- **S42** — the counts after §9's fixed string are node count, link pairs and the
  ratio to two decimals. §9 says "with live counts" without naming them; these are
  the three the predicate is computed from, so a user can see how far off the
  threshold the vault is rather than only that it is.

**PNG export goes to the OS, not the vault.** §9 asks for an export button and
says nothing about where the file lands. A vault write would put a binary the user
did not ask for inside the tree compile walks, so §0 takes the smaller option: a
blob URL and an anchor download, revoked immediately after the click.

- **S43** — the export re-renders at `PNG_SCALE` (2) rather than lifting the
  on-screen canvas, so the file does not inherit whatever pixel ratio the display
  happened to have. Same frame otherwise, so the camera and any active overlay are
  what the user is looking at.
- **S44** — the filename is `luka-graph-<YYYY-MM-DD-HHmm>.png` in UTC, following
  `answerNotePath`'s convention for the same reason: a vault synced between zones
  should not name two exports by the same local minute.

**Query inspection, the milestone's designated cut seam.** §15's cut-order names
this the first M4 feature to drop under pressure, so it went in last and depends on
nothing: dropping it is deleting this commit and step 3's `Core.inspect`, and
click-PPR and trace replay carry on unchanged.

- **S45** — the button label is §9's string verbatim, and it is a claim about cost
  rather than a name. `Core.inspect` keeps it by running §7.4 steps 1–3 and
  stopping; the assertion that it makes exactly one seed-selection call and zero of
  everything else is what holds the label honest.
- **S46** — the button is disabled while the call is in flight. §16 rules out
  session state, so there is no queue and no history: a second press before the
  first returns would be a second call the label did not promise.
- **S47** — a failed inspection leaves the previous overlay alone. Clearing it
  would discard what the user was looking at in exchange for nothing.
- **S48** — a question that reaches nothing gets a notice rather than a silently
  empty overlay, which is indistinguishable from the overlay having failed to draw.

### Known limitations, accepted (M4)

- **A page whose title contains a comma cannot be replayed from a trace.**
  §8.3 renders `seeds:` and `top:` as comma-separated lists of `[[label]]`, and
  `,` is not in `pagetable.ts`'s FORBIDDEN set — so `Newton, Isaac` is a legal
  title and `[[a]], [[b]]` is genuinely ambiguous: one label `a]], [[b`, or two.
  No parser over that grammar is correct for every input, which is why three
  successive attempts each fixed one side by breaking the other.

  The parser splits on the comma, which loses a comma-bearing label. The
  alternative — matching brackets lazily — instead truncates raw paths carrying
  `]]` *and* fabricates a score for them, and a wrong number drawn on the heat
  ramp as though it were measured is worse than a missing entry. Neither
  reading is safe on a label carrying *both*: a raw path like
  `raw/[[Fig]] x, y.md` is truncated to `raw/[[Fig` by the split parser too, and
  silently. The split narrows the corrupting class; it does not empty it.

  What is not accepted is losing it silently. `Trace.unparsed` carries the
  fragments the split leaves behind, and `resolveTraceNodes` folds them into the
  count §9's replay reports, so a note listing three seeds and lighting two says
  so. The residue — recovering the label itself — needs `writeTrace` to emit an
  unambiguous grammar, which is a §8.3 format decision rather than a parser one.

### Step 13 — the full-scale testing pass

Instruments at review scale, all green: churn 1500 in both fault modes (26.5s),
fuzz-compile 1500, fuzz-localize 1500, fuzz-ppr 2000. `npm run eval` green against
its floors. Suite 893 passed / 4 skipped.

**The M1/M2 evidence set holds after M4.** Removing the float branch in
`renames.ts` fails **exactly 7**; removing `chooseTarget`'s recorded-path fallback
fails **exactly 1**. Both restored, tree clean. That is the strongest available
statement that the rename subsystem is untouched by this milestone — M4 changed
`GraphNode`, which `buildGraph` fills from the page table the rename path also
feeds, so the counts moving would have meant a coupling nobody intended.

**All 28 new assertions re-validated by mutation, each against the code it is
about.** *(Corrected: this was false. Two of the listed mutations do not fail —
moving `LABEL_DROP_THRESHOLD` from 500 down to 400 or 51 passed everything,
because the label tests used 50 and 500 nodes and nothing between, so any
threshold in that range was green and a build dropping labels at 60 would have
shipped. The normalization assertion used a fixture whose peak was already 1,
making `value / peak` the identity. Both are fixed and pinned from both sides
now; the sentence stood uncorrected through the commit that announced it.)* Steps 1–3: hardcoded summary, title-as-summary, dropped title fallback,
dropped path match, leaked unresolved, dropped force-include union, Mode-A ranked
by the graph ranker, injected vault write. The pane's pure modules: forward
transform ignoring the camera, hit test picking the first rather than the topmost,
inverse with the offset in the wrong order, linear radius, label limit and drop
threshold moved, hovered label dropped, constant seed radius, absent seed position,
refresh re-seeding survivors, refresh dropping pins, path-blind hash, Mode-A given
a ramp, unnormalized ramp, negative scores admitted, unbroken top-K ties, zero-score
counted as lit, case-sensitive filter, dims taking a minimum, filter ignored in
opacity. Every one failed and every one failed its own tests.

**Timing evidence for §15's "opens under 1s".** Measured headlessly on the shipped
65-node / 118-edge fixture vault, ten runs after a warm-up: `buildGraph` 121.8 /
130.9 / 144.6 ms (min / median / max), and `computePPR` from every one of the 65
single seeds at 0.8 / 1.7 / 10.5 ms. Numbers only — no rule is attached, and they
are not a claim about the demo vault, a different machine, or the paint that
follows. What they bound is the part §15's criterion depends on that can be
measured without a host; the criterion itself is a stopwatch item on the README
checklist.

### M4 closeout — the review-wave record

Seventeen commits from `3ac1d40`. Twelve build steps, one testing pass, four
review waves, four fix rounds. 910 passed / 4 skipped; build, boundary, lint and
eval green.

| wave | scope | outcome |
|---|---|---|
| step 14 | the whole milestone, three reviewers, disjoint scopes | 25 findings |
| step 16 | the step-15 fix diff | 8 findings, 4 of 9 fixes wrong |
| step 16b | the step-16 fix diff | 10 findings, stop-rule fired |
| step 16c | the step-16b fix diff | 4 findings, no test defect |

**The stop-rule fired and was answered by a decision, not a patch.** Three
consecutive fix rounds were faulted. The subject each time was the trace list
parser, and the third review named why: `writeTrace` emits a comma-separated
list of `[[label]]` in which both the delimiter and the brackets are legal label
content, so `[[a]], [[b]]` is ambiguous and no parser over that grammar is
correct for every input. Three attempts each closed one side by opening the
other. The user's decision was to revert to the reading that fails on the rarer
input, record the limitation, and stop — which is what the register above holds.

**Findings by wave: 25 → 8 → 10 → 4.** The last wave found no self-satisfying
assertion, the first round in two milestones where that was true.

**Nine self-satisfying assertions were found across M3 and M4**, four of them in
tests written as the fix for an earlier one. Every single one was caught by
mutating the code the assertion covered, and none by reading. The recurring
shape is specific enough to name: the test gets built from the same example that
motivated the fix, so it confirms the fix rather than discriminating against its
absence. The examples that catch it are the ones chosen to break the claim — a
lit set larger than the slice limit, a peak that is not already 1, two lost
labels rather than one, a label ending in a digit.

**Eight false claims were found in this log and in code comments**, including
one that survived seven review rounds before anyone executed it (a `parseTop`
greediness mutation that is a no-op, because the anchors do that work), and two
corrections that were themselves wrong. Prose about mechanism remains where this
project's defects live; the numbers and the behaviour have been consistently
sound beside them.

**The M1/M2 evidence set holds at closeout.** Removing the float branch in
`renames.ts` fails exactly 7; removing `chooseTarget`'s recorded-path fallback
fails exactly 1. Instruments at review scale: churn 1500 both fault modes,
fuzz-compile 1500, fuzz-localize 1500, fuzz-ppr 2000, demo corpus and demo ask —
all green.

**What §14 leaves to the user:** 36 README checklist items for §9's pane, of
which one needs a real API key (the Inspect call count). The pane's pure halves
— `sim.ts`, `render.ts`, `overlay.ts` — carry 43 automated assertions the plan
did not expect to exist, because both were written with no Obsidian import and
what is readable in isolation is testable in isolation.

## What to add next — user-directed (2026-09-04 / 2026-09-05)

§15 assigns no milestone to a recommendation surface and §9 describes no second
pane, so nothing here follows from the spec being silent — §0 forbids reading
silence as permission. It is the user's decision, taken after a viability
assessment against the code as built, the way the health check was "included in
M3 on the user's decision".

**The section lives in the answer, not in a pane (2026-09-05).** The first
build was a vault-wide pane of recommendation cards. A whole-branch review of
it — three lanes over two scopes, six reviewers — returned 34 findings, and
reading them the user changed the execution rather than the idea: a pane
recommends against the whole vault, which spends its five slots on material
nobody has ever asked about. The recommendation belongs where the question is.
So the pane commit is reverted here, and the idea returns in the last commit of
this branch as `## Add next`, a code-written section inside each answer note
naming what would have strengthened *that* answer. Its decisions are W24
onward.

Commits 1–3 stay and are reused: the `missing:` key is half the signal, the
shared page scan is the other half, and the Refresh force path was always an
independent fix. Their review findings are fixed in the two commits after this
one, and the core only the pane used is trimmed there too, where W6–W12 are
struck. W1–W14 below stand as written except where a later line corrects them.
Built on branch `claude/what-to-add-next`, core first. Decisions in commit
order.

**Answer notes persist what synthesis said was missing.** §4 lists an answer's
frontmatter as exact keys — kind, question, asked, mode, grounded — and §8.2's
`missing_information` list was read once, used as the follow-up round's
keywords, and dropped. It is now written as `missing:` after `grounded`. This
is a §4 deviation and the user approved it as one.

- **W1** — items are flattened to one line and stripped of `[[`/`]]` before
  they are written. The flattening is `inventory.ts`'s existing rule for a
  model-written summary; the brackets are this key's own problem, because
  `buildGraph` scans a node's whole file for links including frontmatter, so a
  filed answer carrying `[[X]]` in this list would manufacture an edge the
  model chose. (Corrected 2026-09-05: this first claimed such an item could
  also become an article candidate in §10. It cannot — candidates are read off
  the wiki page table, which `loadPageTable` seeds with `wiki/` alone, and a
  filed answer lives under `raw/`. The edge is real; the candidate was not.
  Corrected too: the strip runs to a fixpoint, because one pass turns
  `[]][X][[]` into `[[X]]` — a link the strip manufactured itself.)
- **W2** — the list persisted is the *last* synthesis's, not the first's. The
  follow-up round is the wiki's own attempt to close the gap, so what is still
  reported after it is what the wiki could not answer. When no second round
  runs, the last reply is the first one and the rule is the same sentence.
- **W3** — the key is omitted entirely when the list is empty. An answer that
  lacked nothing should carry no key saying so.
- **W4** — the "open question" card type this data would feed is **deferred**;
  the user chose to ship the two structural signals. The key lands now anyway,
  so notes written from today accumulate the evidence a later decision needs.
  Nothing reads it yet, and that is deliberate: today every vault has zero of
  these, so a card type built on it would have had nothing to show.

**One page scan serves both reports.** `articleCandidates` read every page and
grouped unresolved targets inside `health.ts`, privately; `danglingCitations`
opened every page again for the citation blocks. The gap report needs the same
two facts about the same pages, and a second implementation of "does this link
resolve" is a second answer that can disagree with §10's. `scanPages`,
`unresolvedTargets` now live in `src/core/gaps.ts`, and the answer note's
`## Add next` section resolves against the same pair.

(Corrected 2026-09-05: this first said §10 "literally does the one vault scan
its own sentence claims". It does not — the page table and the graph build read
every page on their own account, so the report still opens each one four times.
What the extraction removed was one of those, and the two link-reading sections
now share a scan. The narrower claim is the true one, and the comment in
`health.ts` says so too.)

- **W5** — grouping moved from the raw target string to `handleOf`, so
  `[[Zeppelin]]` and `[[zeppelin]]` are one candidate rather than two wanted
  once each. §4's namespace folds case, so the vault could never hold both.
  The spelling shown is the `comparePaths`-minimum variant seen, which puts a
  capitalized form first. This is the one visible change to §10's output;
  health's other bytes are identical, its 15 tests were not touched, and a
  test in `gaps.test.ts` asserts the two reports name the same targets.
- **W6** — *(struck with the pane, 2026-09-05.)* §10 still lists *every* candidate. The pane's extra filters —
  demand of two, sanitizable names, demotion — are the pane's, applied on top.
  Diagnosis reports everything; a prescription is allowed to be selective.
- **W7** — *(struck with the pane, 2026-09-05.)* centrality is wiki-only degree: edges whose both ends are wiki
  pages, counted off the snapshot. `GraphNode.degree` counts citation edges
  too, and on the measured vaults roughly half of every degree was those, so
  "wanted by pages carrying N links" would have been a claim about how many
  files a page cites. PageRank was the alternative and was rejected: the
  façade reads `pprAlpha` live from settings, so card order would move when a
  user tuned retrieval, and pinning α would be a §17 deviation for a number
  nobody would see.
- **W8** — *(struck with the pane, 2026-09-05.)* `gaps()` is lock-free like `previewCompile` and `inspect`, and reads
  the page table fresh rather than from the snapshot, because §7.1 *drops*
  unresolved targets — the gap signal is not in the graph to be read. The
  consequence is accepted rather than fixed: `loadPageTable`'s read is
  unguarded, so the call can reject while a compile rewrites `wiki/`. The
  per-page scan does guard, and reports an `unreadable` count.
- **W9** — *(struck with the pane, 2026-09-05.)* a card's key is the gap plus its evidence: the target handle and the
  sorted paths of the pages wanting it. Dismissal expiry then needs no code at
  all — when another page starts wanting the same target the key is a different
  string, so the card returns. No hash: a third copy of FNV-1a (there are two
  private ones already) would be a copy that can disagree. The reason given for
  the length being safe was wrong — "bounded by §4's title length" is not true
  of anything the gate applied, since `sanitizeTitle` deliberately does not
  bound length. The successor gate in W-series below applies both of the
  namespace's rules instead of one.
- **W10** — *(struck with the pane, 2026-09-05.)* thin evidence is "exactly one citation entry", counted from the
  block, with no liveness test. Entries are manifest paths and a dangling or
  pending one is §10's business; deciding liveness here would mean an eighth
  answer on the readable/live seam CLAUDE.md says to change all-or-none.
  Source pages are excluded: §4 has each cite exactly its own raw file, so
  including them would describe the schema rather than the wiki.
- **W11** — *(struck with the pane, 2026-09-05.)* the thin list is capped at five, ranked by wiki degree. On both
  fixture vaults *most* non-source pages cite exactly one source, so uncapped
  this signal is a list of nearly every page. The cap is what makes it a
  recommendation; it is not a display detail and does not belong in the plugin.
- **W12** — *(struck with the pane, 2026-09-05.)* identifier-shaped names (`link_pairs`, `linkTargets`) and names
  already contained in an existing title (`vault` under "vault nodes") are
  sorted last, not dropped. Call B tells the model to link freely with natural
  names and these are what that produced; "usually noise" is not a reason for
  code to decide the user may not see them.
- **W13** — there is no separate invariant-8 check on a candidate name.
  `sanitizeTitle` strips the reserved `_` prefix, so every target invariant 8
  would refuse the sanitize test refuses first — verified by mutation, and the
  redundant check was removed rather than left as code no input could make
  decide anything.
- **W14** — `getGraph(options)` is an addition to §5's contract list, which §5
  states without saying it is closed. Same precedent as `inspect`, added to it
  in M4. (`gaps()` was a second addition and went with the pane; nothing
  outside core needs the scan now that the section is written inside the
  answer.)

## §14 manual check — fixes made during the pass

### Fenced JSON is stripped before parsing (§11)

Found by running the checklist against the real API, not by a test. With the
recorded default models, **compile could not complete at all**: every source
failed at `inventory` with "reply was not valid JSON after one repair retry",
no manifest was written, and no `wiki/` was ever created.

`claude-haiku-4-5-20251001` returns its JSON inside a ```` ```json ```` fence.
§11 asks for "parse, one repair retry", and `wrapper.ts` implemented exactly
that — but the repair *re-asks the same model*, which fences the second reply
too. The mitigation only ever worked against a model that cooperates on the
retry, and this one does not.

`unfence` now strips a whole-reply fence before both parses. It is deliberately
narrow: only a reply whose entire trimmed body is one fenced block is unwrapped,
so prose that merely contains a fence still fails and still reaches the repair
retry, which is the case that genuinely wants another look at the model.
`synthesize.ts`'s own fence regex reads §8.2's *trailing* block out of prose —
a different question, left where it is rather than unified, because one regex in
front of two grammars is how the trace parser got into trouble.

**The test that covered this could not have caught it.** `inventory.test.ts`
already had a case named "parses a reply the model wrapped in a fenced block via
the repair retry", and it passed throughout. Its stub was scripted to fence on
call 0 and return clean JSON on call 1 — so it asserted that recovery works
*when the model complies*, which is the assumption that fails in production. It
is the ninth-plus instance of the shape this log has named repeatedly: the test
built from the same example that motivated the design, confirming it rather than
discriminating against its absence.

Replaced with three tests. The discriminating one fences **every** reply, which
throws under the repair-only reading; it also pins the call count at 1, since
stripping means a fence no longer costs a model call. The other two keep the
repair path covered (prose → clean) and cover the second call site (prose →
fenced).

Suite 912 passed / 4 skipped. Boundary, lint, typecheck and eval green; eval
floors unmoved (recall@5 0.7604, recall@10 1.0000, MRR 0.7277).

### A click on a node reheats the layout and pins the node (§9)

**Status: CLOSED (2026-09-02).** Fixed on master (`9f90088`) and verified by
hand — checklist §7 in full, including the two negatives added for it: a click
on a settled layout moves nothing, and a node clicked then left alone drifts
with its neighbours instead of sitting pinned. That hand check is the only
thing that could confirm it, for the reason recorded below.

Fixed on master (`9f90088`). The gesture decision moved
into a new pure module `press.ts`; `pointerdown` now only records the press, and
the drag - with its reheat and its pin - begins on the first `pointermove` past
`CLICK_SLOP`.

**The tests do not discriminate.** Reverting `view.ts`, the file that held the
defect, leaves all 51 graph-view tests passing: the eight new ones exercise
`press.ts` against a stub and nothing asserts that `view.ts` asks it. That is
the tenth instance of this log's recurring shape. The extraction is right and
matches the project's own doctrine, but it moved the testable part out and left
the wired part bare. Closed instead by two new README §7 checklist items, both
negatives - a click must not reheat, a click must not pin - which are the only
place the wiring can be asserted. Still owed: §7 by hand.

**Status (2026-09-01):** taken up on branch `claude/jovial-hawking-548047`,
touching `sim.ts`, `view.ts`, `tests/graph-view.test.ts` and adding
`press.ts`. Unmerged and unverified — this entry stands until the change is on
master, `npm test` is green, and checklist §7 has been re-run by hand. Note
both open graph findings edit `tests/graph-view.test.ts`, so whichever lands
second will need a merge.


§9 gives *drag* two side effects — "simulation cools to a stop, drag reheats
locally" and "drag-to-pin" — and gives *click* one job, an instant PPR overlay.
The implementation gives a click all three.

`view.ts`'s `pointerdown` calls `sim.dragStart(node)` unconditionally, before
anything knows whether the gesture will become a drag, and `dragStart` both
`restart()`s the simulation at `DRAG_ALPHA_TARGET` and sets `fx`/`fy`. The
click/drag discrimination happens later, on `pointerup`, against `CLICK_SLOP`
— by which point the reheat has already fired and the node is already pinned.
`dragEnd` returns `alphaTarget` to 0 but deliberately leaves `fx`/`fy` set,
which is correct for a drag and wrong for a click.

So every click on a node: reheats the whole layout, pins that node forever, and
runs click-PPR. Only the third is §9's. The pins accumulate — a user who clicks
ten nodes while exploring has frozen ten of them, and the layout can no longer
relax.

Not an invariant-1 violation: the simulation still cools to a stop, and nothing
runs without a gesture. And the existing checklist items pass, because §7.3
tests that a *drag* pins and §7.6 tests that a *click* runs PPR — neither asks
whether a click does anything it should not. Found by a user noticing the graph
move when they expected only a recolour.

The fix is presumably to defer `dragStart`'s effects until travel exceeds
`CLICK_SLOP`, which makes `pointermove` rather than `pointerdown` the place the
drag begins. Worth checking against §7.3's "neighbours resettle around it" while
doing so: the reheat has to still happen for a real drag.

### Graph edges are drawn at a quarter of a near-background colour (§9)

**Status (2026-09-01):** FIXED on master (`c703d24`). `EDGE_ALPHA` 0.25 -> 0.45
and the edge colour moved from `--background-modifier-border` to `--text-faint`.
The tests pin composited WCAG contrast against the background rather than the
constant, so they fail on a revert and survive a retune - verified by mutation,
2 fail. Still owed: checklist §6.2/§6.3 and §9.2 by hand in both themes, since
which CSS variable `sampleTheme` samples needs `getComputedStyle` and cannot be
covered under vitest. Superseded status line follows.

**Status: CLOSED (2026-09-02).** Verified by hand: §6.2's four kind colours stay
distinguishable in both themes, §6.3 recolours live with the pane open, raw nodes
still read as nodes against edges now sharing `--text-faint`, and §9.2's export
is opaque in both — checked by decoding the PNGs rather than by eye, since a
viewer paints its own ground behind a transparent image. Dark exported
rgba(28,28,28,255), light rgba(255,255,255,255); both files are RGBA, so
transparency was possible and did not happen.

**Superseded status line:** taken up on branch `claude/jolly-goldstine-a818bb`,
touching `render.ts` and `tests/graph-view.test.ts`. Unmerged and unverified —
this entry stands until the change is on master, `npm test` is green, and
checklist §6.2/§6.3 and §9.2 have been re-run by hand in both themes.


`render.ts` draws every edge in `--background-modifier-border` — Obsidian's
subtle-divider variable, a colour chosen to sit just off the background — and
then applies `EDGE_ALPHA = 0.25` at `lineWidth = 1`. The result is that links
are effectively invisible against `--background-primary` on the default dark
theme.

§9 constrains only "Colors and fonts from Obsidian CSS variables"; it specifies
node colour by kind and says nothing about edges or alpha, so both the variable
and the 0.25 are free choices rather than spec. No checklist item asserts edge
visibility either, which is why this survived to a manual pass.

It matters more here than the "it is only cosmetic" reading suggests. The pane's
whole job is showing *why* retrieval ranked what it did, and PPR runs on the
edges — they are the mechanism, not decoration. During the §14 pass a node that
was in fact connected to the giant component read as isolated, and distinguishing
it needed a component computation outside the app.

Candidate fixes, unranked: raise `EDGE_ALPHA` to roughly 0.45–0.5, or move the
edge colour to `--text-faint` (already the raw-node colour, still theme-derived).
Either keeps §9's CSS-variable discipline. Obsidian's own core graph draws edges
about this faintly, so there is a house-style argument for leaving it — but that
graph is ambient navigation and this one is a diagnostic instrument.

## Verification owed — fixes merged but not yet confirmed by hand

Both graph fixes are on master and green under `npm test`, but the pane has no
automated Obsidian-surface coverage, and in one case the suite provably cannot
catch a regression. Neither finding is closed until these run against a real
vault. Tick them here, not in the README, whose boxes track a full pass rather
than a re-check.

**The click fix (`9f90088`)** — the suite does not discriminate here at all;
reverting `view.ts` leaves every test passing, so this list is the only guard:

- [x] §7 in full, all eight items
- [x] §7.7 specifically: a settled layout, a click with no pointer travel, and
      nothing moves
- [x] §7.8 specifically: click a node, then drag a *different* one — the clicked
      node drifts with its neighbours rather than sitting frozen

**The edge fix (`c703d24`)** — the contrast property is pinned by tests, but
which CSS variable `sampleTheme` reads needs `getComputedStyle` and cannot be
covered under vitest:

- [x] §6.2 four distinguishable muted kind colours — checked in **dark**
- [x] §6.2 again — checked in **light**
- [x] §6.3 switching theme with the pane open recolours it without a reopen
- [x] §9.2 the exported PNG has an opaque background in **both** themes
- [x] Raw nodes and edges now share `--text-faint`; confirm grey nodes still
      read as nodes against grey lines

**The reheat guard (2026-09-04, branch `claude/what-to-add-next`)** — the suite
pins that `replace` reports no reheat and still carries metadata, but whether a
settled layout *visibly* holds still needs a real vault:

- [ ] §4.7: with the pane open and settled, run a second **Compile** that
      reports "nothing to do". Nothing moves at all.
- [ ] §5.4 again: a compile that really changes a source still updates the
      counts, and the new node appears and settles.
- [ ] §7.3 again: a drag still reheats and neighbours still resettle — the
      guard must not have made `replace` the only reheat path.
- [ ] Edit one page's `summary:` by hand, press **Refresh**: the layout stays
      still and that node's tooltip shows the new summary.

**The force path (2026-09-04, branch `claude/what-to-add-next`)** — the suite
covers the core call; the button and the two triggers §5.5 names cannot be
reached under vitest:

- [ ] §5.5: write a page into `wiki/concepts/` from outside Obsidian — with
      `kind: concept` in its frontmatter, or `loadPageTable` skips it and the
      counts correctly do not move — then press **Refresh**. The counts rise by
      that page and by each of its links that resolves.
- [ ] §5.2 again: opening the pane is still under a second, i.e. opening reads
      the cache and does not walk.
- [ ] Press **Refresh** on an unchanged vault: the counts stay the same and the
      layout does not move (this is the guard above, on the new trigger).
- [ ] Press **Refresh** three times quickly: the counts update once and the
      layout settles once, not once per press.
- [ ] Press **Refresh** while a compile is running in this window: nothing
      changes until the compile finishes, and then the counts are the
      compile's.
- [ ] With a graph drawn, make a walk fail (lock a file under `wiki/` from
      another program) and press **Refresh**: the notice appears and the graph
      stays on screen rather than being replaced by "No graph yet".

## Open findings — not yet addressed

### Context-budget exhaustion is not reported to the user (§7.4 step 4, §8.3)

Found during the §14 manual-checklist setup, from reading rather than from a
failing test. Not yet fixed; recorded so the next pass over §8.3 picks it up.

`packUnderBudget` has two ways to lose a ranked page, and they are signalled
very differently:

- **The first item overflows the whole budget.** It is tail-truncated and
  `truncatedForContextBudget()`'s marker is appended into the text, so the
  *model* sees that the page was cut.
- **A later item does not fit.** The loop `break`s (`tokens.ts`), dropping that
  page and every page below it in rank order. No marker, no count, nothing.
  The break is deliberate — cherry-picking a smaller page from further down
  would destroy the rank order §6.5 and §7.4 both assemble in — but it means
  budget exhaustion can cost more pages than the budget strictly requires.

Neither loss reaches the user. The trace's `top:` line is built from
`assembly.nodes` (`index.ts`), i.e. the pages that survived, so the note lists
only what got in and never what was dropped; `usedTokens` is consumed for the
follow-up round's remaining budget and then discarded; and `wasTruncated` /
`TRUNCATION_MARKER` are exported from `assemble.ts` and read by nothing in the
repo — the signal is computed and thrown away.

The consequence is a third grounding state the frontmatter cannot express:
grounded, but in less than what retrieval found. §7.4 step 5 gives zero-seed
retrieval an explicit `grounded: false`; budget exhaustion is the same class of
degradation with no corresponding signal.

**This is the standard `Trace.unparsed` was written to meet** — "losing them
quietly is a different failure from losing them" — applied to a rarer and
smaller loss than this one. The fix is a §8.3 format decision (a `dropped:`
line, or a count beside `top:`), not a parser or assembly change, and it should
be taken with the trace-grammar work the M4 closeout deferred rather than
bolted on separately.

### A title-duplicating heading survives into a page (§6.5, invariant 5)

Found by the §14 manual pass, checklist item §4.5, on the demo corpus:
`wiki/concepts/Knowledge wiki compilation.md` opens its body with
`# Knowledge wiki compilation`. One page in twenty-nine.

The prompt already forbids it — `generate.ts` says "Do NOT write citations, a
sources list, frontmatter, or a heading that repeats the title. Those are
written by code **and yours would be discarded**." The last clause is false.
§6.5's post-process list is "frontmatter, link post-pass, citation block,
`updated` date", and there is no heading-stripping pass anywhere in
`src/core/compile/`. The prompt is the only defense, so the invariant holds
only as far as the model complies with it — and here it did not.

Consequence is small in itself (a redundant `<h1>` above prose that already
says the same thing) but it is the shape invariant 5 exists to prevent: the
model writing structure. It also makes pages inconsistent with each other,
which a reader notices before a reviewer does.

The fix is a post-pass in the same place the other four run: strip a leading
heading whose text matches the page title after the same normalization §4's
identity rules use, so case and NFC differences are caught too. Only the
*leading* one — `## How the update works` further down is legitimate prose
structure and must survive. Making the prompt's claim true is the cheapest way
to close it; softening the prompt instead would leave the invariant enforced by
nothing.

Worth measuring rather than assuming: one occurrence in twenty-nine pages is a
rate, not a certainty, and a rerun on the same corpus may not reproduce it.

### A compile that changes nothing still reheats the layout (§7.1, §9)

**Status (2026-09-04): FIXED on branch `claude/what-to-add-next`, verification
owed.** `sim.replace` now compares the incoming node paths and edge pairs
against the ones the current layout was built for (`sameTopology`, exported so
it can be asserted directly). On a match it carries the incoming title, kind,
degree and summary onto the nodes already held — a compile can rewrite a page's
prose without changing the topology, and the tooltip reads that metadata — then
returns without touching alpha. Every other snapshot reheats exactly as before.

`replace` returns whether it reheated. The view ignores the boolean; it exists
for the suite.

**Correction (2026-09-05).** The paragraph here first said the boolean was the
only way to observe a reheat, because `alpha()` "decays on d3's own timer from
the moment `restart()` runs". That is wrong, and the review that found it was
right to say so. `simulation.alpha(x)` is a synchronous assignment and
`restart()` only schedules d3's timer, which fires on a later turn — so `alpha`
read straight after `replace` is exactly what `replace` left. It is now on the
`Sim` interface, with `tick()` beside it to cool the walk off its starting
value without waiting for that timer.

The distinction was not academic. Asserting the boolean asserts what `replace`
*says*, and the mutation that matters is a `replace` that reheats and still
reports `false` — the original defect, wearing a correct answer. That mutation
passed all 996 tests. Against `alpha` it fails. This is the shape this log has
recorded before under a different name: an oracle computed by the code under
test is not an oracle. Mutation now: deleting the guard fails 3, inserting a
reheat before its `return false` fails 1, and deleting the `title` or `degree`
carry fails 1 each — the last two were previously unobserved, so the earlier
claim that "deleting the four metadata assignments fails 1" was true only of
the four together.

Taken with the force path below rather than alone, and after the click fix was
verified by hand (that condition is met — see Verification owed). The pairing is
deliberate: once Refresh really re-reads the vault, a press on an unchanged
vault would stir a settled layout every time, so the guard is what makes the
force path safe to add. Mutation: deleting the guard fails 3 tests, deleting the
four metadata assignments fails 1.

Found by the §14 manual pass while checking §4.7: with the pane open, a second
compile reports "nothing to do — no sources changed" and writes not one byte
(46 vault files verified byte-identical), yet the graph visibly rearranges.
Same nodes, same edges, new positions.

The rebuild itself is specified — §7.1 builds the graph "at plugin load and
after compile" — and the pane is *supposed* to react, which is what checklist
§5.4 asks of it. What is not specified is that the rebuild reheats
unconditionally. `sim.replace` ends with `simulation.alpha(REHEAT_ALPHA)
.restart()` whatever the incoming snapshot contains, so a settled layout at
alpha < 0.001 is kicked back to 0.3 and drifts to a different equilibrium.

That defeats the intent `replace` states three lines earlier, where it goes out
of its way to preserve `x`/`y` and `fx`/`fy`: "re-hashing every position on each
compile would throw the layout the user has been reading, and any pinning they
did with it." Reheating throws it too — less violently, and for a compile that
did nothing at all.

Invariant 1 is not violated: the walk still cools to a stop. This is the same
shape as the click-reheat fixed in `9f90088` — an action that changed nothing
moves the layout anyway — and the same user noticed both unprompted, on two
different triggers, which is the evidence that it reads as wrong rather than as
alive.

The fix is a guard, not a redesign: compare the incoming node paths and edge
pairs against the current ones and skip the reheat when they match. Cheap, and
it leaves every real rebuild reheating as it does now. Worth taking *after* the
click fix has been verified by hand — both live in the same gesture/simulation
seam, and stacking a second unverified change on the first is how this project's
fix rounds have historically gone wrong.

### The Refresh button cannot refresh (§7.1, §9, checklist §5.5)

**Status (2026-09-04): FIXED on branch `claude/what-to-add-next`, verification
owed.** `getGraph` takes `{ force?: boolean }`. Forced, it retires any build in
flight and walks the vault, publishing what it finds to `onGraphRebuilt` exactly
as a compile's own rebuild does; unforced it still answers from the cache, so
§15's "opens under a second" is untouched and the pane's first load does not
walk. The button calls `reload(true)`; nothing else forces.

Retiring first is the half that is easy to miss: `rebuildGraph` collapses
concurrent callers onto one walk, so without `invalidateGraph()` a forced read
would join a walk that began before the vault moved and answer Refresh with the
very snapshot it was asked to replace. Mutation: deleting the branch fails 2
tests, deleting the `invalidateGraph()` inside it fails 1.

Paired with the reheat guard above, which is what keeps a press on an unchanged
vault from stirring a settled layout.

**Two races found by review, fixed 2026-09-05.** Retiring the in-flight slot is
what makes a refresh a refresh, and it is also what stops `building` from
collapsing two presses: the second press retired the first, whose walk then
lost its generation and was handed the *pre-refresh* cache by `currentOrNewer`
— an answer older than the vault it asked about, plus a second full walk for
one gesture. Forced reads now coalesce on a `forcing` slot of their own. A
button gets pressed twice; that is not an edge case.

The second is the compile window. A forced walk that both starts and finishes
while a compile is rewriting `wiki/` reads pages the compile has written
against a manifest it has not yet committed — a snapshot of a vault that never
existed, cached and published, and left there if the compile then fails. A
forced read while the lock says `compile` now answers from the cache and leaves
the publishing to the compile's own rebuild, which is the only walk that can
see the vault whole. Narrowed to `compile` deliberately: `ask` writes
`answers/` and the health check writes a `_`-prefixed file, and neither is ever
a node, so a walk during those is sound and refusing it would make Refresh do
nothing for no reason. §9's "never blocked by the lock" holds either way —
nothing waits, the call returns at once with what is known.

Mutation: deleting the `forcing` slot fails 1, deleting the compile guard fails
1.

Two residuals are accepted rather than fixed, and named here so the next reader
does not think they were missed. A superseded walk publishes nothing, which is
right whenever its successor publishes — every case but one: a compile whose
own rebuild then fails leaves the cache at the pre-compile snapshot with
nothing to correct it. The recovery is a Refresh, which by then is not busy.
And an *unforced* build begun mid-compile with an empty cache can still publish
a torn snapshot; that predates this branch and is corrected by the compile's
rebuild on every path but the same failing one.

The pane keeps its drawn graph when a walk rejects, rather than replacing it
with the empty state. The walk failed, not the snapshot on screen, and
reporting an emptiness that is not true is the worse half of a failure the
notice has already described.

Found by the §14 manual pass. A page written into `wiki/concepts/` from outside
Obsidian left the pane reading `37 nodes, 74 edges`; pressing **Refresh**
returned the same numbers. Expected 38 and 75 — the page is a node and its one
resolving `[[Luka]]` link is an edge.

Not a wiring slip. The button calls `reload()`, which calls `core.getGraph()`,
which is:

    getGraph: () => (graph === null ? rebuildGraph() : Promise.resolve(graph)),

The cache is returned whenever one exists, and `rebuildGraph` is a private
function the `Core` interface never exposes. So the pane has no forced-rebuild
path available to it at all: **no input can make Refresh re-read the vault.**
What the button actually does is clear the overlay and redraw the snapshot it
already had.

§7.1 sanctions the cache — "built in memory at plugin load and after compile;
no cache file" — and `Core`'s own doc comment says "cached until the next
compile", so the caching is deliberate and the interface is honest about it.
What is missing is a way for §9's pane to opt out of it, which checklist §5.5
assumes exists: "the Refresh button updates the counts after a compile run from
another window or a vault sync". Both of those are exactly the case the cache
cannot see, because neither fires this window's rebuild event.

So the defect is a gap between two things that are each internally consistent:
the core caches by design, the checklist expects a re-read, and nothing
connects them. A button labelled Refresh that structurally cannot refresh is
the worse half of that gap.

The fix is small — give `getGraph` a force flag, or export `rebuildGraph` on
`Core`, and have `reload()` use it — but it needed a scope decision first:
whether §7.1's "at plugin load and after compile" is a complete list of rebuild
triggers, or a floor that §9's pane may add to.

**Decided (2026-09-02): a floor.** §7.1's sentence is answering where the graph
lives — in memory, no cache file — and its trigger list is incidental to that
point rather than a closed enumeration. §14 is spec too, and checklist §5.5
states the intent plainly. The alternative reading would mean deleting a button
that already exists and is already documented, and leaving a user whose vault
syncs across machines no way to update the pane short of restarting Obsidian.

So the missing rebuild path is the defect, and Refresh keeps its name. Whoever
takes this should add the force path rather than re-litigate the reading.

### §14's "no network request" method cannot work (checklist §8.1, §8.4, §11.5, §12.1)

Found while running §12.1. The plugin reaches the API through Obsidian's
`requestUrl` (`http-obsidian.ts`), which runs in Electron's **main** process.
DevTools' Network panel observes the renderer only, so a Luka model call never
appears there — not one, not three. An empty panel is consistent with any
number of calls.

Four items name that panel as their instrument. Three are negative assertions
(§8.1, §8.4, §11.5: "no network request") and were passing on evidence that
could not have failed. §12.1 is positive — "exactly one request appears in the
developer tools network panel — not two, not three" — and is simply untestable
as written.

The three negatives were re-verified statically instead, which is stronger than
the panel would have been even if it worked: click-PPR calls `core.computePPR`,
and `ppr.ts` contains no provider reference at all ("pure and synchronous: it is
arithmetic over a snapshot"); the filter handler sets a field and schedules a
redraw, reaching no core method; trace replay goes through `fromTrace` in
`overlay.ts`, which imports a type and `SimNode`. None of the three can make a
model call. Their ticks stand on that, not on the panel.

§12.1's count needs a server-side check — the Anthropic usage page — and the
checklist now says so. §8's preamble gains a note explaining why DevTools is
the wrong instrument, since the mistake is natural and would otherwise be made
again on every future pass.

Worth noting what this is *not*: `requestUrl` is the right choice, and its own
comment says why (it bypasses renderer CORS). The defect is in §14's
verification method, not in the transport.

### §14's "trigger Compile while the modal is open" cannot be performed (checklist §13.3)

Third item in this pass whose stated method cannot reach its condition, after
§8.7's directory and §12.1's network panel.

§13.3 asks the reader to trigger Compile a second time while the scope modal is
open and see "Luka is busy: compile", proving the lock spans preview → confirm
→ work. But an Obsidian modal captures the keyboard scope: Ctrl/Cmd-P does not
open the command palette while one is up, and there is no ribbon icon for
Compile (§8.1 gives the ribbon to the graph pane alone). There is no way to
dispatch the command from the UI in that state, so the notice cannot be
observed by the route the item describes.

**The property itself is covered, and precisely.** `cascade-m2d.test.ts` starts
a compile whose `confirm` callback blocks — the modal being open — and asserts
`busyWith === "compile"`, that a second `compile()` rejects with `BusyError`,
that the message is exactly "Luka is busy: compile", and that the lock clears
once the confirm answers. That is §13.3's whole claim, including the string.

So the item is not a gap in coverage; it is a gap between what is covered and
what a human can see. Three options, none free: give Compile a ribbon icon
(changes §8.1's "one ribbon icon" and adds surface for a single test); state
that the manual item is redundant and point at the test; or leave it and accept
that the reader ticks it on the test's authority. The last is what this pass
did, and the honest version of it is to say so in the item's own text rather
than let a future reader repeat the attempt.

Worth noting the shape all three share: each item names a *mechanism* rather
than an *outcome* — "a directory", "the network panel", "trigger it again" —
and mechanisms are what rot when the platform underneath them differs from the
one the author had in mind. The items that survived this pass unchanged are the
ones that name what should be true, and leave how to see it to the reader.

### A page alias can hijack a raw node's handle (§7.1)

Found while sizing the "what to add next" pane against `test-vault`. That
feature does not touch it and takes the snapshot as given.

`wiki/entities/runs.csv.md` carries the alias `raw/runs.csv` — model-written,
from Call A, which sees only the body and is asked for "obvious variants"; the
dataset's own derivative opens with the line `# runs.csv`. `buildGraph` claims
page titles and aliases before manifest sources, and `claim` keeps the first
claimant, so the handle `raw/runs.csv` maps to the entity page before the
manifest loop can claim it for the derivative. And `resolve` applies no `raw/`
guard — the guard `resolveLinks` and the health check both apply to exactly
this prefix — so every `[[raw/runs.csv]]` in a citation block or a `source:`
key resolves to the entity page.

The result on that vault: `raw/runs.md` sits at degree 0 as its own component,
while the entity page collects the edges §7.1 gives the source. The orphan
section does not report it either, because that filter excludes `kind: "raw"`.
Nothing is lost — no write, no data — but the graph says something untrue about
which file the citations name, and any ranking read off degrees inherits it.

It is systematic rather than a quirk of one vault: any derivative whose
descriptor page echoes its origin path as an alias does this.

Candidate fixes, unranked: give `resolve` the same `raw/` guard the other two
resolvers apply, so a source-shaped target is answered from manifest claims
only; claim manifest handles before page aliases; or refuse an alias beginning
`raw/` when the page table is loaded. Each touches `build.ts`, which CLAUDE.md
names as the seam where `GraphNode` changes reach the rename path, so it wants
its own commit with the 7/1 mutation counts re-run — not a fold into a feature.
