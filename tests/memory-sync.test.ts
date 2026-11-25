import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pull, pushIfAhead } from "../services/memory/git";

const root = mkdtempSync(join(tmpdir(), "kk-sync-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const git = (dir: string, ...args: string[]) => {
  const p = Bun.spawnSync(["git", "-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args]);
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${p.stderr}`);
  return p.stdout.toString().trim();
};
const commit = (dir: string, name: string) => { writeFileSync(join(dir, name), name); git(dir, "add", "-A"); git(dir, "commit", "-qm", name); };

test("notes reach the remote only when sync is on, even with an upstream set", async () => {
  const remote = join(root, "remote.git"), notes = join(root, "notes"), other = join(root, "other");
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  git(root, "init", "-q", "-b", "main", notes);
  commit(notes, "a.md");
  git(notes, "remote", "add", "origin", remote);
  git(notes, "push", "-q", "-u", "origin", "main");
  commit(notes, "b.md");

  delete process.env.KKACHI_MEMORY_SYNC;
  await pushIfAhead(notes);
  expect(git(remote, "rev-parse", "main")).not.toBe(git(notes, "rev-parse", "HEAD")); // stayed here

  // a change made elsewhere is not pulled either
  git(root, "clone", "-q", remote, other);
  commit(other, "c.md");
  git(other, "push", "-q");
  git(notes, "reset", "-q", "--hard", "origin/main"); // line up with the remote so a pull could fast-forward
  await pull(notes);
  expect(git(notes, "rev-parse", "HEAD")).not.toBe(git(remote, "rev-parse", "main"));

  process.env.KKACHI_MEMORY_SYNC = "1";
  await pull(notes);
  expect(git(notes, "rev-parse", "HEAD")).toBe(git(remote, "rev-parse", "main"));
  commit(notes, "d.md");
  await pushIfAhead(notes);
  expect(git(remote, "rev-parse", "main")).toBe(git(notes, "rev-parse", "HEAD"));
  delete process.env.KKACHI_MEMORY_SYNC;
});
