// Git operations on the memory repo. The agent has no shell; Kkachi does all git work here.
const COMMIT_PREFIX = "kkachi: ";
export const TIDY_PREFIX = COMMIT_PREFIX + "정리 — ";

export async function git(dir: string, ...args: string[]) {
  const p = Bun.spawn(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err.trim() || out.trim()}`);
  return out.trim();
}

async function hasUpstream(dir: string) {
  try { await git(dir, "rev-parse", "--abbrev-ref", "@{upstream}"); return true; } catch { return false; }
}

export async function pull(dir: string) {
  if (await hasUpstream(dir)) await git(dir, "pull", "--ff-only", "--quiet");
}

// Commit everything as one commit. Returns the short hash, or null if nothing changed.
export async function commitAll(dir: string, subject: string) {
  await git(dir, "add", "-A");
  if (!(await git(dir, "status", "--porcelain"))) return null;
  await git(dir, "commit", "--quiet", "-m", subject);
  return git(dir, "rev-parse", "--short", "HEAD");
}

export const commitTurn = (dir: string, userText: string) =>
  commitAll(dir, COMMIT_PREFIX + (userText.replace(/\s+/g, " ").trim().slice(0, 60) || "update"));

export async function filesIn(dir: string, commit: string) {
  return (await git(dir, "show", "--name-only", "--format=", commit)).split("\n").filter(Boolean);
}

export async function stashLeftovers(dir: string) {
  if (!(await git(dir, "status", "--porcelain"))) return false;
  await git(dir, "stash", "push", "--include-untracked", "--quiet", "-m", `kkachi: leftover changes ${new Date().toISOString()}`);
  return true;
}

export async function pushIfAhead(dir: string) {
  if (!(await hasUpstream(dir))) return;
  if ((await git(dir, "rev-list", "--count", "@{upstream}..HEAD")) !== "0") await git(dir, "push", "--quiet");
}

// Revert the latest conversation commit (skipping librarian tidy commits above it).
// Returns its subject, null if there is nothing to undo, or throws if it no longer reverts cleanly.
export async function undoLast(dir: string) {
  for (const line of (await git(dir, "log", "-20", "--format=%H %s")).split("\n")) {
    const sha = line.slice(0, 40), subject = line.slice(41);
    if (subject.startsWith(TIDY_PREFIX)) continue;
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
