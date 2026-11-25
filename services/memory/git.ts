// Git on the memory repo. Only the memory service runs git; one operation at a time (locked()).
// Commit messages say who made them: a turn "kkachi: <what was said>", the librarian
// "kkachi: 정리 — …", the idle review "kkachi: 대화 정리 — …", an undo "kkachi: undo "…"".
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const COMMIT_PREFIX = "kkachi: ";
const TIDY_PREFIX = COMMIT_PREFIX + "정리 — ";
const REVIEW_PREFIX = COMMIT_PREFIX + "대화 정리 — ";
export type Kind = "change" | "tidy" | "review";
export const message = (kind: Kind, summary: string) =>
  ({ change: COMMIT_PREFIX, tidy: TIDY_PREFIX, review: REVIEW_PREFIX })[kind] + (summary.replace(/\s+/g, " ").trim().slice(0, 60) || "update");

let chain: Promise<unknown> = Promise.resolve();
/** Run fn after every git operation already queued: git itself refuses two at once (index.lock). */
export function locked<T>(fn: () => Promise<T>): Promise<T> {
  const p = chain.then(fn);
  chain = p.catch(() => {});
  return p;
}

// core.quotePath=false: paths come out as they are. Git otherwise writes a note named in Korean as
// "people/\354\227\204\353\247\210.md" (quoted, octal), which is no file, so search and list broke on it.
export async function git(dir: string, ...args: string[]) {
  const p = Bun.spawn(["git", "-c", "core.quotePath=false", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err.trim() || out.trim()}`);
  return out.trim();
}

// Notes stay on this computer. Kkachi pulls before a turn and pushes after a commit only when the
// user turns sync on (KKACHI_MEMORY_SYNC=1) and the repo has an upstream; a remote alone is not
// enough, so someone who backs up by pushing now and then is never synced behind their back.
export const syncOn = () => /^(1|true|on|yes)$/i.test(process.env.KKACHI_MEMORY_SYNC ?? "");

async function hasUpstream(dir: string) {
  try { await git(dir, "rev-parse", "--abbrev-ref", "@{upstream}"); return true; } catch { return false; }
}

export async function pull(dir: string) {
  if (syncOn() && await hasUpstream(dir)) await git(dir, "pull", "--ff-only", "--quiet");
}

export async function pushIfAhead(dir: string) {
  if (!syncOn() || !(await hasUpstream(dir))) return;
  if ((await git(dir, "rev-list", "--count", "@{upstream}..HEAD")) !== "0") await git(dir, "push", "--quiet");
}

/** Commit everything as one commit. Returns the short hash, or null if nothing changed. */
export async function commitAll(dir: string, subject: string) {
  await git(dir, "add", "-A");
  if (!(await git(dir, "status", "--porcelain"))) return null;
  await git(dir, "commit", "--quiet", "-m", subject);
  return git(dir, "rev-parse", "--short", "HEAD");
}

/** Commit only these paths, leaving anything else being edited (a turn in progress) alone. */
export async function commitPaths(dir: string, subject: string, paths: string[]) {
  if (!paths.length) return null;
  await git(dir, "add", "-A", "--", ...paths);
  if (!(await git(dir, "status", "--porcelain", "--", ...paths))) return null;
  await git(dir, "commit", "--quiet", "-m", subject, "--only", "--", ...paths);
  return git(dir, "rev-parse", "--short", "HEAD");
}

export async function filesIn(dir: string, commit: string) {
  return (await git(dir, "show", "--name-only", "--format=", commit)).split("\n").filter(Boolean);
}

export async function stashLeftovers(dir: string) {
  if (!(await git(dir, "status", "--porcelain"))) return false;
  await git(dir, "stash", "push", "--include-untracked", "--quiet", "-m", `kkachi: leftover changes ${new Date().toISOString()}`);
  return true;
}

// Revert the latest conversation commit (skipping background tidy and review commits above it).
// Returns its subject, null if there is nothing to undo, or throws if it no longer reverts cleanly.
export async function undoLast(dir: string) {
  for (const line of (await git(dir, "log", "-20", "--format=%H %s")).split("\n")) {
    const sha = line.slice(0, 40), subject = line.slice(41);
    if (subject.startsWith(TIDY_PREFIX) || subject.startsWith(REVIEW_PREFIX)) continue;
    if (!subject.startsWith(COMMIT_PREFIX) || subject.startsWith(COMMIT_PREFIX + "undo")) return null;
    try {
      await git(dir, "revert", "--no-edit", "--no-commit", sha);
    } catch {
      await git(dir, "revert", "--abort").catch(() => git(dir, "reset", "--hard", "--quiet"));
      throw new Error("The change was reorganized by the librarian since, so it cannot be reverted automatically. Edit the note instead.");
    }
    await git(dir, "commit", "--quiet", "-m", `${COMMIT_PREFIX}undo "${subject.slice(COMMIT_PREFIX.length)}"`);
    return subject.slice(COMMIT_PREFIX.length);
  }
  return null;
}

// ---- drafts: an isolated checkout (git worktree) to work in, published only if the repo did not
// move meanwhile. The idle review edits a draft so a new turn can simply throw it away. ----
const drafts = new Map<string, { scratch: string; base: string }>();

export async function draftOpen(repo: string) {
  if (await git(repo, "status", "--porcelain")) throw new Error("memory repo has uncommitted changes");
  await pull(repo);
  const base = await git(repo, "rev-parse", "HEAD");
  const scratch = mkdtempSync(join(tmpdir(), "kkachi-draft-"));
  const dir = join(scratch, "notes");
  await git(repo, "worktree", "add", "--quiet", "--detach", dir, base);
  drafts.set(dir, { scratch, base });
  return { path: dir, base };
}

/** Commit the draft and fast-forward the repo to it. Only new or changed notes are accepted. */
export async function draftPublish(repo: string, dir: string, subject: string) {
  const draft = drafts.get(dir);
  if (!draft) throw new Error("no such draft");
  await git(dir, "add", "-A");
  const files = (await git(dir, "diff", "--cached", "--name-status", "--no-renames", "-z")).split("\0");
  for (let i = 0; i < files.length - 1; i += 2) {
    const path = files[i + 1];
    if (!["A", "M"].includes(files[i]) || !path.endsWith(".md") || ["AGENTS.md", "README.md"].includes(path)) {
      throw new Error(`draft changed a non-note or deleted a file: ${path}`);
    }
  }
  const commit = await commitAll(dir, subject);
  if ((await git(repo, "rev-parse", "HEAD")) !== draft.base || await git(repo, "status", "--porcelain")) throw new Error("notes changed meanwhile");
  if (commit) await git(repo, "merge", "--ff-only", "--quiet", commit);
  await pushIfAhead(repo);
  return { commit, notes: (files.length - 1) / 2 };
}

export async function draftClose(repo: string, dir: string) {
  const draft = drafts.get(dir);
  if (!draft) return;
  drafts.delete(dir);
  await git(repo, "worktree", "remove", "--force", dir).catch(() => {});
  rmSync(draft.scratch, { recursive: true, force: true });
}
