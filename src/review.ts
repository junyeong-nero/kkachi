// A quiet spell ends a review batch, not the user's Pi conversation. Foreground turns take priority.
import { appendFileSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";
import { memory } from "./memory";
import { scheduleTidy, tidyIdle } from "./librarian";
import { log } from "./log";
import { currentModel, isLimitError, markLimited } from "./models";
import { Pi } from "./pi";

const IDLE_MS = 30 * 60_000;
const pendingFile = join(config.dataDir, "conversation.jsonl");
export type ReviewIssue = "search_rate_limit";
type TurnRecord = { t: string; user: string; reply: string; saved: string[]; issue?: ReviewIssue };
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
  // A draft (isolated checkout) from the memory service: a new turn just throws it away.
  const draft = await memory.draftOpen();
  try {
    signal.throwIfAborted();
    const model = currentModel();
    const line = await inspect(draft.path, model, signal);
    signal.throwIfAborted();
    // Publishing accepts only new or changed notes, and only if the repo has not moved meanwhile.
    const { commit, notes } = await memory.draftPublish(draft.path, "review", line);
    rmSync(pendingFile); // a new foreground turn waits for us before it can append
    log("review", { model, commit, notes });
  } finally {
    await memory.draftClose(draft.path);
  }
  if (!signal.aborted) scheduleTidy();
}
