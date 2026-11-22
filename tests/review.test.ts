import { afterAll, afterEach, beforeAll, expect, jest, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "kkachi-test-"));
const repo = join(root, "memory"), data = join(root, "data"), bare = join(root, "remote");
const journal = join(data, "conversation.jsonl"), marker = join(data, "review-started");
const idle = 30 * 60_000;
let review: typeof import("../src/review"), turns: typeof import("../src/turn"), library: typeof import("../src/librarian");
const env = { KKACHI_MEMORY_DIR: repo, KKACHI_DATA_DIR: data, KKACHI_PI_BIN: join(root, "pi") };
const original = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
function git(cwd: string, ...args: string[]) {
  const p = Bun.spawnSync(["git", ...args], { cwd });
  if (p.exitCode) throw Error(p.stderr.toString());
  return p.stdout.toString().trim();
}
async function until(f: () => boolean) {
  for (let i = 0; i < 250; i++) { if (f()) return; await Bun.sleep(20); }
  throw new Error("timed out waiting for review");
}
function enqueue(user: string) { review.recordTurn({ t: new Date().toISOString(), user, reply: "", saved: [] }); }
function reviewAfterIdle(user: string) {
  jest.useFakeTimers();
  enqueue(user);
  jest.advanceTimersByTime(idle);
  jest.useRealTimers();
}

beforeAll(async () => {
  Object.assign(process.env, env);
  mkdirSync(repo); git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Test"); git(repo, "config", "user.email", "test@example.org");
  writeFileSync(join(repo, "AGENTS.md"), "# Test notes\n");
  git(repo, "add", "."); git(repo, "commit", "-m", "seed");
  git(root, "init", "--bare", bare); git(repo, "remote", "add", "origin", bare); git(repo, "push", "-u", "origin", "main");
  copyFileSync(join(import.meta.dir, "fixtures/review-pi.mjs"), env.KKACHI_PI_BIN); chmodSync(env.KKACHI_PI_BIN, 0o700);
  review = await import("../src/review"); turns = await import("../src/turn"); library = await import("../src/librarian");
});
afterEach(async () => {
  jest.useRealTimers(); await review.cancelReview(); await library.tidyIdle();
  for (const path of [marker, journal, join(data, "hold"), join(data, "invalid")]) rmSync(path, { force: true });
});
afterAll(() => {
  const pid = join(data, "test-pi.pid");
  if (existsSync(pid)) process.kill(Number(readFileSync(pid, "utf8")));
  for (const [k, v] of Object.entries(original)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  rmSync(root, { recursive: true, force: true });
});

test("reset the countdown on the next turn, then commit, push and catalog the missing note", async () => {
  jest.useFakeTimers();
  enqueue("hello"); jest.advanceTimersByTime(idle - 1);
  await turns.runTurn("I prefer green tea", () => {});
  expect(JSON.parse(readFileSync(journal, "utf8").trim().split("\n")[1])).toMatchObject({ user: "I prefer green tea", reply: "answer", saved: [] });
  jest.advanceTimersByTime(idle - 1);
  expect(existsSync(marker)).toBe(false);
  jest.advanceTimersByTime(1); jest.useRealTimers();
  await until(() => existsSync(join(data, "librarian.json")));
  expect(existsSync(journal)).toBe(false);
  expect(git(bare, "log", "--format=%s", "main").split("\n")).toEqual(["kkachi: 정리 — 목록 갱신", "kkachi: 대화 정리 — 차 취향 검토", "seed"]);
  expect(git(bare, "show", "main:tea.md")).toContain("Green tea.");
});

test("an overdue journal survives a restart; a no-op review makes no review commit", async () => {
  const head = git(repo, "rev-parse", "HEAD");
  const last = new Date(Date.now() - idle - 1000);
  writeFileSync(journal, JSON.stringify({ t: last.toISOString(), user: "hello", reply: "hi", saved: [] }) + "\n");
  utimesSync(journal, last, last);
  review.resumeReviews();
  await until(() => existsSync(marker) && !existsSync(journal));
  expect(git(repo, "rev-parse", "HEAD")).toBe(head);
});

test("an interrupted search reaches idle review without a save request; an unchanged note needs no second commit", async () => {
  for (let attempt = 0; attempt < 2; attempt++) {
    jest.useFakeTimers();
    await turns.runTurn("[test 429] find listings", () => {});
    const entry = readFileSync(journal, "utf8");
    expect(JSON.parse(entry).issue).toBe("search_rate_limit");
    expect(entry).not.toContain("private provider detail");
    jest.advanceTimersByTime(idle); jest.useRealTimers();
    await until(() => !existsSync(journal));
    await review.cancelReview(); await library.tidyIdle();
  }
  expect(git(bare, "rev-list", "--count", "main", "--", "search.md")).toBe("1");
});

test("reject edits to repo rules and keep the batch for retry", async () => {
  writeFileSync(join(data, "invalid"), "");
  const head = git(repo, "rev-parse", "HEAD");
  reviewAfterIdle("hello");
  await until(() => existsSync(marker) && !existsSync(readFileSync(marker, "utf8")));
  expect(git(repo, "rev-parse", "HEAD")).toBe(head);
  expect(existsSync(journal)).toBe(true);
  expect(git(repo, "status", "--porcelain")).toBe("");
});

test("a new turn cancels a worker mid-edit, preserves pending turns and leaves user files alone", async () => {
  writeFileSync(join(data, "hold"), "");
  reviewAfterIdle("I prefer green tea");
  await until(() => existsSync(marker));
  const worktree = readFileSync(marker, "utf8"), personal = join(repo, "unrelated.txt");
  expect(worktree).not.toBe(repo);
  writeFileSync(personal, "manual change");
  await review.cancelReview(); // first operation of a foreground turn, before it edits the repo
  expect(readFileSync(personal, "utf8")).toBe("manual change");
  expect(existsSync(worktree)).toBe(false);
  expect(readFileSync(journal, "utf8")).toContain("green tea");
  rmSync(personal);
});
