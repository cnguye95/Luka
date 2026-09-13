// Filing an answer back as a source.
//
// "Move the note to `raw/answers/<same name>` (on collision, append `-2`,
// `-3`, …), stripping the trace block (keep sources block). Notice: 'Filed.
// Run Compile to integrate.' No auto-compile. The next compile treats it as a
// new source through the normal path — no redundancy gate."
//
// Nothing here teaches compile about answers, and nothing needs to:
// discovery already walks `raw/` recursively and names `raw/answers/` outright,
// and a `.md` source is passthrough. The deliberate asymmetry is which block
// survives. The sources block's links become real graph edges, which is
// how filing densifies the graph rather than just archiving prose. Two blocks
// go: the trace, which is this run's working, and `## Add next`, which names
// pages that do not exist — kept, the next compile's inventory would read
// those names as things a source asserts, and the wiki would grow a page out
// of a recommendation to write one. The `missing:` frontmatter key stays, and
// is the durable form of that signal.
import type { FsAdapter } from "../adapters";
import { decodeUtf8 } from "../hash";
import { basename, dirname, isUnder } from "../paths";
import { parseFrontmatter } from "../yaml";
import { stripTrace } from "./trace";
import { stripGaps } from "./addnext";

export const FILED_ANSWERS_FOLDER = "raw/answers";

/**
 * Moves the note and returns where it landed.
 *
 * Written before the original is removed: a failure part-way leaves the answer
 * where the user can still see it, rather than between two folders. Outside the
 * operation lock — there are no model calls and no compile here, and it ends
 * at a notice.
 */
export async function fileBack(fs: FsAdapter, answerPath: string): Promise<string> {
  const text = decodeUtf8(await fs.read(answerPath));

  // Only an answer note is filed. Everything under `raw/` becomes a source on
  // the next compile, so filing an arbitrary file is a vault edit the user did
  // not ask for.
  const { data } = parseFrontmatter(text);
  if (data["kind"] !== "answer") {
    throw new Error(`${answerPath} is not an answer note`);
  }
  // An answer is filed once. A filed answer is a source like any other, and
  // filing it again renames it `-2`, `-2-2`, … churning the manifest through
  // the rename path every time for no gain. `activeAnswerPath` offers the
  // command on any note whose frontmatter says `kind: answer`, which a filed
  // one still does.
  if (isUnder(answerPath, FILED_ANSWERS_FOLDER)) {
    throw new Error(`${answerPath} is already filed`);
  }

  const filed = `${stripTrace(stripGaps(text))}\n`;
  const target = await freePath(fs, `${FILED_ANSWERS_FOLDER}/${basename(answerPath)}`);

  await fs.mkdir(dirname(target));
  await fs.write(target, filed);
  try {
    await fs.delete(answerPath);
  } catch (error) {
    // Write-then-delete leaves the note in *both* places if the delete fails,
    // and the next compile ingests the copy whatever the user was told. Worse,
    // retrying then lands at `-2`, so the collision suffix — which exists to
    // separate two different answers — silently produces two identical sources,
    // each manifested and each costing a compile's calls. Withdrawing the copy
    // leaves the vault exactly as it was, which is the failure the user can act
    // on. Best effort: if the withdrawal fails too, the original error is
    // still what surfaces, because that is the one the user can do something
    // about.
    await fs.delete(target).catch(() => {});
    throw error;
  }

  return target;
}

/** The suffix idiom: `-2`, `-3`, … on the stem, keeping the extension. */
async function freePath(fs: FsAdapter, wanted: string): Promise<string> {
  if (!(await fs.exists(wanted))) return wanted;
  const dot = wanted.lastIndexOf(".");
  const stem = dot === -1 ? wanted : wanted.slice(0, dot);
  const extension = dot === -1 ? "" : wanted.slice(dot);
  for (let suffix = 2; ; suffix++) {
    const candidate = `${stem}-${suffix}${extension}`;
    if (!(await fs.exists(candidate))) return candidate;
  }
}
