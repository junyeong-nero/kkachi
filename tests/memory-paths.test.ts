// A note named in Korean must be listed and found by its real path. Git quotes such paths
// ("people/\354\227\204\353\247\210.md") unless told not to, and memory_search and memory_list then
// failed on every note with ENOENT.
import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { git } from "../services/memory/git";
import { mdFiles } from "../services/memory/notes";

const dir = mkdtempSync(join(tmpdir(), "kk-paths-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("a note named in Korean comes out as its real path", async () => {
  mkdirSync(join(dir, "people"));
  writeFileSync(join(dir, "people", "엄마.md"), "# 엄마\n");
  writeFileSync(join(dir, "notes.md"), "# notes\n");
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "add", "-A");
  await git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "seed");
  const files = await mdFiles(dir);
  expect(files.sort()).toEqual(["notes.md", "people/엄마.md"]);
  for (const f of files) expect(existsSync(join(dir, f))).toBe(true);
  expect(await git(dir, "show", "--name-only", "--format=", "HEAD")).toContain("people/엄마.md");
});
