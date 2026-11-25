// Background librarian: after a conversation, reorganize the memory repo and rewrite the README
// catalog in a fresh, sessionless Pi process, then commit and push as one "정리" commit.
// A new conversation turn always wins: it cancels a running tidy, whose changes are discarded.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";
import { memory } from "./memory";
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

/** Resolves when no tidy is running (the conversation review waits for it, so they never overlap). */
export const tidyIdle = () => running ?? Promise.resolve();

/** Run a tidy now and wait for it (used after importing notes: `bun -e 'import("./src/librarian").then(m => m.tidyNow())'`). */
export async function tidyNow() {
  scheduleTidy();
  await running;
}

/** Stop a running tidy and discard its changes. Resolves once the repo is clean again; true if one was running. */
export async function cancelTidy() {
  if (!running) return false;
  cancelled = true;
  again = false;
  await current?.abort();
  current?.stop();
  await running;
  return true;
}

const discard = () => memory.discard();

async function changedSinceLastTidy(): Promise<string[]> {
  const last = existsSync(stateFile) ? (await Bun.file(stateFile).json()).tidiedAt : undefined;
  return (await memory.changes(last)).filter((f) => f !== "README.md");
}

// Commit message from what actually changed, e.g. "이동 1, 병합·삭제 1, 수정 2, 목록 갱신".
async function describeChanges(): Promise<string> {
  let moved = 0, deleted = 0, edited = 0, catalog = false;
  for (const { code, path } of await memory.staged()) {
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

  const pi = new Pi({ prompt: "librarian.md", mode: "replace", session: "none", mcp: "librarian" });
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
    const { commit } = await memory.checkpoint("tidy", line);
    await Bun.write(stateFile, JSON.stringify({ tidiedAt: await memory.head() }));
    console.log(`librarian: ${commit ? `committed ${commit}` : "no changes"} in ${Math.round((Date.now() - t0) / 1000)}s — ${line}`);
  } finally {
    current = null;
    pi.stop();
  }
}
