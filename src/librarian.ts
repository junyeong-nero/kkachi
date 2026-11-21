// Background librarian: after a conversation, reorganize the memory repo and rewrite the README
// catalog in a fresh, sessionless Pi process, then commit and push as one "정리" commit.
// A new conversation turn always wins: it cancels a running tidy, whose changes are discarded.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";
import { commitAll, git, pushIfAhead, TIDY_PREFIX } from "./git";
import { currentModel, isLimitError, markLimited } from "./models";
import { Pi } from "./pi";

const stateFile = join(config.dataDir, "librarian.json");
const TIDY_TIMEOUT_MS = 10 * 60_000;
let running: Promise<void> | null = null;
let current: Pi | null = null;
let cancelled = false;
let again = false;

export function scheduleTidy() {
  if (running) { again = true; return; }
  cancelled = false;
  running = (async () => {
    do {
      again = false;
      try { await tidy(); } catch (err) { if (!cancelled) console.error("librarian failed", err); }
    } while (again && !cancelled);
  })().finally(() => (running = null));
}

/** Stop a running tidy and discard its changes. Resolves once the repo is clean again. */
export async function cancelTidy() {
  if (!running) return;
  cancelled = true;
  again = false;
  await current?.abort();
  current?.stop();
  await running;
}

async function discard() {
  await git(config.memoryDir, "reset", "--hard", "--quiet");
  await git(config.memoryDir, "clean", "-fdq");
}

async function changedSinceLastTidy(): Promise<string[]> {
  const dir = config.memoryDir;
  const last = existsSync(stateFile) ? (await Bun.file(stateFile).json()).tidiedAt : null;
  try {
    const out = last ? await git(dir, "diff", "--name-only", `${last}..HEAD`, "--", "*.md") : await git(dir, "ls-files", "*.md");
    return out.split("\n").filter((f) => f && f !== "README.md");
  } catch {
    return (await git(dir, "ls-files", "*.md")).split("\n").filter(Boolean);
  }
}

// Commit message from what actually changed, e.g. "이동 1, 병합·삭제 1, 수정 2, 목록 갱신".
async function describeChanges(): Promise<string> {
  await git(config.memoryDir, "add", "-A");
  const lines = (await git(config.memoryDir, "status", "--porcelain")).split("\n").filter(Boolean);
  let moved = 0, deleted = 0, edited = 0, catalog = false;
  for (const l of lines) {
    const code = l.slice(0, 2).trim(), path = l.slice(3);
    if (path === "README.md") catalog = true;
    else if (code.startsWith("R")) moved++;
    else if (code.startsWith("D")) deleted++;
    else edited++;
  }
  const parts = [moved && `이동 ${moved}`, deleted && `병합·삭제 ${deleted}`, edited && `수정 ${edited}`, catalog && "목록 갱신"].filter(Boolean);
  return parts.join(", ") || "목록 갱신";
}

async function tidy() {
  const changed = await changedSinceLastTidy();
  if (!changed.length) return;
  const t0 = Date.now();
  const model = currentModel();
  console.log(`librarian: tidying ${changed.length} changed notes with ${model}`);

  const pi = new Pi({ prompt: "librarian.md", session: "none" });
  current = pi;
  await pi.start(model);
  let error = "";
  try {
    const today = new Date().toLocaleDateString("ko-KR", { timeZone: config.timeZone, dateStyle: "full" });
    const run = pi.run(`Today is ${today}. Tidy the memory repo now. Notes changed since the last tidy:\n${changed.map((f) => `- ${f}`).join("\n")}`, (e) => {
      if (e.type === "message_end" && e.message?.role === "assistant" && e.message.stopReason === "error") error = String(e.message.errorMessage ?? "error");
    });
    const finished = await Promise.race([run.then(() => true), pi.exited.then(() => false), Bun.sleep(TIDY_TIMEOUT_MS).then(() => false)]);
    if (cancelled || !finished || error) {
      console.error(`librarian: ${cancelled ? "cancelled by a new turn" : `run failed (${finished ? error.slice(0, 200) : "timeout"})`}; discarding its changes`);
      if (!cancelled && error && isLimitError(error) && markLimited(model, error)) again = true; // retry on the next model
      await discard();
      return;
    }
    const line = await describeChanges();
    const commit = await commitAll(config.memoryDir, TIDY_PREFIX + line);
    await pushIfAhead(config.memoryDir);
    await Bun.write(stateFile, JSON.stringify({ tidiedAt: await git(config.memoryDir, "rev-parse", "HEAD") }));
    console.log(`librarian: ${commit ? `committed ${commit}` : "no changes"} in ${Math.round((Date.now() - t0) / 1000)}s — ${line}`);
  } finally {
    current = null;
    pi.stop();
  }
}
