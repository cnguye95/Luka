# Manual checklist

Automated tests cover `src/core` and the graph pane's pure modules. The Obsidian
view is checked by hand against this list. 

They are ordered so that stopping anywhere leaves the most valuable ground
covered: setup first, then the graph pane — the only part with no automated
coverage whatsoever — then the older flows, then the destructive and paid
checks, then edge cases. Work top to bottom.

Last assessed on September 13, 2026.

### 1. Start here — does it load at all

If any of these fail, nothing below is worth running.

- [ ] Plugin appears under Community plugins and enables without console errors.
- [ ] Settings tab shows a **Provider** dropdown, the selected provider's key
      field (masked), and one model id per task.
- [ ] Values survive a reload of Obsidian (they are stored in
      `.obsidian/plugins/luka/data.json`).

### 2. Before you compile — the empty-vault states

Do these while the vault is still empty; after the first compile you cannot
get back to this state without deleting `wiki/` and the manifest.

- [ ] On an empty vault — no `wiki/`, no manifest — the pane shows
      "No graph yet. Run Luka: Compile to build one." rather than a blank area.
- [ ] On an empty vault the Compile pointer shows and the banner does not —
      the two states never appear together.

### 3. The first compile

Copy `demo/raw/` to `raw/` in the test vault. Needs a real API key: this
compile costs a few cents and takes a minute or two.

- [ ] **Luka: Compile** reports seven new sources and nothing skipped.
- [ ] `.obsidian/plugins/luka/ingest-manifest.json` lists exactly the seven
      sources.
- [ ] A second **Luka: Compile** reports "nothing to do" and modifies no files.
- [ ] `raw/note.md` and `raw/notes.txt` gained an `ingested` / `source-format`
      block at the top and are otherwise unchanged.
- [ ] `raw/note.md` shows
      `<!-- image not fetched: fig1.png — ... -->` under the figure, with the
      original remote link still present, and its `data:` image untouched.
- [ ] `raw/page.md`, `raw/paper.md`, `raw/runs.md` and `raw/toy-repo.md` exist,
      each carrying `derived-from`.
- [ ] `raw/paper.md` contains the PDF's text, confirming pdf.js works inside the
      Electron renderer.
- [ ] Editing `raw/note.md` and compiling again reports one changed source.
- [ ] Triggering Compile twice in quick succession shows
      "Luka is busy: compile" rather than running twice.

### 4. What compile wrote

Reading the vault the compile above produced. No further calls.

- [ ] `wiki/sources/` holds one page per source, each with a
      `source: "[[raw/...]]"` key and a citation block naming its own raw file.
- [ ] `wiki/entities/` and `wiki/concepts/` hold pages whose bodies are prose
      with `[[wikilinks]]`, and whose citation blocks name the sources they came
      from.
- [ ] `wiki/_index.md` opens with `# Index` and lists every page under
      *Sources*, *Entities* or *Concepts*.
- [ ] Ctrl/Cmd-clicking a `[[link]]` in a generated page opens the page it
      names, or offers to create it (an unresolved link is a future-article
      signal, not a bug).
- [ ] No wiki page contains frontmatter, a citation list, or a heading written
      by the model — code writes all four (invariant 5). The heading half was
      the one that failed: a page opening with its own title again, which no
      pass removed until the post-process gained one.
- [ ] `raw/orphan.md` exists and describes the image, carrying `derived-from`.
- [ ] A second **Luka: Compile** reports "nothing to do" and makes no API calls
      (watch the console or your Anthropic usage page).
- [ ] Editing one source and recompiling regenerates only the pages that cite
      it.
- [ ] Removing the API key and compiling a changed source surfaces one failure
      notice per source and leaves the manifest untouched, so the next compile
      with a key restored picks them up again.

### 5. The graph pane opens

Everything from here to "Export" is the graph pane, which has no automated
coverage at all, so it is checked here instead. This is the largest
unverified surface in the project, so it comes before the older flows.

- [ ] **Luka: Open graph** in the command palette opens the pane, and the ribbon
      icon opens the same one. Pressing the ribbon again *reveals* that pane
      rather than opening a second copy.
- [ ] On the compiled demo vault the pane opens in under a second (an acceptance
      criterion — wall-clock it from the click to the node/edge counts appearing).
- [ ] On a small vault (a handful of pages), the pane shows the banner
      "Mode A (lexical) active — graph ranking off" followed by live node, link
      pair and ratio counts, and the counts match what `wiki/_index.md` implies.
- [ ] With the pane open, run **Luka: Compile**. When it finishes, the pane's
      counts update on their own, with no click. (The graph-rebuilt event.)
- [ ] The **Refresh** button updates the counts after a compile run from another
      window or a vault sync. Pressed three times quickly it updates once, not
      three times — the presses join one walk rather than each starting their
      own.
- [ ] Close the pane and reopen it: it works, and the developer console shows no
      error logged at close. (Invariant 1 — nothing of the view outlives it.)
- [ ] The graph draws: nodes appear, spread out, and the layout comes to rest
      within a few seconds rather than jittering forever. (The simulation must
      cool to a stop.)
- [ ] Once it has settled, the pane is idle — Obsidian's CPU use drops back to
      baseline and stays there with the pane open and untouched. (Invariant 1:
      the only sanctioned loop is the simulation, and it must end.)

### 6. The graph draws correctly

- [ ] Close and reopen the pane on the same vault: the layout starts from the
      same arrangement both times. (Initial positions are seeded by hashing the
      page path.)
- [ ] Concepts, entities, sources and raw files are four distinguishable muted
      colours, and they are theme colours — not fixed hues.
- [ ] Switch Obsidian between dark and light with the pane open. The graph
      recolours itself without needing to be reopened. (An acceptance criterion.)
- [ ] Well-connected nodes are visibly larger than leaf nodes.
- [ ] At rest, about ten labels are shown — the highest-degree nodes — not one
      per node.
- [ ] Hovering a node shows a tooltip with its title, kind and summary. A raw
      source shows its filename and "raw" with no summary line.

### 7. The graph responds to the pointer

- [ ] Dragging on empty space pans the graph; the scroll wheel zooms, and the
      point under the cursor stays under it rather than sliding away.
- [ ] Hovering costs no vault reads — the tooltip appears instantly even on a
      large vault, because the summary travels on the node.
- [ ] Dragging a node moves it, and it stays where it is dropped while its
      neighbours resettle around it. (Drag-to-pin.)
- [ ] Double-clicking a node opens that page in the current tab. Double-clicking
      a raw source opens its readable markdown.
- [ ] Moving the pointer off the canvas hides the tooltip and clears the hover
      label.
- [ ] Dragging a node does *not* trigger click-PPR when you release it; a click
      without movement does.
- [ ] Let the layout come to rest, then click a node **without moving the
      pointer**. The overlay appears and *nothing moves* — a click must not
      reheat the simulation the way a drag does.
- [ ] After that click, drag a *different* node to stir the layout, and watch
      the one you clicked. It drifts along with its neighbours rather than
      sitting frozen — a click must not pin. Only a drag pins.

The last two are negatives: they check that a click does *not* acquire the
drag's side effects. Both were true bugs, and neither is caught by the suite —
`press.ts` decides which gesture a press became and is tested directly, but
nothing asserts that `view.ts` actually asks it. Reverting `view.ts` alone
leaves every automated test passing, so these two items are the only thing
standing between that regression and the vault.

### 8. Overlays and the filter

**How to check "no model call".** Not in DevTools. The plugin calls the API
through Obsidian's `requestUrl`, which runs in Electron's main process, so its
requests never appear in the renderer's Network panel — an empty panel there is
consistent with any number of calls and proves nothing. Use your provider's
usage page, which counts server-side, or read the path: click-PPR, the filter
and trace replay reach no provider at all, and `ppr.ts` holds no reference to
one.

All of these are free — click-PPR, the filter and replay make zero model
calls.

- [ ] Clicking a node recolours the graph instantly: the clicked node gains a
      ring, the top-K gain a stroke, reached nodes take a heat ramp, and
      everything unreached dims. No model call — see the note above on how to
      check that.
- [ ] The status line names the overlay while one is active.
- [ ] Pressing Esc clears the overlay and restores the plain graph.
- [ ] Typing in the filter box dims non-matching nodes as you type, matching on
      both title and path, case-insensitively. Clearing it restores everything.
      Again, no model call.
- [ ] Filter and overlay compose: with both active, a node outside both is
      dimmer than one outside only one of them.
- [ ] Click-PPR still works while a compile is running — the pane is never
      blocked by the lock.
- [ ] Open the pane on a vault where one file under `wiki/` is unreadable. Deny
      read on it — `icacls "<file>" /deny "%USERNAME%":(R)` on Windows, `chmod
      000` elsewhere; restore with `/remove:d`. Replacing it with a *directory*
      does not reproduce, because `fs-obsidian.ts` tags entries by kind and
      `pagetable.ts` skips folders, so the file is never read and nothing
      throws. The pane shows a notice naming the problem
      and falls back to the empty state — it does not throw into the console or
      render a blank surface with no explanation.

### 9. Export

- [ ] **Export PNG** downloads a file through the browser/OS download path. It
      matches what is on screen — same camera, same overlay if one is active.
- [ ] The exported image has an opaque background in both dark and light
      themes, not a transparent one.
- [ ] Nothing new appears anywhere in the vault after an export.

### 10. Ask, answers, filing

Needs a real API key. One question costs a few cents.

- [ ] **Luka: Ask the wiki** opens a modal with a single question field, already
      focused. Enter submits; Esc and Cancel both close it and do nothing.
- [ ] Asking a question about something in the wiki writes
      `answers/YYYY-MM-DD-HHmm <slug>.md` and **opens it in a new leaf**.
- [ ] The note reads as prose with `[[links]]`, then `## Sources consulted`,
      then `## Retrieval trace` — and its frontmatter carries `kind: answer`,
      `question`, `asked`, `mode` and `grounded`.
- [ ] Ctrl/Cmd-clicking a link in the answer opens the page it names.
- [ ] Asking something the wiki says nothing about produces a note whose first
      line is the `> [!warning] Not grounded in your wiki` callout, rendered as
      a callout in reading view, with `grounded: false`.
- [ ] Triggering **Ask the wiki** while a compile is running shows
      "Luka is busy: compile"; triggering **Compile** while an ask is running
      shows "Luka is busy: ask".
- [ ] **Luka: File this answer** does not appear in the command palette while a
      non-answer note is active, and does appear on an answer note.
- [ ] Filing moves the note to `raw/answers/`, drops the `## Retrieval trace`
      block, keeps `## Sources consulted`, and shows
      "Filed. Run Compile to integrate." — with no compile starting on its own.
- [ ] The next **Luka: Compile** ingests the filed answer as an ordinary source:
      it gains a `wiki/sources/` page, and the answer's own links now connect it
      into the graph.

### 11. Trace replay on the graph

Continues from the answer note the section above wrote.

- [ ] Ask a question on the demo vault, then run **Luka: Show retrieval on
      graph** from the answer note. The pane opens and lights exactly the pages
      the note's own trace block lists as seeds and top entries.
- [ ] The command does not appear in the palette while a non-answer note is
      active, and the pane's "Show retrieval" button is hidden then too.
- [ ] Delete the `<!-- trace:start -->` block from an answer note by hand and
      run the command: a notice says there is no trace, and the pane is left
      exactly as it was.
- [ ] Replay a trace, then compile after deleting one of the pages it names.
      Replay again: the remaining pages light and the status line reports how
      many labels it could not resolve.
- [ ] Trace replay makes no model call.

### 12. Query inspection — one model call per press

The only paid items in the pane. Skip if you would rather not spend the calls;
nothing below depends on them.

- [ ] With a real API key set, type a question into the graph's query box and
      press **Inspect (1 model call)**. Exactly one request reaches the API —
      not two, not three. Count it on the usage page, not in DevTools.
- [ ] The button's label reads exactly "Inspect (1 model call)".
- [ ] The overlay appears: seeds ringed, top-K stroked, and on a Mode-B vault a
      heat ramp across what the query reached.
- [ ] On a small Mode-A vault, inspection lights seeds and lexical top-K with
      **no** heat ramp, and the Mode-A banner above explains why.
- [ ] Nothing is written anywhere in the vault by an inspection — no answer
      note, no file at all.
- [ ] The button is disabled while the call is in flight, and pressing Enter in
      the query box does the same thing as clicking it.
- [ ] Inspect works while a compile is running (the pane is never blocked), and
      Esc clears the resulting overlay.

### 13. Deletion is recoverable — destructive, deliberately late

These delete pages, so they come after everything that reads the vault. The
core is tested against in-memory and Node filesystems; only Obsidian's own
adapter can show that a delete reaches the system trash, which makes the
trash pair here the highest-value items in the list.

- [ ] Deleting `raw/page.html` and running **Luka: Compile** opens the scope
      modal first, showing the diff counts and both lists — pages to regenerate,
      and pages that may be deleted.
- [ ] Pressing **Cancel** (or Esc) closes it, reports "compile cancelled", and
      changes nothing: `wiki/sources/page.md` and `raw/page.md` are still there.
- [ ] Triggering Compile a second time while the modal is open shows
      "Luka is busy: compile" — the lock is held across the confirm.
- [ ] Running Compile again and pressing **Compile** removes `wiki/sources/page.md`
      and `raw/page.md`, drops the page from `wiki/_index.md`, and regenerates
      any page that cited it from its remaining sources.
- [ ] After the deletion above, `wiki/sources/page.md` and `raw/page.md` are in
      the system trash (or the vault's `.trash/` folder, if the platform has no
      usable system trash) — **not** gone. This is what makes a mistaken
      confirmation at the scope modal survivable, and it is the one thing the
      modal's "pages that *may* be deleted" wording promises but code cannot
      assert.
- [ ] A `.trash/` folder in the vault is not picked up as a source: with the
      vault otherwise up to date, **Luka: Compile** still reports "nothing to
      do".
      Luka's own deletes will not produce that folder — it asks for the system
      trash first and only falls back to the vault's — so the way to reach this
      state is Obsidian's own setting. Under *Settings → Files and links →
      Deleted files*, choose **Move to Obsidian trash (.trash folder)**, then
      delete any markdown file through Obsidian's file explorer. `.trash/`
      appears at the vault root holding it. Compile, confirm "nothing to do",
      and put the setting back to *Move to system trash*.
      This was marked N/A for a whole pass on the grounds that a system trash
      makes it unreachable. That was a claim about Luka's deletes, not about
      the folder: the user's own deletes put files there on any platform, and
      the property — that a file you deleted cannot walk back in as a
      brand-new source — is worth confirming against the real adapter. The
      same property is now pinned in `tests/compile.test.ts`.
- [ ] Editing a source rather than deleting it also opens the modal, and its
      "may be deleted" list is empty.
- [ ] A compile whose diff is only additions opens no modal at all.

### 14. Health check

- [ ] **Luka: Health check** writes `wiki/_health.md` and opens it, with no
      notice about model calls because it makes none.
- [ ] It lists article candidates (links that resolve to nothing), orphan pages,
      citations naming files the manifest does not know, filed answers with
      their ages, and counts.
- [ ] Running it twice in a row produces the same file; resolving a link by
      writing the page it wanted removes it from the candidates on the next run.
- [ ] Running it while a compile is in flight shows "Luka is busy: compile".

### 15. Settings detail

- [ ] The settings tab shows a **Retrieval** section: context budget, pages per
      answer, both graph-mode thresholds, and a follow-up toggle.
- [ ] **Advanced (PageRank)** is collapsed by default and expands to damping,
      maximum iterations, and a convergence threshold that is visible but not
      editable.
- [ ] Editing a numeric field and reloading Obsidian keeps the new value;
      typing nonsense into one and reloading falls back to the documented
      default rather than breaking compile.

### 16. Bigger vaults and edge cases

Least likely to matter, and the 500-node item needs a vault you may not have.

- [ ] On a vault of 500+ nodes the standing labels disappear and panning stays
      smooth. (Labels are dropped first.)
- [ ] Compile enough sources to pass the predicate (20+ nodes and 1.5+ link
      pairs per node). After the refresh, the banner disappears.
- [ ] A markdown source with **two or more** reachable remote images localizes
      all of them on its *first* compile, with no source failing. (Localization
      fetches four at a time into a `raw/assets/` folder none of them has
      created yet.)
- [ ] Hand-editing `.obsidian/plugins/luka/data.json` to
      `"contextBudgetTokens": 0`, `"compileConcurrency": "two"` or
      `"requestTimeoutMs": 0` and compiling still behaves: the run completes,
      pages keep their grounding, and nothing is rewritten from an empty
      context. Restore the file afterwards.

### 17. What the answer says to add next

The newest thing here, and the only section whose subject is a picture — so
most of it can only be checked by looking. Everything below is about one answer
note; ask once and work down.

Nothing in this section costs a model call except the ask itself.

**Getting an answer that has something to say.** The section only appears when
the answer ran into something, so pick a question whose pages reach for a page
you have not written. On the demo vault, *"How are decorative images filtered
out?"* does it: two pages link `[[decorative image filtering]]`, which does not
exist.

- [ ] The answer note ends with `## Add next`, sitting between
      `## Sources consulted` and `## Retrieval trace`.
- [ ] Each gap is one bullet, its **name in bold**, and the sentence says how
      many of the consulted pages wanted it and names them — or says the wiki
      could not answer it, for something synthesis reported rather than a link.
- [ ] Below the bullets, a diagram **renders in reading view** rather than
      showing a fenced code block or an error. Switch to source mode and back:
      the bullets carry the same facts in words, so nothing is only in the
      picture.
- [ ] In that diagram, a gap is a **dashed** box and the pages that wanted it
      are solid ones, joined to it by dashed lines. Where the wiki already
      links two of those pages, a solid line joins them — that is what the
      dashes are read against.
- [ ] **Nothing in the diagram is a link.** Hover a box: no page preview
      appears. Ctrl/Cmd-click one: nothing opens. (The labels are escaped for
      this reason — a recommendation to write a page must not look like the
      page.)
- [ ] Ask something the wiki answers well, over pages whose links all resolve.
      That note has **no `## Add next` section at all** — not an empty one.
- [ ] No bullet names a page the wiki already has: check each against
      `## Sources consulted` in the same note, and against the wiki. What this
      catches by hand is a bullet recommending a page you can already open.
      That a synthesis item naming an existing page is dropped — including
      through one of its aliases — is pinned by test instead, because it needs
      the model to name one and nothing here can make it. The `missing:` key
      may still list that page, and that is correct: the key records what the
      answer lacked, the section advises what to write.

**The frontmatter half.** The section is drawn from a list the note also
records, and the two have different jobs.

- [ ] An answer whose synthesis reported something missing carries a `missing:`
      list in its frontmatter, each entry on one line with no `[[brackets]]`.
      An answer that reported nothing carries no such key. Check one of each:
      the second case is the easier one to get, so it is the first that proves
      anything.

**Filing, which is where the section is supposed to disappear.**

- [ ] **File this answer** on the note that named gaps. `## Add next` is gone,
      along with the trace; `missing:` and `## Sources consulted` remain.
- [ ] Run **Compile**. No page appears named after a gap the section listed —
      check `wiki/` for one. (The section names pages that do not exist; kept,
      the next compile would read those names as things the source asserts.)

**The trace, which changed shape.** Its two lists are now written one entry to
a line rather than comma-separated, so a page whose title contains a comma
survives being written down.

- [ ] In a **newly written** answer, `- seeds:` and `- top:` are followed by
      indented `  - [[Name]]` lines rather than one comma-separated line.
- [ ] Open an answer note written **before** this change, if you have one, and
      run **Show retrieval on graph**. It still replays: the old shape is still
      read, and only the writing changed.
- [ ] **Show retrieval on graph** on a new answer lights the same nodes the
      note lists, and reports nothing missing.

### 18. The scrubber and the OpenAI-compatible provider

The newest code. The scrubber
half is free. The provider half needs either an OpenAI-compatible key or a
server running locally, and the last item in it is the only one that costs
anything.

**Rebuild first, before anything below.** `npm run build && npm run
install:vault`, then reload the plugin — see *After a rebuild* in the README. This
section is newer than any build you are likely to have installed, and a stale
one is indistinguishable from a missing feature: the first attempt at this
list reported the slider absent, and the cause was a `main.js` from the
previous evening while the repo's own build was current. Check the timestamp on
`test-vault/.obsidian/plugins/luka/main.js` before you suspect the code.

**The scrubber.** It appears under the status line, never in the toolbar.

- [ ] Click a node. A slider appears beneath the status line, and its label
      reads `iteration N of N` — the last stop, showing exactly the overlay the
      click already produced.
- [ ] Drag it to the far left. The heat is concentrated close to the clicked
      node — on it and its immediate neighbours — and the rest of the graph is
      dark. Do not expect the clicked node itself to be the brightest: stop 1
      is the walk *after* its first step, where a seed has passed most of its
      mass to its neighbours and kept only what teleport returns. On a seed of
      low degree the neighbours are brighter than the seed, and that is
      correct. What the far-left stop shows is reach, not ranking.
- [ ] Drag slowly right. The heat spreads outward along links, and the top-K
      stroke moves between nodes as the ranking settles — it is not pinned to
      the final answer.
- [ ] Return to the rightmost stop. The graph looks exactly as it did before
      you touched the slider.
- [ ] Press Esc. The overlay and the slider go together.
- [ ] Type a question and press **Inspect** on a vault in graph mode. The
      slider appears for that overlay too, and the status line names the
      question rather than a node. *In graph mode* means no **Mode A** banner
      between the toolbar and the status line — the one reading `Mode A
      (lexical) active — graph ranking off`, followed by the counts that say
      why. It appears below either half of the mode predicate: fewer than 20
      nodes, or fewer than 1.5 link pairs per node. No banner means both are
      met, a walk ran, and there are iterations to scrub.
- [ ] Do the same with that banner showing. There is no slider — Mode A ranks
      by keyword and runs no walk to step through — and the overlay has no heat
      ramp either: seeds and lexical top-K light by ring and stroke, at their
      kind colours, with everything else dimmed. Both absences have the same
      cause.
      The banner is easiest to summon from **Settings → Graph mode: minimum
      nodes**, raised above the node count in the status line. That is a
      supported setting, not a trick, and it beats building a throwaway
      vault. Put it back to 20 afterwards.
- [ ] **Show retrieval on graph** on an answer note written in mode B. No
      slider — but note what *is* there: the full heat ramp, the seed ringed,
      the top-K stroked. This is the sharp version of the check, and it is a
      different absence from the one above. Mode A loses the ramp and the
      slider together because it never walked. A trace has scores and no
      iterations, because the note records where retrieval arrived and not how
      it got there — so the overlay is complete and the slider still cannot
      exist.
- [ ] With a slider on screen, press **Refresh**, or compile in another window.
      The overlay clears and the slider goes with it. (Only what is on screen
      is claimed here. A copy can survive out of sight in the double-click
      restore slot, so this item is about the pane, not
      about memory.)
- [ ] Click a node, then drag the slider back to a stop where the picture is
      **visibly different** from the rightmost one. Use stop 1. Do *not* use
      the middle: a walk of 55 iterations was found to look identical at 27 and
      at 55, because the walk settles to the eye long before it settles to
      the convergence threshold of 1e-8. Only the first few stops differ visibly. Leave
      there and press **Export PNG**. Open the file from your Downloads folder
      and compare it against the screen: it should show the stop you left the
      slider on, not the settled walk.
      Worth doing because it is the only item here where two features meet. The
      export re-renders the frame rather than photographing the canvas, so it
      reads the overlay a second time — and a scrubbed overlay is an ordinary
      overlay carrying one iteration's scores. A file showing the converged
      ranking would mean the export found those scores somewhere other than the
      frame on screen.

**The provider.** Switch **Provider** in settings to *OpenAI-compatible*.

- [ ] The Anthropic key field is replaced by an API key field and a **Base
      URL** field. Switching back brings the Anthropic field back.
- [ ] Switch to *OpenAI-compatible* with the five model ids untouched. They
      become OpenAI's: `gpt-4.1-mini` for **inventory** and **seed-selection**,
      `gpt-4.1` for the other three. Switch back and they return to Anthropic's.
      Then edit one by hand — put anything in **synthesis** — and switch again:
      that one keeps what you typed while the rest move around it. Changing
      provider is not a request to discard your work, so the rule is that only
      an id still holding the *outgoing* provider's default is replaced.
      Type that field back to the outgoing default and it starts moving again,
      which is correct: the rule reads values, not edit history, so a field
      holding the default *is* a default whoever put it there.
- [ ] Set an OpenAI-compatible key, switch to Anthropic, set a different key,
      and reload Obsidian. Both are still there: the two do not share a field,
      and neither switching nor reloading clears either one. Both are stored
      because `apiKey` kept its name and gained a sibling rather than being
      renamed: settings migration is a non-goal, and a rename would have
      emptied the key of every vault that already had one.
- [ ] Type a model id the endpoint does not have — `claude-haiku-4-5-20251001`
      does nicely against OpenAI — into **inventory**, and compile **a source
      the manifest has not seen**.
      *(Typed deliberately since model ids started following the provider. It
      was walked when a switch left the old vendor's ids in place, which put
      the same wrong id in the same field; the failure path is identical and
      the tick stands.)* Drop a new file into `raw/` first, or run
      **File this answer** on any answer note — filing needs no provider, so it
      works with the settings already broken, and the note lands in
      `raw/answers/` as an ordinary new source. Either way you need one: on an
      already-compiled vault Compile is a no-op with zero model calls,
      so nothing would fail and the silence would look like this check passing
      when it never ran.
      That source fails, with one notice naming it and carrying the server's
      own complaint. The point is that it **fails loudly rather than appearing
      to work** — whether the text names the model is up to the server, since
      Luka passes the vendor's message through and falls back to a bare `HTTP
      <status>` when the body carries none. Then confirm invariant 3: no page
      for it under `wiki/`, and no entry for it in the manifest, so the next
      compile retries it rather than treating it as done.
- [ ] Two separate runs, changing only the base URL between them. Set it to
      `https://api.openai.com/v1/` — note the trailing slash — and compile;
      then to `https://api.openai.com/v1/chat/completions` and compile again.
      Both must behave exactly as the plain `https://api.openai.com/v1` does:
      Luka appends the endpoint itself, stripping a trailing slash and a
      trailing `/chat/completions` first, so none of the three doubles up.
      These are the two ways it gets typed wrong — the settings placeholder
      shows a root while every API doc shows the full endpoint, so both get
      pasted.
      **Valid model ids are not needed.** The server's error says which thing
      was wrong: a correct path gets you the same model complaint as the check
      above, while a doubled one (`…/v1/chat/completions/chat/completions`)
      gets a different error naming the bad path. Same model error both times
      is the pass. Set the field back to `https://api.openai.com/v1` after.
- [ ] Set the base URL to something that is not a URL at all — `not a url`
      will do. Compile fails immediately, with a notice quoting the value back
      at you and saying it is not a valid http(s) URL. That wording is the
      observable part: it is written before any request is attempted, and it
      is different from every message a server can send, so seeing it *is*
      seeing that nothing was sent. (Do not try to confirm that in DevTools —
      per section 8 above, the network panel cannot see these requests whether they
      happen or not.)
- [ ] Point it at a local server with the key field empty and compile. It
      works: no credential is sent, because none was configured. 
      (Ollama recommended, tested by creator, however results may be weaker with no API)
- [ ] **Paid, optional.** Against OpenAI's own endpoint, compile one small
      source and check the usage page. The token-cap field is chosen by host,
      so an OpenAI run spends no extra request learning it. This is the only
      check on that guess against the real API; the mirror half is covered by
      the local server above, which accepts `max_tokens` as predicted.
