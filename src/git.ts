// Git operations on the memory repo. The agent has no shell; Kkachi does all git work here.
const COMMIT_PREFIX = "kkachi: ";

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

// Commit everything the turn changed as one commit. Returns the short hash, or null if nothing changed.
export async function commitTurn(dir: string, userText: string) {
  await git(dir, "add", "-A");
  if (!(await git(dir, "status", "--porcelain"))) return null;
  const subject = userText.replace(/\s+/g, " ").trim().slice(0, 60) || "update";
  await git(dir, "commit", "--quiet", "-m", COMMIT_PREFIX + subject);
  return git(dir, "rev-parse", "--short", "HEAD");
}

export async function pushIfAhead(dir: string) {
  if (!(await hasUpstream(dir))) return;
  if ((await git(dir, "rev-list", "--count", "@{upstream}..HEAD")) !== "0") await git(dir, "push", "--quiet");
}

// Revert the latest Kkachi commit, if HEAD is one. Returns its subject, or null.
export async function undoLast(dir: string) {
  const subject = await git(dir, "log", "-1", "--format=%s");
  if (!subject.startsWith(COMMIT_PREFIX) || subject.startsWith(COMMIT_PREFIX + "undo")) return null;
  await git(dir, "revert", "--no-edit", "--no-commit", "HEAD");
  await git(dir, "commit", "--quiet", "-m", `${COMMIT_PREFIX}undo "${subject.slice(COMMIT_PREFIX.length)}"`);
  return subject.slice(COMMIT_PREFIX.length);
}
