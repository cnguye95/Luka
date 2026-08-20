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
