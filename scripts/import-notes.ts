// Import a PARA-style notes repo (e.g. an Obsidian vault with numbered folders) into a Kkachi memory repo.
//
//   bun scripts/import-notes.ts <source-repo> <memory-repo> [--dry-run]
//
// - Copies only git-tracked files under the PARA folders, so ignored originals (ID scans, ...) never move.
// - 00_inbox / 01_projects / 02_areas / 03_resources / 99_archive -> inbox / projects / areas / resources / archive.
// - Strips "NN_" number prefixes from folder and file names ("00_index.md" becomes "index.md").
// - Rewrites Obsidian [[wikilinks]] and relative Markdown links to relative Markdown links at the new paths.
//   Links whose target cannot be found are left as they are and listed at the end.
// Note contents are otherwise unchanged; the librarian rebuilds the catalog afterwards.
import { existsSync, mkdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, normalize, relative } from "node:path";

const [src, dst] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const dryRun = process.argv.includes("--dry-run");
if (!src || !dst) throw new Error("usage: bun scripts/import-notes.ts <source-repo> <memory-repo> [--dry-run]");

const TOP: Record<string, string> = { "00_inbox": "inbox", "01_projects": "projects", "02_areas": "areas", "03_resources": "resources", "99_archive": "archive" };
const SKIP = /(^|\/)(\.gitkeep|\.DS_Store)$/;

const tracked = Bun.spawnSync(["git", "-C", src, "-c", "core.quotePath=false", "ls-files"]).stdout.toString().split("\n").filter(Boolean); // Korean names as they are, not "\354…"
const files = tracked.filter((f) => TOP[f.split("/")[0]] && !SKIP.test(f));

const mapPath = (old: string) => {
  const [top, ...rest] = old.split("/");
  return [TOP[top] ?? top, ...rest.map((s) => s.replace(/^\d{2}_/, ""))].join("/");
};

const moved = new Map(files.map((f) => [f, mapPath(f)]));
const seen = new Map<string, string>();
for (const [o, n] of moved) {
  if (seen.has(n)) throw new Error(`name collision: ${seen.get(n)} and ${o} both become ${n}`);
  seen.set(n, o);
}
const oldDirs = new Set(files.flatMap((f) => f.split("/").slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join("/"))));

// Resolve a link target written in `fromOld` to an old repo-relative path (file or folder), or null.
function resolve(fromOld: string, target: string): string | null {
  const t = decodeURI(target).replace(/\/$/, "");
  // Also try without one leading "../": a common slip in hand-written links (already broken in the source).
  const candidates = [join(dirname(fromOld), t), t, join(dirname(fromOld), t.replace(/^\.\.\//, ""))].map((p) => normalize(p));
  for (const c of candidates) {
    for (const p of [c, `${c}.md`, `${c}/00_index.md`, `${c}/index.md`]) if (moved.has(p)) return p;
    if (oldDirs.has(c)) return c;
  }
  // Obsidian also resolves bare names anywhere in the vault: accept a unique basename match.
  const name = basename(t).replace(/\.md$/, "");
  const hits = files.filter((f) => basename(f).replace(/\.md$/, "") === name);
  return hits.length === 1 ? hits[0] : null;
}

const newPathOf = (old: string) => moved.get(old) ?? mapPath(old); // folders are mapped by rule
const unresolved: string[] = [];
let rewritten = 0;

function convert(old: string, text: string): string {
  const fromNew = newPathOf(old);
  const link = (targetOld: string, label: string, anchor = "") => {
    rewritten++;
    const rel = relative(dirname(fromNew), newPathOf(targetOld)) || basename(newPathOf(targetOld));
    return `[${label}](${encodeURI(rel)}${anchor})`;
  };
  // Markdown links first, so the links produced from wikilinks below are not rewritten twice.
  // [label](relative/path) — leave URLs, absolute paths and anchors alone
  text = text.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (m, label: string, target: string) => {
    if (/^[a-z][a-z0-9+.-]*:|^#|^\//i.test(target)) return m;
    const [path, anchor = ""] = target.split(/(?=#)/);
    const hit = resolve(old, path);
    if (!hit) { unresolved.push(`${old}: ${m}`); return m; }
    return link(hit, label, anchor);
  });
  // [[target#anchor|alias]]
  text = text.replace(/\[\[([^\]|#]+)(#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (m, target: string, anchor = "", alias?: string) => {
    const hit = resolve(old, target.trim());
    if (!hit) { unresolved.push(`${old}: ${m}`); return m; }
    const label = alias?.trim() || basename(target.trim()).replace(/\.md$/, "").replace(/^\d{2}_/, "");
    return link(hit, label, anchor);
  });
  return text;
}

let copied = 0;
for (const [old, neu] of moved) {
  const from = join(src, old), to = join(dst, neu);
  if (existsSync(to)) throw new Error(`already exists in memory repo: ${neu}`);
  if (!dryRun) mkdirSync(dirname(to), { recursive: true });
  if (extname(old) === ".md") {
    const out = convert(old, await Bun.file(from).text());
    if (!dryRun) await Bun.write(to, out);
  } else if (!dryRun) {
    await Bun.write(to, Bun.file(from));
  }
  copied++;
  if (dryRun) console.log(`${old}  ->  ${neu}`);
}

console.log(`\n${dryRun ? "would copy" : "copied"} ${copied} files, rewrote ${rewritten} links, ${unresolved.length} unresolved`);
for (const u of unresolved) console.log(`  unresolved: ${u}`);
if (!dryRun && !statSync(dst).isDirectory()) throw new Error("memory repo missing");
