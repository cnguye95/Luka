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
