// Derivative custody: carrying a renamed source's markdown to where its new
// path expects it, and sweeping the markdown a departed source left behind.
//
// ─────────────────────────────────────────────────────────────────────────────
// DESIGN INVARIANTS
//
// This subsystem's own list, numbered in roman and cited elsewhere as
// `rename invariant V`. It is separate from the twelve numbered invariants
// in design_decisions.md, which are cited in arabic as `invariant 7`.
//
// The first version of this subsystem was functionally correct and took five
// review rounds, because each round's fix added another compensation and the
// compensations interacted.
// This list is what a fix is checked against. A reviewer-found bug is fixed at
// this level; if no invariant covers it, the list is incomplete and gets
// extended deliberately, in the same commit — never patched where it surfaced
// by adding one more mechanism.
//
//  (I)   SINGLE COMMIT POINT. The manifest is written once, at the end,
//        entirely from completed outcomes. No earlier phase mutates it.
//        Failure recovery is always "the untouched entry re-presents the work"
//        — never a withdrawal, a restore, or a rollback.
//
//  (II)  OWNERSHIP IS RECORDED, NEVER INFERRED. The manifest entry names the
//        derivative. `derived-from` is read only as a guard — before a
//        destructive write, before serving a file as a source's content, or to
//        ask whether the file an entry names is still that source's — never to
//        locate a file.
//        One exception, deliberate and narrow: when the entry's file is gone
//        and a rename has to decide whether markdown at the destination is the
//        same file the user moved, `carryOne` computes `<stem>.md` and reads
//        the origin there. Nothing else may. It is the price of letting a user
//        move a source and its markdown together (design_decisions.md, decision
//        6), and it can only ever adopt a file naming the source's own
//        old path. It is not *reported* at runtime: the carry succeeded and
//        nothing was lost, so there is nothing to tell the user.
//        VII neither widens nor narrows this: the carve-out fires only when the
//        entry's file is *gone*, and a float exists only while it is intact.
//
//  (III) NO DESTRUCTIVE OPERATION IS EVER A FAILURE-RECOVERY STEP. Deletes and
//        overwrites happen only to complete an outcome that succeeded, always
//        behind the guard. Nothing is removed to get *out* of a bad state.
//        Note what this does not say: a failure may still lead to a successful
//        outcome that then removes something — a carry that cannot complete
//        falls back to re-extraction, and the re-extraction's own success is
//        what sweeps the file it replaced. The rule is about what authorises
//        the delete, not about what preceded it.
//
//  (IV)  EVERY PHASE BEFORE THE MANIFEST WRITE IS IDEMPOTENT — up to the
//        location of the derivative. A crashed or failed run re-runs to the
//        same *manifest* state, which is the state that matters, because the
//        manifest was never written. This is why the carry repoints before it
//        moves, and why the guard accepts either end of a rename at the
//        location the entry records: both failure windows re-run to a carry.
//        The one window that does not is between the move and the commit: the
//        file is then at the destination naming the new path, which is
//        indistinguishable from an earlier occupant's markdown, so the retry
//        re-extracts. That costs a model call and a hand repair, never the
//        source. It is the one place this list is a "so far as it can" and not
//        an absolute, and it is logged as such.
//        A crash is not the only way in. Anything that ends a run after the
//        carry without committing reaches it, so nothing in a *completed* run
//        may withhold a carried rename's entry — an earlier fix did exactly
//        that for a blocked page and turned this window into a routine
//        outcome. Whatever the carry completed, the commit records.
//        A float never opens that window at all: repointing in place is the
//        whole operation, so a floated carry re-runs to an identical no-op.
//        The window belongs to the move path alone.
//
//  (V)   CLASSIFICATION HAPPENS ONCE. The four rules and rename identity are
//        decided at discovery, against the vault as this run found it. Carry
//        outcomes are decided here, in one deterministic pass before any
//        extraction begins — dependency first, so a rename vacating a location
//        is decided before the one that wants it, with the new path's order as
//        the tiebreak. Each rename is decided exactly once either way.
//        Since VII, mis-ordering costs a float rather than a re-extraction, so
//        the pass buys tidiness rather than correctness: a resolvable chain
//        lands at `<stem>.md`, and only a true cycle floats.
//
//  (VII) THE POINTER IS THE ADDRESS; `<stem>.md` IS A PREFERENCE. The rule is
//        where a normalization *writes* — `<original-stem>.md` beside the
//        original — not where a derivative must forever live afterwards
//        (design_decisions.md, decision 7). A carry whose target is occupied
//        leaves the file where the entry already says it is, repoints it there
//        and records that location: a float. No reader may treat `<stem>.md` as
//        where a derivative *is*.
//        Floats decay rather than accumulating machinery. Normalization still
//        prefers the canonical path, so a floated source lands back home the
//        next time it is extracted with the stem free, and a carry moves it
//        home the next time it is renamed with the stem free. Nothing hunts for
//        floats to re-home on an unchanged vault — that would write where the
//        four rules require zero writes.
//
//  (VI)  READABLE MARKDOWN IS LOOKED UP, NEVER RECONSTRUCTED. A source's body
//        comes from this run's outcomes, or else from the file its entry names.
//        "This run's outcomes" is BOTH kinds: every source whose normalization
//        completed — a later failure of that source's own inventory or pages
//        does not un-write what it produced — and every rename whose carry
//        completed, which produces markdown at a known path without normalizing
//        at all. Leaving the second kind out is how a renamed source became
//        unreadable to Call B while its own citation block already named it.
//        And a recorded pointer counts only while the file standing at it still
//        names this source: the entry says which file, never that it is still
//        ours, because a user can overwrite one in place.
// ─────────────────────────────────────────────────────────────────────────────
//
// The failure policy is deliberately blunt (policy B): the happy paths carry a
// derivative at zero model calls, and ANY complication falls back to plain
// re-extraction and says so. There are no retry state machines and no attempts
// to preserve a repair through a failure — those are what bred the first
// version's defects.
//
// A float is not a complication. An occupied destination used to be one, and
// cost a model call and often a repair; under VII it costs nothing at all, so
// it is a happy path and reports nothing. What still falls back is a carry that
// cannot write: no pointer to follow, or a repoint that fails.
import type { FsAdapter } from "../adapters";
import { decodeUtf8 } from "../hash";
import { derivativeOrigin, derivativePathFor } from "../normalize/index";
import { comparePaths } from "../paths";
import type { IngestManifest } from "../types";
import { replaceFrontmatterValue } from "../yaml";
import type { Rename } from "./discover";

/** Something a compile did not do, named so the user is not left guessing. */
export interface Report {
  path: string;
  reason: string;
}

/**
 * What this run owes a rename, decided in one pass before extraction (V).
 *
 * `carried` means the derivative is at `derivative` and the source needs no
 * work — the rename shortcut, zero model calls. `fallback` means the source
 * joins the normalize worklist: nothing was taken from the vault to arrange it,
 * and the reason is reported.
 */
export type CarryOutcome =
  | { rename: Rename; kind: "carried"; derivative: string | undefined }
  | { rename: Rename; kind: "fallback"; reason: string };

export interface CarryResult {
  outcomes: CarryOutcome[];
  wrote: boolean;
}

/**
 * Points every renamed source's derivative at its new path, moving the file
 * when the new path expects it elsewhere.
 *
 * **Repoint first, then move.** The old entry records where the file is, so
 * repointing in place keeps that record true no matter what happens next: a
 * failed move leaves a file that is exactly where the manifest says, naming the
 * new path, and re-running finishes the job. Moving first would leave a file
 * the entry no longer locates, which once forced a rollback — and a
 * rollback that itself fails needs a third recovery, which is how that spiral
 * started. Here no failure needs undoing, so nothing has to be undone (III).
 */
export async function carryRenames(
  fs: FsAdapter,
  manifest: IngestManifest,
  renames: readonly Rename[],
): Promise<CarryResult> {
  const ordered = [...renames].sort((a, b) => comparePaths(a.source.path, b.source.path));

  // Which rename's markdown currently sits at each location. A rename that is
  // *vacating* the place another one wants goes first: until it moves, the
  // other sees the destination occupied and floats instead of landing at
  // `<stem>.md`. Floating is correct and costs nothing, but a derivative that
  // sits where its source's name says it should is easier for a user to find,
  // so a resolvable chain is resolved rather than left to drift (V: one pass,
  // and its outcome must not depend on unrelated names).
  const occupies = new Map<string, Rename>();
  for (const rename of ordered) {
    const recorded = manifest[rename.from]?.derivative;
    if (recorded !== undefined && !occupies.has(recorded)) occupies.set(recorded, rename);
  }

  const results = new Map<string, CarryOutcome>();
  let wrote = false;

  const carry = async (rename: Rename, pending: Set<string>): Promise<void> => {
    const to = rename.source.path;
    if (results.has(to) || pending.has(to)) return;
    pending.add(to);

    const target = derivativePathFor(to, rename.source.format);
    if (target !== null) {
      // Free the destination first. Two renames each wanting the other's
      // location leave `pending` set, so the recursion stops and both are
      // decided against the vault as it stands — which for a straight swap
      // means both float: each keeps the markdown it already has, repointed at
      // its new source. Zero model calls, nothing moved, nothing lost. A swap
      // has nowhere to park a file mid-move, and with VII it does not need
      // one.
      const blocker = occupies.get(target);
      if (blocker !== undefined && blocker.source.path !== to) await carry(blocker, pending);
    }

    const outcome = await carryOne(fs, manifest, rename, target);
    if (outcome.wrote) wrote = true;
    results.set(to, outcome.outcome);
  };

  for (const rename of ordered) await carry(rename, new Set());

  return {
    outcomes: ordered.map((rename) => results.get(rename.source.path) as CarryOutcome),
    wrote,
  };
}

/**
 * One rename's outcome, decided against the vault as it stands.
 *
 * The entry's own file takes precedence over anything else on disk. That is the
 * whole point of recording ownership: markdown found by computing `<stem>.md`
 * is a guess, and a guess must never outrank the pointer — the entry says which
 * file is this source's, and a second file naming the same origin is a copy
 * whose age nothing can establish.
 */
async function carryOne(
  fs: FsAdapter,
  manifest: IngestManifest,
  rename: Rename,
  target: string | null,
): Promise<{ outcome: CarryOutcome; wrote: boolean }> {
  const to = rename.source.path;
  const recorded = manifest[rename.from]?.derivative;
  let wrote = false;

  // A passthrough source is its own readable markdown: nothing to carry, and
  // nothing to record.
  if (target === null) {
    return { outcome: { rename, kind: "carried", derivative: undefined }, wrote };
  }

  try {
    // With no pointer there is nothing to carry. Computing `<stem>.md` and
    // adopting whatever answers to it is the inference rename invariant II
    // removes — the fallback re-extracts instead, which needs no guess.
    if (recorded !== undefined) {
      if (await isOurs(fs, recorded, rename, recorded)) {
        // Already where the new path wants it: an extension-only rename never
        // moves its file, and neither does a run that got this far before.
        if (recorded === target) {
          if (await repointDerivative(fs, target, to)) wrote = true;
          return { outcome: { rename, kind: "carried", derivative: target }, wrote };
        }
        if (!(await fs.exists(target))) {
          if (await repointDerivative(fs, recorded, to)) wrote = true;
          await fs.move(recorded, target);
          return { outcome: { rename, kind: "carried", derivative: target }, wrote: true };
        }
        // The destination holds something the entry does not name — so the
        // markdown stays exactly where it is and the entry keeps saying so.
        // A float (VII): `<stem>.md` is where a normalization *writes*, not
        // where a derivative has to live, and the pointer is the address. The
        // occupant is not read, not judged and not touched; there is no
        // second candidate here, because the entry already named the first.
        if (await repointDerivative(fs, recorded, to)) wrote = true;
        return { outcome: { rename, kind: "carried", derivative: recorded }, wrote };
      } else if (
        !(await fs.exists(recorded)) &&
        (await isOurs(fs, target, rename, recorded))
      ) {
        // The entry's file is gone and markdown naming this source's old path
        // stands where the new path expects it: the user moved the source and
        // its markdown together, which is the one case worth reading from disk.
        if (await repointDerivative(fs, target, to)) wrote = true;
        return { outcome: { rename, kind: "carried", derivative: target }, wrote };
      }
    }
  } catch (error) {
    return {
      outcome: {
        rename,
        kind: "fallback",
        reason: `could not carry the markdown of ${rename.from} to ${to} — ${describe(
          error,
        )}; re-extracted instead`,
      },
      wrote,
    };
  }

  return {
    outcome: {
      rename,
      kind: "fallback",
      reason:
        recorded === undefined
          ? `no markdown was recorded for ${rename.from}, so ${to} was re-extracted`
          : `${recorded} could not be carried to ${target} for ${to}, so it was re-extracted`,
    },
    wrote,
  };
}

/**
 * Whether the file at `path` is this rename's derivative to act on.
 *
 * At the location the entry records — wherever that is, which since VII need
 * not be `<stem>.md`, and nothing here cares — either end of the rename counts:
 * `from` is the untouched case, and `to` is a previous run that repointed and
 * could not finish, which must re-run to the same state (IV).
 *
 * Anywhere else, only `from` counts. A file already naming `to` at a path the
 * entry does not record was written for an earlier occupant — the source
 * arrived at `to` only just now, which is what made it an addition to pair —
 * so adopting it would hand this source a description of a different document.
 */
async function isOurs(
  fs: FsAdapter,
  path: string,
  rename: Rename,
  recorded: string | undefined,
): Promise<boolean> {
  const origin = await derivativeOrigin(fs, path);
  if (origin === null) return false;
  if (path === recorded) return origin === rename.from || origin === rename.source.path;
  return origin === rename.from;
}

/**
 * Removes the file the old entry recorded, once the rename has been settled
 * some other way and that file is not the settlement.
 *
 * Forward completion, not recovery (III): it runs only for a rename that
 * finished — carried into a different file, or re-extracted successfully — and
 * only behind the guard. A file that is not ours is left where it is and named
 * in the report, because retrying cannot change whose it is.
 */
export async function removeSupersededDerivative(
  fs: FsAdapter,
  rename: Rename,
  recorded: string | undefined,
  settled: string | undefined,
  claimed: ReadonlySet<string>,
): Promise<{ deleted: boolean; report: Report | null }> {
  if (recorded === undefined || recorded === settled) return { deleted: false, report: null };
  // Another outcome in this run records that very path as its own markdown, so
  // it is not a leftover — saying anything about it would be a notice with
  // nothing behind it.
  if (claimed.has(recorded)) return { deleted: false, report: null };

  const failure = (reason: string): { deleted: boolean; report: Report | null } => ({
    deleted: false,
    report: { path: rename.source.path, reason },
  });

  try {
    if (!(await fs.exists(recorded))) return { deleted: false, report: null };
    if (!(await isOurs(fs, recorded, rename, recorded))) {
      return failure(
        `left ${recorded} alone — it is no longer markdown Luka wrote for ${rename.from}`,
      );
    }
    await fs.delete(recorded);
    return { deleted: true, report: null };
  } catch (error) {
    // This runs at the commit point, after the model calls are spent and the
    // pages are written. Letting it throw would abandon all of that and re-spend
    // it next run, so an unreadable vault costs one notice instead.
    return failure(`could not remove ${recorded}, left over from ${rename.from} — ${describe(error)}`);
  }
}

export interface SweepResult {
  /** Files removed from `raw/`, for the completion notice. */
  deleted: number;
  /** Departed sources whose derivative could not be removed, and why. */
  blocked: Report[];
  /** Files left alone because they are not Luka's, named so the user knows. */
  reported: Report[];
}

/**
 * Removes the markdown of sources that left the vault.
 *
 * The entry names the file, so there is no candidate to compute and no stem to
 * collide (II). One guard stands before the delete: the file must still name
 * the departed source. When it does not, it is left alone and reported — and
 * the entry is dropped anyway, because retrying cannot change whose the file is
 * and re-presenting the deletion every compile would only repeat the notice.
 */
export async function sweepDeparted(
  fs: FsAdapter,
  manifest: IngestManifest,
  departed: readonly string[],
): Promise<SweepResult> {
  const result: SweepResult = { deleted: 0, blocked: [], reported: [] };

  for (const path of [...departed].sort(comparePaths)) {
    const derivative = manifest[path]?.derivative;
    // A passthrough source left no markdown behind, and neither did an entry
    // written before ownership was recorded.
    if (derivative === undefined) continue;

    try {
      // Already gone — the user removed it with the source, most likely.
      // Nothing owed, and nothing worth saying.
      if (!(await fs.exists(derivative))) continue;

      if ((await derivativeOrigin(fs, derivative)) !== path) {
        result.reported.push({
          path,
          reason: `left ${derivative} alone — it is no longer markdown Luka wrote for ${path}`,
        });
        continue;
      }

      await fs.delete(derivative);
      result.deleted += 1;
    } catch (error) {
      result.blocked.push({
        path,
        reason: `could not delete ${derivative} — ${describe(error)}`,
      });
    }
  }

  return result;
}

/**
 * Points a derivative at its source's new path, touching only that one line,
 * and reports whether anything was written.
 *
 * A user may have repaired this file by hand, so the rest of their
 * frontmatter — comments, key order, scalar styles — is left alone; a full
 * re-serialize would restyle all of it for the sake of one value.
 */
async function repointDerivative(fs: FsAdapter, path: string, to: string): Promise<boolean> {
  const text = decodeUtf8(await fs.read(path));
  const rewritten = replaceFrontmatterValue(text, "derived-from", to);
  // `null` means the key could not be rewritten safely — a nested key of the
  // same name, a folded value, a quoted key. Treating that as success would
  // leave the file naming a path that no longer exists, which fails the source
  // on every later run; falling back to re-extraction is the honest answer.
  if (rewritten === null) throw new Error(`could not repoint derived-from in ${path}`);
  if (rewritten === text) return false;
  await fs.write(path, rewritten);
  return true;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
