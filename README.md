# Luka

An Obsidian plugin that compiles source documents you drop into `raw/` into a
linked markdown wiki, then answers questions from that wiki with citations.
Retrieval is graph-based (Personalized PageRank over wikilinks) — no vector
database, no embeddings, no chunking.

The full specification is [handoff.md](handoff.md); decisions made where the
spec was silent are logged in [BUILD-NOTES.md](BUILD-NOTES.md).

## Status

Milestone M0 (scaffold) — under construction. Nothing user-facing works yet.

## Development

Requires Node ≥ 20.

```
npm install
npm run build          # typecheck + bundle to main.js
npm run dev            # rebuild on change
npm test               # vitest, src/core only
npm run check:boundary # asserts src/core never imports `obsidian`
npm run lint
```

### Trying it in Obsidian

1. `npm run build`
2. `npm run install:vault` — copies `main.js` and `manifest.json` into
   `test-vault/.obsidian/plugins/luka/`.
3. Open `test-vault/` as a vault in Obsidian and enable Luka under
   *Community plugins*. The vault is gitignored.

## Manual checklist

Automated tests cover `src/core` only; the Obsidian surface is checked by hand.

### M0

- [ ] Plugin appears under Community plugins and enables without console errors.
- [ ] Settings tab shows an API key field (masked) and one model id per task.
- [ ] Values survive a reload of Obsidian (they are stored in
      `.obsidian/plugins/luka/data.json`).
