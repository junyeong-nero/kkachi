// A quiet spell ends a review batch, not the user's Pi conversation. Foreground turns take priority.
import { appendFileSync, mkdtempSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "./config";
import { commitAll, git, pull, pushIfAhead, REVIEW_PREFIX } from "./git";
import { scheduleTidy, tidyIdle } from "./librarian";
import { log } from "./log";
import { currentModel, isLimitError, markLimited } from "./models";
import { Pi } from "./pi";

const IDLE_MS = 30 * 60_000;
const pendingFile = join(config.dataDir, "conversation.jsonl");
type TurnRecord = { t: string; user: string; reply: string; saved: string[] };
let timer: ReturnType<typeof setTimeout>, running: Promise<void> | undefined, cancel: AbortController | undefined;

function schedule(ms: number) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    cancel = new AbortController();
    const signal = cancel.signal;
    running = review(signal).catch((err) => {
      if (!signal.aborted) { console.error("review failed; will retry", err); schedule(IDLE_MS); }
    }).finally(() => { running = undefined; cancel = undefined; });
  }, ms);
}

/** Only completed turn handling appends. Stream retransmissions and model retries are not turns. */
export function recordTurn(turn: TurnRecord) {
  appendFileSync(pendingFile, JSON.stringify(turn) + "\n", { mode: 0o600 });
  schedule(IDLE_MS);
}

export function resumeReviews() {
  const file = statSync(pendingFile, { throwIfNoEntry: false }); // last append = last finished turn
  if (file?.size) schedule(Math.max(0, file.mtimeMs + IDLE_MS - Date.now()));
}

export async function cancelReview() {
  clearTimeout(timer);
  cancel?.abort();
  await running;
}

async function inspect(dir: string, model: string, signal: AbortSignal): Promise<string> {
  const pi = new Pi({ prompt: "review.md", mode: "replace", session: "none", reviewWorktree: dir });
  const stop = AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)]);
  let summary = "", settled = false, error = "";
  try {
    stop.throwIfAborted();
    const start = pi.start(model);
    const run = async () => {
      await start;
      stop.throwIfAborted();
      await pi.run(`Review every turn in the private JSONL transcript at ${JSON.stringify(pendingFile)}. Read it in pages if needed. Times are ISO timestamps; interpret them in ${config.timeZone}.`, (e) => {
        if (e.type === "agent_settled") settled = !e.aborted;
        if (e.type !== "message_end" || e.message?.role !== "assistant") return;
        if (e.message.stopReason === "error") error = String(e.message.errorMessage ?? "model error");
        summary = (e.message.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("").trim();
      });
    };
    await Promise.race([run(), pi.exited, new Promise<void>((resolve) => stop.addEventListener("abort", () => resolve(), { once: true }))]);
    stop.throwIfAborted();
    if (error && isLimitError(error)) markLimited(model, error);
    if (error || !settled || !summary) throw new Error(error || "review ended without a final reply");
    return summary.split("\n")[0].trim().slice(0, 72);
  } finally {
    await pi.terminate(); // no worker left writing while the scratch checkout is being removed
  }
}

async function review(signal: AbortSignal) {
  await tidyIdle();
  signal.throwIfAborted();
  const repo = config.memoryDir;
  if (await git(repo, "status", "--porcelain")) throw new Error("memory repo has uncommitted changes");
  await pull(repo);
  const base = await git(repo, "rev-parse", "HEAD");
  signal.throwIfAborted();
  const scratch = mkdtempSync(join(tmpdir(), "kkachi-review-"));
  const dir = join(scratch, "notes");
  let added = false;
  try {
    await git(repo, "worktree", "add", "--quiet", "--detach", dir, base);
    added = true;
    const model = currentModel();
    const line = await inspect(dir, model, signal);
    signal.throwIfAborted();
    await git(dir, "add", "-A");
    const files = (await git(dir, "diff", "--cached", "--name-status", "--no-renames", "-z")).split("\0");
    for (let i = 0; i < files.length - 1; i += 2) {
      const path = files[i + 1];
      if (!["A", "M"].includes(files[i]) || !path.endsWith(".md") || ["AGENTS.md", "README.md"].includes(path)) {
        throw new Error(`review changed a non-note or deleted a file: ${path}`);
      }
    }
    const commit = await commitAll(dir, REVIEW_PREFIX + line);
    if ((await git(repo, "rev-parse", "HEAD")) !== base || await git(repo, "status", "--porcelain")) throw new Error("notes changed during review");
    signal.throwIfAborted();
    // Once publication starts, finish it before letting the next turn use the repo.
    if (commit) await git(repo, "merge", "--ff-only", "--quiet", commit);
    await pushIfAhead(repo);
    rmSync(pendingFile); // a new foreground turn waits for us before it can append
    log("review", { model, commit, notes: (files.length - 1) / 2 });
  } finally {
    if (added) await git(repo, "worktree", "remove", "--force", dir);
    rmSync(scratch, { recursive: true, force: true });
  }
  if (!signal.aborted) scheduleTidy();
}
