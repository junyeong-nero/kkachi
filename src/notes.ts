// Structural note operations for the agents (pi/kkachi.ts, src/memory-mcp.ts): move and delete, with link repair.
// Paths are repo-relative. Everything is a git operation, so any change can be reverted.
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path/posix"; // git paths use "/", also on Windows
import { git } from "./git";

const PROTECTED = new Set(["AGENTS.md", "README.md", "vocabulary.md", ".gitignore"]);

export function clean(dir: string, p: string): string {
  const rel = normalize(p.replace(/^\/+/, "").replace(/^\.\//, "")).replace(/\/+$/, "");
  if (!rel || rel === "." || rel.startsWith("..") || rel.startsWith(".git")) throw new Error(`invalid path: ${p}`);
  if (relative(dir, join(dir, rel)).startsWith("..")) throw new Error(`path leaves the repo: ${p}`);
  return rel;
}

export async function mdFiles(dir: string) {
  return (await git(dir, "ls-files", "--cached", "--others", "--exclude-standard", "*.md")).split("\n").filter(Boolean);
}

// Rewrite relative Markdown links in every note so they follow moved files.
// `moved` maps old repo-relative path -> new path for each moved file.
async function repairLinks(dir: string, moved: Map<string, string>) {
  const back = new Map([...moved].map(([o, n]) => [n, o]));
  const touched: string[] = [];
  for (const file of await mdFiles(dir)) {
    const oldSelf = back.get(file) ?? file; // where this file lived when its links were written
    const text = await Bun.file(join(dir, file)).text();
    const out = text.replace(/\]\(([^)\s#]+\.md)(#[^)\s]*)?\)/g, (m, link: string, hash = "") => {
      if (/^[a-z]+:/i.test(link) || link.startsWith("/")) return m;
      const target = normalize(join(dirname(oldSelf), link));
      const newTarget = moved.get(target) ?? target;
      if (newTarget === target && oldSelf === file) return m;
      return `](${relative(dirname(file), newTarget) || "."}${hash})`;
    });
    if (out !== text) { await Bun.write(join(dir, file), out); touched.push(file); }
  }
  return touched;
}

export async function moveNote(dir: string, fromArg: string, toArg: string) {
  const from = clean(dir, fromArg), to = clean(dir, toArg);
  if (PROTECTED.has(from)) throw new Error(`${from} cannot be moved`);
  if (!existsSync(join(dir, from))) throw new Error(`not found: ${from}`);
  if (existsSync(join(dir, to))) throw new Error(`already exists: ${to}`);
  const isDir = statSync(join(dir, from)).isDirectory();
  if (!isDir && !to.endsWith(".md")) throw new Error("a note path must end with .md");

  const moved = new Map<string, string>();
  for (const f of await mdFiles(dir)) {
    if (f === from) moved.set(f, to);
    else if (isDir && f.startsWith(from + "/")) moved.set(f, to + f.slice(from.length));
  }
  await git(dir, "add", "-A", "--", from); // untracked notes must be tracked before git mv
  mkdirSync(dirname(join(dir, to)), { recursive: true });
  await git(dir, "mv", from, to);
  const touched = await repairLinks(dir, moved);
  return `Moved ${from} -> ${to}.` + (touched.length ? ` Fixed links in: ${touched.join(", ")}.` : "");
}

export async function deleteNote(dir: string, pathArg: string) {
  const path = clean(dir, pathArg);
  if (PROTECTED.has(path) || !path.endsWith(".md")) throw new Error(`${path} cannot be deleted`);
  if (!existsSync(join(dir, path))) throw new Error(`not found: ${path}`);
  await git(dir, "add", "-A", "--", path);
  await git(dir, "rm", "--quiet", "--force", path);
  const linking: string[] = [];
  for (const f of await mdFiles(dir)) {
    const text = await Bun.file(join(dir, f)).text();
    for (const [, link] of text.matchAll(/\]\(([^)\s#]+\.md)/g)) {
      if (normalize(join(dirname(f), link)) === path) { linking.push(f); break; }
    }
  }
  return `Deleted ${path}.` + (linking.length ? ` These notes still link to it; fix them: ${linking.join(", ")}.` : "");
}
