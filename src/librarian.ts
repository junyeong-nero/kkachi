// Background librarian: after a conversation, reorganize the memory repo and rewrite the README
// catalog in a fresh opencode session, then commit and push as one "정리" commit.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";
import { commitAll, git, pushIfAhead, TIDY_PREFIX } from "./git";
import { createSession, prompt, subscribe } from "./opencode";

const stateFile = join(config.dataDir, "librarian.json");
const TIDY_TIMEOUT_MS = 10 * 60_000;
let running: Promise<void> | null = null;
let again = false;

/** Resolves when no tidy is running. Turns wait on this so two agents never edit at once. */
export const idle = () => running ?? Promise.resolve();

export function scheduleTidy() {
  if (running) { again = true; return; }
  running = (async () => {
    do {
      again = false;
      try { await tidy(); } catch (err) { console.error("librarian failed", err); }
    } while (again);
  })().finally(() => (running = null));
}

async function changedSinceLastTidy(): Promise<string[]> {
  const last = existsSync(stateFile) ? (await Bun.file(stateFile).json()).tidiedAt : null;
  const range = last ? [`${last}..HEAD`] : ["--root", "HEAD"];
  try {
    const out = last
      ? await git(config.memoryDir, "diff", "--name-only", ...range, "--", "*.md")
      : await git(config.memoryDir, "ls-files", "*.md");
    return out.split("\n").filter((f) => f && f !== "README.md");
  } catch {
    return (await git(config.memoryDir, "ls-files", "*.md")).split("\n").filter(Boolean);
  }
}

async function tidy() {
  const changed = await changedSinceLastTidy();
  if (!changed.length) return;
  const t0 = Date.now();
  console.log(`librarian: tidying (${changed.length} changed notes)`);

  const sessionId = await createSession("librarian");
  let summary = "";
  let done!: (ok: boolean) => void;
  const finished = new Promise<boolean>((res) => (done = res));
  const close = await subscribe((e) => {
    if (e.data?.sessionID !== sessionId) return;
    if (e.type === "session.text.ended") summary = String(e.data.text ?? "").trim();
    if (e.type === "session.execution.succeeded") done(true);
    if (e.type === "session.execution.failed" || e.type === "session.execution.interrupted") done(false);
  });
  try {
    await prompt(sessionId, `Tidy the memory repo now. Notes changed since the last tidy:\n${changed.map((f) => `- ${f}`).join("\n")}`);
    const ok = await Promise.race([finished, Bun.sleep(TIDY_TIMEOUT_MS).then(() => false)]);
    if (!ok) {
      console.error("librarian: run failed; discarding its changes");
      await git(config.memoryDir, "reset", "--hard", "--quiet");
      await git(config.memoryDir, "clean", "-fdq");
      return;
    }
  } finally {
    close();
  }

  const line = summary.split("\n").find((l) => l.trim())?.trim().slice(0, 80) || "목록 갱신";
  const commit = await commitAll(config.memoryDir, TIDY_PREFIX + line);
  await pushIfAhead(config.memoryDir);
  await Bun.write(stateFile, JSON.stringify({ tidiedAt: await git(config.memoryDir, "rev-parse", "HEAD") }));
  console.log(`librarian: ${commit ? `committed ${commit}` : "no changes"} in ${Math.round((Date.now() - t0) / 1000)}s — ${line}`);
}
