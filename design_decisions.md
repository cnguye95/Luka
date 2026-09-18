# Design Decisions

Luka is an Obsidian plugin that compiles documents dropped into `raw/` into a
linked markdown wiki, answers questions from that wiki with citations, and draws
the retrieval mechanism in a graph pane. Retrieval is Personalized PageRank over
the wiki's own links: no vector database, no embeddings, no chunking.

This file records the reasoning behind the design — what was decided, what else
was on the table, what the decision produced, and how it is known to hold. It is
not a specification and not a changelog. Every decision is written to one
template:

- **Decision** — what was chosen.
- **Alternatives** — what else was viable, and why it lost.
- **Result** — what the choice produced in the product, including the cost accepted.
- **Validation** — how the decision is known to hold today.

## Contents

- [Principles](#principles)
- [Decisions](#decisions)
- [Deliberately not built](#deliberately-not-built)
- [Known limitations, accepted](#known-limitations-accepted)

## Principles

The twelve invariants the code is built to. Each is checkable, and most are
pinned by a test or a CI step named in the decisions below.

**** Code comments cite the invariants below as `invariant N`.

1. Nothing runs without explicit user invocation: no file watchers, no timers,
   no auto-compile, no background processes, no HTTP servers.
2. One global operation lock. Compile and ask are mutually exclusive; a second
   invocation shows "Luka is busy: <operation>".
3. The ingest manifest records only sources that completed successfully. A
   missing manifest is a first run, never an error.
4. Ingest problems surface as inline HTML-comment markers in the affected file.
   There is no ingest report and no aggregate count.
5. Citation blocks, frontmatter, footers, and the index are written by code,
   never by the model. The model writes prose only.
6. Nothing under `src/core/` imports the `obsidian` package. Enforced by
   `npm run check:boundary` in CI.
7. `wiki/` is machine-owned and regenerated wholesale. User-placed files in
   `raw/` receive exactly three sanctioned in-place writes, on markdown and
   text sources only: frontmatter where absent, inline-image link rewriting,
   and markers. Derivative files Luka wrote are Luka's to rewrite.
8. Files whose basename starts with `_` are infrastructure: never graph nodes,
   never edge sources, never retrieval candidates.
9. The provider API key lives in plugin settings, is sent only to the
   configured provider endpoint, and is never written anywhere in the vault.
10. Every provider call goes through the reliability wrapper: timeout, retries
    with backoff, per-task token caps.
11. Answer notes are written atomically on success only; a failed query writes
    nothing.
12. Model-call counts are deterministic functions of the worklist: compile
    makes one inventory call per changed source plus one generation call per
    queued page (plus one vision call per orphan image); ask makes at most
    three; inspect makes exactly one. Compile on an unchanged vault makes zero.

Four principles that grew out of building to those invariants:

- **Silence is resolved by the smallest option.** Where the specification said
  nothing, the choice was the smallest one consistent with the invariants —
  never added scope. A tunable, a sweep, a second pane, or a new file format
  had to earn its place against this rule, and several did not (see
  *Deliberately not built*).
- **No destructive operation is ever a failure-recovery step.** Deletes and
  overwrites happen only to complete an outcome that succeeded, and always
  behind an ownership guard. Recovery from failure is "the untouched record
  re-presents the work" — never a rollback, a withdrawal, or a cleanup delete.
  Every attempt to recover by loosening a guard destroyed user data; this rule
  is what replaced them.
- **Determinism wherever it is cheap.** Paths sort by code point, never by
  locale. PageRank sums in a fixed order so two runs are bit-identical, not
  merely close. Frontmatter keys are appended in a fixed order so annotation is
  byte-stable. Timestamps are UTC. The same vault produces the same bytes on
  any machine.
- **A failure costs one source or one page, never the run.** The success-only
  manifest (invariant 3) is the retry mechanism: whatever did not complete is
  absent from the record and is presented again next compile, with no extra
  state to get wrong.

## Decisions

### 1. Graph retrieval over wikilinks, not embeddings

**Decision.** Rank pages by Personalized PageRank over the wiki's own
`[[wikilinks]]`, seeded by one model call that reads the index. Below a density
predicate — fewer than 20 nodes, or fewer than 1.5 link pairs per node — a
lexical scorer ranks instead, because a walk over a sparse graph means nothing.
Whole pages are assembled under a token budget, never chunks.

**Alternatives.** A vector store over chunks, the default shape of
retrieval-augmented answering; or a hybrid with embeddings as a first pass.
Both add an index that has to be built, stored and kept in sync with the vault,
and neither can be drawn. The links the compile step already writes are a graph
the user can read.

**Result.** No index to maintain beyond the wiki itself. A retrieval step that
can be shown on screen — seeds, heat, top-K — and replayed from an answer note.
A lexical mode that makes the plugin useful on a vault of five pages. The cost:
retrieval quality depends on link density, which is why the mode predicate
exists and why filing answers matters, since each one adds edges.

**Validation.** The eval harness scores a committed fixture vault for
recall@5, recall@10 and MRR in both modes on every CI run and fails below
recorded floors (`npm run eval`). `tests/fuzz-ppr.test.ts` checks the walk
against an independent dense solve of the same linear system across thousands
of random graphs.

### 2. An Obsidian-free core behind injected adapters

**Decision.** Everything that decides anything lives in `src/core/` and reaches
the world only through two injected interfaces, `FsAdapter` and `HttpAdapter`.
The plugin implements them over Obsidian's vault API and `requestUrl`; tests
and the eval harness implement them over `node:fs` and `fetch`. The raw
provider transports are not exported from the core façade, so the only way to
reach a model is through the reliability wrapper.

**Alternatives.** Writing against the Obsidian API directly and mocking it in
tests — every test becomes a mock of a host that cannot run under vitest.
Exporting the transports for convenience — invariant 10 becomes a convention a
future caller can skip.

**Result.** The whole pipeline runs headless: the eval harness, the fuzzers and
the demo-corpus tests drive the real code on a real filesystem with real PDF
parsing. The graph pane's pure modules (`sim`, `render`, `overlay`, `press`,
`scrub`) were written the same way and are tested the same way; only the
`ItemView` itself needs a host.

**Validation.** `scripts/check-boundary.mjs` fails CI on any `obsidian` import
under `src/core/`. The suite runs with no Obsidian installed. Tests reach the
transports by module path, which is the only way they can be reached.

### 3. Explicit invocation, one lock, and reads that are never blocked

**Decision.** Every operation is a command the user runs. Compile and ask share
one lock, held from the scope preview through the confirm modal to the last
write. Read-only surfaces — the graph pane, query inspection, the scope
preview, filing — take no lock. The one read that could observe a half-written
vault, the graph walk, is fenced by a write phase that compile marks around its
writes: a walk overlapping the phase publishes nothing, and its caller gets the
previous snapshot.

**Alternatives.** File watchers and auto-compile on vault events — rejected
outright, because the user pays per model call and must see each one. Guarding
the graph walk with the operation lock instead of a write phase — tried, and
wrong four ways at once: it fell through to a full walk when nothing was
cached, was never consulted when a second press joined a walk in flight,
sampled the lock once at walk start so a compile beginning a moment later
reopened the window, and refused Refresh for as long as the scope-preview modal
stayed open — the one phase that holds the lock and writes nothing.

**Result.** A second Compile or Ask during a run shows "Luka is busy: compile"
rather than running twice. The pane stays live during a compile, Refresh works
while the preview modal is open, and no snapshot of a vault that never existed
is ever published.

**Validation.** The lock tests assert the busy message verbatim in both
directions. `tests/graph.test.ts` parks a compile mid-write, forces a read, and
asserts nothing was published. Checklist sections 3, 5 and 8 exercise the lock
and the pane by hand.

### 4. Two model calls per source, and code writes all structure

**Decision.** Compile makes two kinds of model call: an inventory call per
changed source (strict JSON — a summary plus the entities and concepts it
names) and a page-generation call per queued entity or concept page, fed the
full text of every citing source and never the old page. Source pages are
assembled by code from the inventory's summary. Frontmatter, the link
post-pass, the citation block, the `updated` date and the index are written by
code afterwards. Structure the model produces anyway — a heading repeating the
title, a forged sources or trace block — is stripped before the page is
written. Calls are counted above the wrapper, one per logical call, so retries
and the JSON repair retry are transport attempts, not calls.

**Alternatives.** One call per source that writes pages directly — no merge
step, so two sources naming the same concept produce two pages. Feeding the old
page back to the model — pages drift instead of regenerating, and a bad page
reinforces itself. Trusting the prompt's instruction not to write structure — it
was the only defense for a while, and it failed: a page opened with its own
title, and a forged sources block passed link validation and survived filing.

**Result.** The call count is a function of the worklist and nothing else: a
re-compile of an unchanged vault makes zero calls, and one modified source
costs one inventory call plus one call per page that cites it. Pages regenerate
wholesale from their sources, which is what makes deleting a source safe.

**Validation.** The call-count tests assert the invariant's number — three
logical calls where transport made four, the fourth being a repair.
`tests/synthesize.test.ts` feeds forged blocks and unterminated sentinels and
asserts they cannot survive. `tests/generate.test.ts` pins the heading strip
from four directions: folded comparison, leading heading only, all six levels,
matching text only.

### 5. Content-hash identity and the success-only manifest

**Decision.** A source is identified by its vault path and its content by the
SHA-256 of its bytes — taken after the sanctioned in-place writes, so an
annotated file does not read as modified on the next run. Four rules decide the
work: unchanged, modified, deleted, new. A hash that vanishes at one path and
appears at another is a rename and costs no model call. The manifest records a
source only when everything it owed succeeded. Unsupported files, failed
sources, and paths that cannot be recorded faithfully (line terminators,
backslashes, trailing whitespace) are never written to it, so they resurface on
every compile instead of disappearing.

**Alternatives.** Modification times — unstable across sync and copy, and
meaningless for a rename. Writing the manifest before the work and rolling it
back on failure — the original design of the rename path, replaced because
every rollback needed a rollback of its own.

**Result.** An unchanged vault compiles with zero writes and zero calls. A
failed source is retried next compile with no retry state anywhere.
`.gitattributes` normalizes text to LF so the same file hashes identically on
every machine, which the committed eval fixture depends on.

**Validation.** `tests/manifest.test.ts` and `tests/hash.test.ts` cover the four
rules, the rename, and hash-after-annotation stability.
`tests/fuzz-compile.test.ts` drives hostile bytes through the whole pipeline and
asserts that runs two and three are no-ops with zero calls and a byte-identical
vault. `tests/demo-corpus.test.ts` does the same on a real filesystem with real
PDF extraction.

### 6. The rename subsystem was rebuilt around one commit point and recorded ownership

**Decision.** A manifest entry is `{hash, derivative?}`: it names the markdown
file that is this source's readable text. The manifest is written once, at the
end of a compile, entirely from completed outcomes. A renamed source carries
its derivative to the new path at zero model calls; any complication — no
pointer to follow, a move that fails — falls back to plain re-extraction in the
same run and is reported. The `derived-from` key is read only as a guard before
a destructive write or before serving a file as a source's content, never to
locate a file.

**Alternatives.** The first version inferred ownership every compile from
filename stems plus the user-editable `derived-from` key, and recovered from
failures with bespoke compensations on an optimistically written manifest. It
was functionally correct and took five review rounds, each round's fix breeding
a new defect: a hand-repaired derivative silently overwritten, a renamed source
stranded forever, a stale file adopted as the wrong source's text. The
alternative to rebuilding was a sixth round.

**Result.** Failure recovery is one fact rather than a mechanism: the entry
that was never rewritten still describes the vault as it was, so the same work
is presented again. A folder move preserves a hand-repaired extraction and
costs nothing. The cost accepted: a complication that is only transient — a
file briefly locked — still moves the source into the worklist, so a compile
that should have cost zero calls can cost a few and the repair is lost on that
path. Both are reported.

**Validation.** `tests/churn.test.ts` runs randomized vault churn with injected
IO and page-generation failures (120 seeds by default, `CHURN_SEEDS=1500` for
review) and asserts the vault settles and reports the same thing about itself
every compile afterwards, that a repaired derivative whose original did not
change still carries the repair, and that no markdown ends up naming a
different origin unreported. A test pins that a failed carry followed by a
failed fallback leaves the manifest file byte-for-byte unchanged.

### 7. The pointer is the address; `<stem>.md` is a preference

**Decision.** Normalization writes a derivative to `<original-stem>.md` beside
its source when it can. When a rename's destination stem is already taken, the
file stays where it lies, is repointed there, and the manifest records that
location — a "float". Re-extraction prefers the canonical path and falls back
to the recorded one, so floats decay on their own the next time the stem is
free.

**Alternatives.** Widening the write guard so a rename could take over the
occupying file — tried twice, and both times it overwrote a user's file (once a
hand repair, once an unrelated note landing on a freed stem), because "the
origin is nowhere" is not a test for "this file is abandoned". Leaving the
deadlock documented: two sources that swapped names each held the other's stem,
neither could be placed, and both stayed un-ingested for good.

**Result.** A name swap converges in one compile with both repairs intact. A
stem held by a live float is reported as contention, exactly like a genuine
collision, and clears when the owner is next modified or renamed. There is
deliberately no standing re-homer: it would have to write on an unchanged
vault.

**Validation.** Deleting the float branch fails exactly seven tests, and
deleting the recorded-path fallback exactly one. Those two counts are re-run
after any change to the page table or the graph builder, because both feed the
rename path. The churn sweep carries a classifier that fails if anything
settles into permanent failure while holding intact markdown of its own.

### 8. User files get three writes, and deletes go to the trash

**Decision.** A user's markdown or text file is modified in exactly three ways.
Frontmatter keys it lacks are spliced in as text between its existing fences,
never through a YAML load/dump round trip. A remote image that was fetched has
its link rewritten to `raw/assets/<hash>.<ext>`, spliced at the link's own
offset. Markers are added as HTML comments and re-derived on every pass, so one
never outlives the problem it describes. A byte-order mark is preserved. A file
that does not survive a UTF-8 round trip is ingested and left exactly as
written; frontmatter that does not parse is left alone rather than guessed at.
Deletions of pages and derivatives go through Obsidian's system trash, falling
back to the vault's `.trash/`.

**Alternatives.** Re-serializing frontmatter through js-yaml — it deletes
comments, reorders keys, and retypes `010` to `10`. A permanent unlink, which
the adapter offered and the first version used. Skipping annotation on any file
that already had frontmatter — it would have blocked `ingested` and
`source-format` on every filed answer.

**Result.** What the user wrote stays byte-identical outside the three writes.
A mistaken confirmation at the scope modal, which approves a *superset* of
pages that may be deleted, is recoverable from the recycle bin with the
original paths intact. Removals from `raw/` are announced by count, so nothing
leaves the user's folder silently.

**Validation.** `tests/fuzz-compile.test.ts` asserts every non-derivative file
is byte-identical after a compile, BOM preserved and invalid UTF-8 untouched.
`tests/yaml.test.ts` pins the splice and the fence rule. Checklist section 13
confirms against the real adapter that a deleted page lands in the system trash
rather than being gone.

### 9. One title/alias namespace with exactly two rules

**Decision.** Titles and aliases share one namespace, and a page's title is its
filename. Two rules decide identity, each implemented once and applied at every
table that keys the namespace: how names compare (`handleOf` — NFC
normalization and a case fold) and how long a name may be (`titleStem` — 200
UTF-8 bytes, cut on a code-point boundary, tagged with a digest of the whole
title). Lookups invert the `-2`, `-3` uniqueness suffix, because appending one
is part of how a page was named.

**Alternatives.** Fixing the table where a defect surfaced. That was tried
across five rounds and failed the same way each time: every fix unified one
rule while fragmenting the other. Folding Unicode in the producer of names but
not in the tables they were checked against let an NFD title on disk miss the
NFC title a model returned, and the second page overwrote the first. Bounding
length inside sanitization made the matching key lossy, so two long concepts
merged. Moving the bound out split the stored key from the lookup key, so a
long title created a new page every compile, forever.

**Result.** One spelling rule and one length rule, named, with six tables keyed
by them. A concept whose name a source page already holds is found again as
`X-2` instead of spawning `X-3`, `X-4`. Accepted: a source page and a concept
of the same name still take two pages, and a concept whose name is a prefix of
a real `Name-<digits>` concept can be merged into it, because nothing on disk
records *why* a title carries `-N`.

**Validation.** `tests/dedup.test.ts` and `tests/pagetable.test.ts` pin both
rules at the measured thresholds (201 ASCII characters, 67 CJK, 51 emoji) and
the regression where `raw/PageRank.md` plus a concept named PageRank produced a
new page per compile.

### 10. The citation block is the citer record, and the cascade previews a superset

**Decision.** Each wiki page ends in a code-written citation block listing the
sources it was generated from, and that block *is* the persistent record of who
cites the page: a page's citers are the surviving entries of its existing block
plus this run's inventory matches, where "surviving" means the source file is
still in the vault. Only a deletion can empty a citer set; a page with zero
remaining citers is deleted. A modified or deleted source makes the scope modal
appear first, listing pages to regenerate and pages that *may* be deleted. The
preview is a pure function over the page table and the diff; the decision is
taken later against the manifest the run will actually write. A cascade that
could not complete records the departed path as pending rather than restoring
its old hash.

**Alternatives.** Revoking a modified source's citations when its new inventory
no longer names the page — one non-deterministic inventory call could then
delete a page the source still discusses. A sidecar citer database — a second
format to keep in sync with the one the user can read. Restoring the real hash
on a blocked cascade — it sat in the manifest able to pair as a rename with any
unrelated byte-identical file.

**Result.** The block is parsed structurally (fences, heading, entry lines, the
last block authoritative, every block stripped on rewrite) so a stray sentinel
in prose cannot swallow a page, and entries are paths rather than wikilinks so
a `|` in a filename round-trips. "May be deleted" is exactly true: a source
whose new inventory re-cites the page adds itself back before the decision.

**Validation.** `tests/citations.test.ts` pins the idempotent rewrite and the
greedy path capture. The cascade tests cover deletion, modification, the
pending sentinel, and the rule that a page written this run is never deleted by
the same run. `tests/demo-corpus.test.ts` asserts the delete-then-regenerate
criterion on the demo vault; checklist section 13 confirms it by hand.

### 11. The reliability wrapper's rules

**Decision.** Every provider call carries a 120 s timeout, two retries with
exponential backoff (1 s base, doubling, capped at 30 s, equal jitter) on
429/5xx/network, and a per-task `max_tokens` cap. `Retry-After` is honoured in
its seconds form, capped at the same 30 s; a value of zero falls back to the
ladder. An error that is not a typed non-retryable failure is retried. A reply
cut off by the token cap is a failure, not a short answer. A JSON reply wrapped
whole in a code fence is unwrapped before parsing. The vendor's error text is
kept in two forms: `message`, clipped to 500 characters for the notice, and
`vendorMessage`, unclipped, for anything that decides on it. Settings are read
live at the start of each run — one deep-copied snapshot per compile or ask,
not one taken at plugin load.

**Alternatives.** Clipping the error once for both uses — it silently disabled
the fallback that re-runs a call without `temperature` when a vendor refuses
the parameter, because the refusal was regexed out of text the clip had already
cut. Treating a fenced JSON reply as a parse failure and relying on the repair
retry — the repair re-asks the same model, which fences the second reply too,
and compile could not complete at all with the default small model. Honouring
an hour-long `Retry-After` — it would hold the single operation lock for the
hour. Snapshotting settings at plugin load — a freshly typed API key never
reached the provider while the settings tab reported success.

**Result.** A misconfigured or rate-limited run degrades to one notice per
failed source and retries next compile. A truncated page cannot reach `wiki/`
under a citation block claiming its full sources. The key typed a moment ago is
the key that is sent.

**Validation.** `tests/provider-matrix.test.ts` enumerates the fault matrix with
exact count and delay assertions, each checked red against the unfixed code
before it was trusted — the first version derived its expectations from the
wrapper and passed with retries turned off. `tests/provider-bounds.test.ts`
covers the caps and the truncation rule. `tests/inventory.test.ts` fences
*every* reply, so the unwrap cannot pass by the model cooperating on the retry.

### 12. The OpenAI-compatible provider

**Decision.** A second transport speaks the Chat Completions API against a
configurable base URL, sharing error handling, `Retry-After` parsing, base64
and the message split with the Anthropic transport through one module. Current
OpenAI models reject `max_tokens` in favour of `max_completion_tokens` while
most other servers know only the older name, so the host seeds the choice and a
400 naming the other field flips a per-run memo — surfaced as a retryable error
so the wrapper does the retry visibly. A malformed base URL is refused before
any request; an empty one falls back to the default. An empty API key sends no
header at all, because local servers want none. Each provider keeps its own
key: `apiKey` keeps its name and becomes Anthropic's, `openaiApiKey` sits
beside it. Switching provider moves the model ids to the other provider's
defaults, but only the ids still holding the outgoing provider's default;
anything the user typed stays.

**Alternatives.** A static choice of token field by host — leaves a gateway in
front of OpenAI with a loud 400 and no recovery. Retrying inside the transport —
a request the call counter cannot see. Sending both field names — rejected by
servers. A setting for it — a tunable for something the transport can learn.
Substituting `api.openai.com` for a mistyped local address — sends the user's
key to a vendor they never named. Renaming `apiKey` to `anthropicApiKey` —
settings migration is a non-goal, and a rename would have emptied the key of
every existing vault. A blanket id swap on provider change — the tab writes ids
on every keystroke, so a swap discards what the user typed for their own
server. Querying the endpoint for its model list — a network call from the
settings tab, which invariant 1 permits only behind a button nobody asked for.

**Result.** Ollama works with the key field empty and five ids pointed at a
local model. Switching to OpenAI and back loses neither key nor any typed id. A
wrong model id fails one source loudly with the server's own message and leaves
the manifest untouched. Accepted: a server that needs the newer field and is
not on `api.openai.com` pays one refused request per run; the memo learns in
one direction only; a hand-typed id can outlive the provider it was meant for
and sit in the tab looking foreign — visible and recoverable, where a silent
deletion is neither.

**Validation.** `tests/openai-compat.test.ts` pins the endpoint construction (a
trailing slash or `/chat/completions` stripped, userinfo and query kept), the
header rules, the memo flip, and `temperature: 0` actually reaching the wire
for JSON tasks. `tests/settings.test.ts` covers the per-field id rule in seven
cases. Checklist section 18 walks the provider against OpenAI and a local
server.

### 13. Deterministic PageRank with an independent oracle

**Decision.** Exact power iteration: `v' = α·A·v + (1−α)·p` with α = 0.85,
uniform personalization over the seeds, convergence at an L1 step below 1e-8,
at most 100 iterations. Adjacency is built in code-point node order so every
sum runs in one fixed sequence. A degree-0 node is a zero column: its mass
leaves, and it holds only what teleport returns. No valid seed means every
score is zero and no iteration runs. The result reports whether it converged.
A damping value outside (0, 1) falls back to the default rather than being
clamped, because at either boundary the update stops being a contraction.

**Alternatives.** Accepting "close enough" across runs — floating-point
addition is not associative, so two machines would break ties differently. A
uniform vector when no seed is valid — it ranks every node equally and looks
like a result. Testing the walk against numbers the walk itself produced.

**Result.** The same vault and question give bit-identical rankings on any
machine. A walk that hit the iteration cap says so instead of passing as
settled. Accepted: some graphs at the shipped defaults need about 118
iterations and truncate at 100. The numbers are measured and recorded, and no
mechanism is claimed for them — several confident explanations in a row turned
out to be wrong, each with a test built from the same examples as the claim.

**Validation.** `tests/ppr.test.ts` solves a five-node fixture by hand as a
linear system (v_a = 1380/3131) and checks the iteration against it.
`tests/fuzz-ppr.test.ts` solves `(I − αA)v = (1−α)p` by dense Gaussian
elimination — code shared with nothing in the product — across random graphs
with α sampled over (0.05, 0.95), and asserts agreement to 1e-6, exact mass
conservation when no node has degree 0, and bitwise-identical output when the
node and edge lists are reversed. Four named mutations each turn it red: row
instead of column normalization, α exchanged with 1−α, a degree-0 node keeping
its mass, and the threshold loosened by four orders of magnitude.

### 14. Assembly never cherry-picks

**Decision.** Pages are assembled whole, in rank order, under the context
budget. Packing stops at the first page that does not fit, and only the first
page can ever be truncated — when it alone exceeds the whole budget — with a
marker the model can see. Reading stops at K as well as packing. The follow-up
round, which appends pages found by scoring the model's own list of missing
information, appends whole pages only and does not run if nothing new fits.
Compile's page generation shares the same packer for its citing sources.

**Alternatives.** Skipping a page that does not fit to take a smaller one
further down — it silently reorders a ranking both callers built on purpose.
Splitting pages into chunks — the thing the whole design avoids. Letting the
follow-up round tail-truncate its first candidate to a few tokens — it did, and
the third model call was spent on a fragment that the sources list then claimed
as read.

**Result.** What the model sees is the ranking's top, in the ranking's order,
or an honestly marked truncation of its top item. The cost, recorded under
limitations: a page dropped because a later item did not fit is not reported
to the user.

**Validation.** `tests/tokens.test.ts` and `tests/retrieve.test.ts` pin the
packer's contract, the marker, and the read count — the only way the
read-stops-at-K guard can fail. The follow-up round's whole-pages rule is
pinned at the packer and end to end.

### 15. The trace grammar: one entry per line, and the old grammar is still read

**Decision.** Every answer note ends with a code-written retrieval trace —
mode, seeds, follow-up, top entries with scores — that the graph pane can
replay without a model call. The seed and top lists are written one entry to a
line, indented under the field name. The parser still reads the original
comma-separated form, counting what it cannot recover in `Trace.unparsed`,
because notes written before the change exist.

**Alternatives.** The inline form the specification showed, `[[A]], [[B]]`,
where both the delimiter and the brackets are legal label content —
`Newton, Isaac` is a title, `]]` can appear in a raw path — so `[[a]], [[b]]`
has two readings and no parser over that grammar is correct for every input.
Three successive parser fixes each closed one side by opening the other.
Escaping inside labels would have put a second grammar in front of every
consumer that reads a link.

**Result.** A newline cannot occur in a title or a path, because sanitization
collapses whitespace, so the delimiter is something the content cannot contain
and the grammar has one reading. Replay lights exactly what the note lists and
reports the count it could not resolve rather than quietly lighting fewer
nodes. Notes from before the change keep the loss they were written with; the
information was destroyed at write time, not read time.

**Validation.** `tests/trace.test.ts` round-trips labels carrying a comma *and*
brackets — the input neither old reading survived — and pins that the old
inline form still parses. Checklist section 17 checks the new shape in a fresh
note and the replay of an old one.

### 16. Answer notes are atomic by construction, and filing keeps the sources

**Decision.** An ask runs every model call, renders the whole note into one
string, and only then writes; there is no partial state a failure could leave.
Filing an answer moves it to `raw/answers/`, where the next compile ingests it
as an ordinary source with no special case and no redundancy gate. The trace
and the "Add next" section are stripped; the sources block stays. The copy is
written before the original is removed and withdrawn if the removal fails, and
a note that is already filed is refused.

**Alternatives.** Writing as you go and rolling back on failure. Keeping the
trace in the filed note — it is one run's working, and it would become a
source's assertions. A redundancy check before filing — a non-goal, since it is
a second retrieval with a threshold nobody can set.

**Result.** A failed ask writes nothing and says only that it failed. A filed
answer's citations become real graph edges on the next compile, so filing
densifies the graph rather than archiving prose. Two questions in one minute do
not collide, and two copies of one answer cannot both become sources.

**Validation.** The ask tests drive the lock in both directions, the
ungrounded callout, link validation through the vault's own title table, and
the collision suffix. `tests/demo-ask.test.ts` runs compile → ask → file →
compile on the demo corpus with real PDF extraction and asserts the filed
answer's source page exists and its links connect into the graph. It found a
defect no unit test could have: an alias of a retrieved page being unlinked as
if it named something outside the retrieved set.

### 17. "Add next" lives in the answer, not in a pane

**Decision.** Each answer note carries a code-written section, between its
sources and its trace, naming what would have strengthened *that* answer: links
on the consulted pages that resolve to no page, and the items synthesis
reported missing. It is drawn from two signals already in hand, costs no model
call, is omitted entirely when there is nothing to say, and includes a Mermaid
diagram with every label escaped so nothing in it renders as a link. The
frontmatter `missing:` key records synthesis's list verbatim; the section
filters it against the wiki — the key is the record, the section the advice.

**Alternatives.** A vault-wide pane of recommendation cards — built, reviewed
and reverted, because a pane recommends against the whole vault and spends its
slots on material nobody has asked about; the recommendation belongs where the
question is. Refusing camelCase names as code-shaped — tried and removed,
because `PageRank`, `GitHub` and `iPhone` share the shape with `linkTargets`;
a real name dropped is advice the user never sees, while a code-shaped name
that survives is one weak line.

**Result.** A reader who has just seen what was consulted is told what was not.
Filing strips the section, so the next compile cannot grow a page out of a
recommendation to write one; the `missing:` key survives as the durable form of
the signal.

**Validation.** `tests/addnext.test.ts` and `tests/gaps.test.ts` pin the filters
(including dropping an item the wiki already holds through an alias), the
escaping, the omission when empty, and that the health check and the section
name the same unresolved targets. Checklist section 17 covers the rendered
diagram, which only a human can see.

### 18. The graph pane is read-only, and each tool does exactly what its label says

**Decision.** The pane renders the last-built snapshot and is never blocked by
the lock. Clicking a node runs PageRank from it locally. "Inspect (1 model
call)" runs the retrieval pipeline's first three steps — index, seed call,
ranking — over the snapshot on screen, then stops. "Show retrieval on graph"
replays an answer note's recorded trace and never re-ranks. A press that
travels more than four pixels is a drag, which reheats the layout and pins the
node; one that does not is a click, which overlays and moves nothing. A rebuild
whose node and edge sets match the current layout carries the new metadata
onto the nodes already held and does not reheat. Refresh forces a fresh walk,
retiring any walk already in flight.

**Alternatives.** Reusing `ask` for inspection — it writes a note, spends
assembly, and makes the label false. Re-running PageRank on replay — it shows
what retrieval *would* reach now, a different claim from the one the note
makes. Starting the drag on `pointerdown` — the first version did, so every
click reheated the whole layout and pinned the node forever. Reheating on every
rebuild — a compile that changed nothing visibly rearranged the graph. Serving
Refresh from the cache — a button labelled Refresh that structurally could not
re-read the vault.

**Result.** The pane is the place to see why an answer surfaced what it did, at
zero or one model call, without a compile in progress getting in the way. A
settled layout stays settled until something real changes.

**Validation.** `tests/inspect.test.ts` parks a compile on its first model call
and asserts an inspection still runs, makes exactly one seed-selection call and
nothing else, and writes nothing. `tests/graph-view.test.ts` uses the
simulation's `alpha` as the oracle for "did this reheat" — not the method's own
return value, which the original defect could have reported correctly — and
pins the click/drag decision and the topology comparison. Checklist sections 5
to 8 carry the gestures only a human can perform, including two negatives: a
click must not reheat, and must not pin.

### 19. The pane's pure modules are tested; its view is checked by hand

**Decision.** Layout (`sim.ts`), drawing and hit-testing (`render.ts`), the
overlay model (`overlay.ts`), gesture classification (`press.ts`) and the
iteration scrubber (`scrub.ts`) import nothing from Obsidian, touch no DOM, and
carry automated assertions. The `ItemView` itself (`view.ts`) — lifecycle,
canvas, CSS-variable sampling, event wiring — is covered by the manual checklist
and nothing else, and the checklist says so.

**Alternatives.** Driving the real view under test — there is no host under
vitest. Treating the whole plugin layer as untestable — the first version did,
and `fs-obsidian.ts`, which only imports types, has had tests since.

**Result.** The camera transform and its inverse live side by side and are
tested together, because if they disagreed every gesture would pick the wrong
node at once. The wiring gap is named rather than hidden: reverting `view.ts`
leaves the suite green, so checklist section 7 is the only guard for the click
fix.

**Validation.** `tests/graph-view.test.ts` over the five modules, with the
mutations that turn each assertion red named in the file. Checklist sections 5
to 9 and 18 for the view.

### 20. The scrubber's frames are the ranking's own walk

**Decision.** When the pane computes an overlay by PageRank, the walk retains
its vector after each iteration (capped at 100) and a slider steps through
them. The frames come from the same `computePPR` call that produced the ranking
on screen. Each frame is normalized against its own peak and the top-K stroke
is re-ranked per frame. When the iteration ceiling exceeds the retention cap, a
last stop for the final scores is added and labelled, so the slider never
implies it stepped through iterations nobody kept.

**Alternatives.** A second walk from the pane, seeded the same way — free of
model calls, agrees today, and free to stop agreeing the moment anything about
the ranking's inputs moves. Normalizing every frame against the converged peak
— it makes the early iterations uniformly dim and answers "how far along is
this" instead of "where was the mass then". Pinning the stroke to the converged
ranking — it would claim iteration 1 had already chosen the winners.

**Result.** The slider answers "how far had the walk reached early on". Its
informative range is the first few stops: a walk converging to 1e-8 spends most
of its iterations on changes a heat ramp normalized to 1 cannot show, so stops
27 and 55 of a 55-step walk render identically. Mode A and trace replay get no
slider, because neither has a walk. The obvious next feature, a play button, is
ruled out in advance by the same fact.

**Validation.** `tests/graph-view.test.ts` covers `scrub.ts` and the inspect
path that produces the frames. Checklist section 18 walks the slider, including
the export of a scrubbed frame — the one check where two features meet.

### 21. The eval fixture is compiled by the real pipeline, and the floors measure ranking

**Decision.** `eval/fixture-vault/` is produced by running the real compile over
18 hand-written sources with a scripted provider and a frozen clock, so its
manifest, citation blocks and index are exactly what compile writes; the
rebuild is byte-identical and costs nothing. The harness ranks through the
product's own ranking functions in both modes, seeds in CI by exact title/alias
match (the force-include rule every query already gets, minus the model), and
fails below floors set at the first measured means less 0.05. A second floored
mean covers only the queries whose expected pages are *not* all force-included
as seeds, pinned by count and by membership. `--live` runs the real seed call,
prints the same metrics, applies no floors, and never runs in CI.

**Alternatives.** A hand-authored vault — a second implementation of the
manifest and citation formats, which drift. A fixture generated once with a
live key — not reproducible, and every regeneration would move the floors. One
overall mean — eight of the sixteen queries score 1.0 whatever the ranker does,
because their answers are seeds before ranking begins, which halves the
amplitude of any ranking change. Flooring `--live` against floors calibrated
from the CI-seeded subset — a good model seeds the easy queries out, and the
hardest few fail floors set from all eight.

**Result.** CI measures ranking and says so in the README; it says nothing
about whether the seed call chooses well or synthesis writes a good answer. The
first fixture build hit the graph-mode predicate at exactly 1.50 link pairs per
node, so any edit would have flipped the harness into lexical mode and quietly
stopped measuring what it claims; the corpus was enriched to 1.71, and a test
asserts margin, not passage.

**Validation.** `tests/eval-fixture.test.ts` and `tests/eval-metrics.test.ts`
pin the arithmetic against hand-computed numbers, the floor file's whole shape,
and the ranking-subset wiring from both directions. `npm run eval` runs in CI,
and the fixture is rebuilt and diffed byte-identical.

### 22. Tests must be able to fail

**Decision.** An assertion is trusted only after the code it covers has been
mutated and the assertion seen red; where no mutation can make it fail, the
test says so in its name rather than reading as coverage. Oracles are
independent of the code under test: a dense solver for PageRank, hand-computed
metrics for the eval, a hand-solved linear system. The instruments — `churn`,
`fuzz-compile`, `fuzz-localize`, `fuzz-ppr`, the provider fault matrix — are
committed into the suite with defaults under ten seconds and environment knobs
(`CHURN_SEEDS`, `FUZZ_SEEDS`, `FUZZ_LOCALIZE_SEEDS`, `PPR_SEEDS`, `CHURN_FIRST`)
for review-scale runs, and every seed is deterministic.

**Alternatives.** Instruments kept as scratch scripts — seed counts cited as
evidence that nobody can re-run are not evidence. Deriving a test's
expectations from the code under test — the first provider matrix did, and
passed in full with retries set to zero. Building a test from the example that
motivated a fix — it confirms the fix rather than discriminating against its
absence; eleven instances were counted before the shape was named.

**Result.** Three conventions, each learned from a defect that survived review
and fell to a mutation. A comment may make no causal claim unless a test
chosen to *break* the claim pins it; otherwise it states measured numbers and
no mechanism. A shape is validated once, at the boundary where it is read, not
one guard at a time deeper in. A reviewer's finding, however fluent, is
verified before it is acted on, because two of nine confidently argued findings
in one round would have introduced defects.

**Validation.** Each instrument's header names the mutations that turn it red.
The suite's structure is itself the record: instruments in `tests/`, oracles in
the test files, and the 7/1 rename tripwire re-run after every change to
`src/core`.

## Deliberately not built

Binding non-goals, and a few things considered later and declined.

- **Embeddings, vector stores, or chunking in any form.** The design thesis is
  that the wiki's own links are the index (decision 1).
- **HTTP servers, endpoints, or a CLI binary.** The core is CLI-ready by
  construction (decision 2); no adapter ships.
- **Auto-compile on vault events, file watchers, timers, background
  processes.** Invariant 1.
- **Hard-PDF paths: layout-aware extraction, OCR, a per-page vision fallback.**
  Dropped rather than deferred, for four reasons that are facts about the repo.
  The one-library allowance for PDF text was spent on `unpdf` for text-layer
  extraction, which was needed from the start. The smell test and the
  edit-the-derivative repair path became the sanctioned answer to a bad
  extraction: a scanned PDF yields an empty derivative headed by a
  `normalization suspect` marker — a labelled degradation with a documented
  repair. OCR means a WASM engine plus language data, and rasterizing pages
  needs a canvas, which `src/core` does not touch. And a per-page vision
  fallback turns the model-call count from a closed formula into one with a
  term nobody can predict from the worklist: a 200-page scan becomes 200
  calls, all retried on failure.
- **A vault-wide recommendation pane.** Built and reverted; the recommendation
  belongs in the answer (decision 17).
- **Querying an OpenAI-compatible endpoint for its model list.** It would serve
  every such server and guess nothing, but it is a network call from the
  settings tab, which invariant 1 allows only behind an explicit button — a
  different feature, recorded so it is not rediscovered as free.
- **A standing re-homer for floated derivatives.** It would have to write on an
  unchanged vault, which the four rules forbid, and it is exactly the extra
  machinery that turned the first rename subsystem into five rounds
  (decision 7).
- **A guarded sweep of orphaned derivatives.** `derived-from` is the only
  evidence either way, and no test can tell an abandoned file from a live
  source's. The notice names the file, and the user deletes it.
- **A redundancy gate on filing; preservation of human edits in `wiki/`;
  settings migration; backup rotation; operation logs; conversation threading
  or session state.** Each is either scope the smallest-option rule refuses or
  a behaviour the invariants rule out. Routing deletes through the system trash
  is the platform's default recovery path, not backup rotation.
- **LLM-driven health checks or lint; quote-level provenance injection; slide
  or figure outputs; internationalization; community-store submission prep.**

## Known limitations, accepted

Each of these is a deliberate trade, recorded so it is not mistaken for an
oversight.

**Ingest and renames**

- An orphaned derivative — markdown carrying `derived-from` to a source that no
  longer exists — is never a source and never swept, and holds its filename
  stem against every future source. The notice names it. On the churn sweep it
  is overwhelmingly a hand-edit phenomenon.
- Discovery's source collection, rename repointing and the manifest write have
  no per-source guard, so an IO failure there ends the run after model calls
  were spent; one unreadable file under `wiki/` also rejects the graph walk.
  The index write was guarded because its severity was worse.
- A transient IO failure during a carry moves the source into the worklist, so
  a compile that should have cost zero calls can cost a few — the direct
  consequence of the blunt failure policy (decision 6).
- A crash between a carry's move and the manifest write costs the repair, not
  the source: the next compile re-extracts rather than trust a file at a path
  the entry does not record.
- A derivative removed because its source changed type to passthrough is
  counted in the completion notice, not named.
- Image localization rewrites links inside code fences and HTML comments;
  reference-style `![x][r]` and raw `<img>` are neither fetched nor marked. A
  file that does not survive a UTF-8 round trip is ingested with no marker, and
  its mojibake reaches page generation.
- Unreachable remote images hold the operation lock for the 120 s fetch
  timeout, four at a time.

**Compile and the namespace**

- A source page and a concept of the same name take two pages, `X` and `X-2`;
  a concept whose name is a prefix of a real `Name-<digits>` concept can be
  merged into it when a source page holds the prefix.
- The title table resolves a contested alias in title order and the graph
  builder in path order, so on a hand-edited vault the two can disagree about
  which page owns an alias. Compile enforces one owner per alias, so a
  Luka-generated wiki does not reach that state.
- The leading-heading strip compares folded titles, so a body opening
  `# raw/figures.md` under a title derived from that path survives.
- A source whose inventory call failed still grounds the pages that cite it,
  and those calls repeat every compile until it succeeds.
- The citation and link post-passes, the sentinel stripper and the image
  localizer are fence-blind: a code sample of the exact shape is consumed.
- "Where is this source's readable markdown" has one answer; "is this source
  still live" is still answered by three functions independently, and a local
  fix to one drifts the siblings.

**Retrieval and answers**

- A ranked page dropped because a later item did not fit the budget is not
  reported; the trace lists only what got in; `top:` is capped at 10 against an
  assembly cap of 12; follow-up-round entries carry a score of 0.
- PageRank at the shipped defaults truncates at 100 iterations on some graphs
  (chains, stars and even cycles need about 118). The result says so, and no
  mechanism is claimed.
- A raw source named `C#.md` cannot be linked into, because `#` is read as a
  heading reference everywhere.
- Answer notes written before the trace grammar changed keep the losses they
  were written with.

**Provider**

- The token-field memo learns `max_tokens → max_completion_tokens` and never
  the reverse; a multi-model gateway needing both loses the rest of one compile
  and recovers next run. A server needing the newer field off `api.openai.com`
  pays one refused request per run, and fails outright with retries set to
  zero.
- A hand-typed model id outlives the provider it was meant for; a gateway
  serving Claude models over the OpenAI protocol has its ids swapped on a
  switch. One retype fixes either.
- `Retry-After` as an HTTP date is ignored in favour of the ladder, which
  retries sooner than asked, never later.
- `comparePaths` is UTF-16 code-unit order where its documentation says code
  point.

**Graph pane**

- The frame budget is spent on edges, not nodes: 520 pages at four links each
  stutter where the same pages at two links pan smoothly.
- The view's wiring — the slider, the click handler, the refresh button, the
  tooltip — is covered by the manual checklist and nothing else; reverting
  `view.ts` leaves every automated test green.
- Two overlays can be alive at once (the double-click restore slot keeps one),
  so a scrubber's frames can outlive the rebuild that retired them. Memory is
  bounded at 100 vectors × nodes per overlay and released on the next one.
- A Refresh pressed during the compile's own rebuild walk retires that walk;
  the recovery is another Refresh.

**Evaluation**

- Half the eval queries are answered by seeding alone; the ranking-only subset
  buys headroom against the floors, not demonstrated detection of a regression
  the overall means would miss.
- The churn sweep's deadlock classifier has produced no signal in either
  direction on the current generator; the swap cases it was written for are
  pinned by direct tests instead.
