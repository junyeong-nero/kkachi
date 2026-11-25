// kkachi-memory as an MCP service: the user's Markdown notes in a git repo.
// - memory_* for agents (which agent gets which: core's kkachi.mcp.json). A change is committed at
//   once, only the paths it touched, unless the caller commits later itself (_meta.commit = "later":
//   core does that at the end of a turn or a tidy, so one turn stays one commit).
// - git_* for Kkachi core only (internal): sync before a turn, checkpoint after it, drafts for the
//   idle review, and what the librarian needs.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path/posix";
import { log } from "../../lib/log";
import type { McpService, McpTool } from "../../lib/mcp-server";
import { commitAll, commitPaths, draftClose, draftOpen, draftPublish, filesIn, git, type Kind, locked, message, pull, pushIfAhead, stashLeftovers, undoLast } from "./git";
import { clean, deleteNote, mdFiles, moveNote } from "./notes";

const dir = process.env.KKACHI_MEMORY_DIR!;
if (!dir || !existsSync(join(dir, ".git"))) throw new Error(`KKACHI_MEMORY_DIR is not a git repo: ${dir}`);
const RULES = new Set(["AGENTS.md", "README.md", ".gitignore"]); // the repo's rules and the librarian's catalog

function notePath(p: unknown, { editable = false } = {}): string {
  const path = clean(dir, String(p ?? ""));
  if (!path.endsWith(".md")) throw new Error("a note path ends with .md");
  if (editable && RULES.has(path)) throw new Error(`${path} is maintained by Kkachi; change notes instead`);
  return path;
}
const read = (path: string) => readFileSync(join(dir, path), "utf8");
const title = (text: string) => text.match(/^title:\s*(.+)$/m)?.[1]?.trim() ?? text.match(/^# (.+)$/m)?.[1]?.trim() ?? "";
const json = (o: unknown) => JSON.stringify(o);

/** A change by an agent: committed now (only its paths) and pushed, or left for the caller to commit. */
function change(tool: string, meta: Record<string, unknown>, summary: unknown, fallback: string, apply: () => Promise<{ text: string; paths: string[] }>) {
  return locked(async () => {
    const later = meta.commit === "later";
    if (!later) await pull(dir).catch(() => {}); // best effort: a turn may be editing files right now
    const { text, paths } = await apply();
    if (later) return text;
    const commit = await commitPaths(dir, message("change", String(summary ?? "") || fallback), paths);
    await pushIfAhead(dir).catch((err) => console.error("memory push failed", err));
    log("memory_change", { tool, commit });
    return commit ? `${text} (commit ${commit})` : text;
  });
}

const summary = { type: "string", description: "One line about the change, in the user's language; becomes the commit message" };
const obj = (properties: object, required: string[] = []) => ({ type: "object", properties, required });

const agentTools: McpTool[] = [
  {
    name: "memory_list",
    description: "List notes (path and title), optionally only under a folder such as projects or areas/health. The repo's README.md is a catalog of the notes.",
    inputSchema: obj({ folder: { type: "string" } }),
    annotations: { readOnlyHint: true },
    async run(a) {
      const folder = a?.folder ? clean(dir, String(a.folder)) + "/" : "";
      const files = (await mdFiles(dir)).filter((f) => f.startsWith(folder));
      return files.map((f) => `${f}${title(read(f)) ? ` — ${title(read(f))}` : ""}`).join("\n") || "No notes there.";
    },
  },
  {
    name: "memory_search",
    description: "Find notes containing words (case-insensitive substrings; Korean words match inside longer words). Returns the best notes with matching lines.",
    inputSchema: obj({ query: { type: "string" } }, ["query"]),
    annotations: { readOnlyHint: true },
    async run(a) {
      const words = String(a?.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      if (!words.length) throw new Error("query is empty");
      const hits = [];
      for (const f of await mdFiles(dir)) {
        const text = read(f), lower = text.toLowerCase(), path = f.toLowerCase();
        const score = words.reduce((s, w) => s + (lower.split(w).length - 1) + (path.includes(w) ? 3 : 0), 0);
        if (!score) continue;
        const lines = text.split("\n").filter((l) => words.some((w) => l.toLowerCase().includes(w))).slice(0, 3);
        hits.push({ score, text: [`${f}${title(text) ? ` — ${title(text)}` : ""}`, ...lines.map((l) => `  ${l.trim().slice(0, 200)}`)].join("\n") });
      }
      return hits.sort((x, y) => y.score - x.score).slice(0, 10).map((h) => h.text).join("\n\n") || "No matching notes.";
    },
  },
  {
    name: "memory_read",
    description: "Read a note by its path, e.g. projects/trip/index.md.",
    inputSchema: obj({ path: { type: "string" } }, ["path"]),
    annotations: { readOnlyHint: true },
    run(a) {
      const path = notePath(a?.path);
      if (!existsSync(join(dir, path))) throw new Error(`not found: ${path}`);
      return read(path);
    },
  },
  {
    name: "memory_write",
    description: "Create a new note. Fails if the path exists: use memory_edit for existing notes. Follow the folder and naming rules in the repo's AGENTS.md (memory_read AGENTS.md).",
    inputSchema: obj({ path: { type: "string" }, content: { type: "string" }, summary }, ["path", "content"]),
    annotations: { readOnlyHint: false, destructiveHint: false },
    run(a, meta) {
      const path = notePath(a?.path, { editable: true });
      return change("memory_write", meta, a?.summary, `${path} 작성`, async () => {
        if (existsSync(join(dir, path))) throw new Error(`already exists: ${path}; use memory_edit`);
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), String(a?.content ?? "").replace(/\n?$/, "\n"));
        return { text: `Created ${path}.`, paths: [path] };
      });
    },
  },
  {
    name: "memory_edit",
    description: "Change a note by replacing old_text, which must appear exactly once, with new_text. To add, include nearby text in old_text and repeat it in new_text.",
    inputSchema: obj({ path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" }, summary }, ["path", "old_text", "new_text"]),
    annotations: { readOnlyHint: false, destructiveHint: true },
    run(a, meta) {
      const path = notePath(a?.path, { editable: true });
      const oldText = String(a?.old_text ?? ""), newText = String(a?.new_text ?? "");
      return change("memory_edit", meta, a?.summary, `${path} 수정`, async () => {
        if (!existsSync(join(dir, path))) throw new Error(`not found: ${path}`);
        const text = read(path);
        const count = oldText ? text.split(oldText).length - 1 : 0;
        if (count !== 1) throw new Error(count ? `old_text appears ${count} times; include more context` : "old_text is not in the note");
        writeFileSync(join(dir, path), text.replace(oldText, () => newText));
        return { text: `Edited ${path}.`, paths: [path] };
      });
    },
  },
  {
    name: "memory_move",
    description: "Move or rename a note file or a whole folder (git mv) and repair every link to and from it. Paths are repo-relative, e.g. inbox/idea.md -> projects/trip/index.md.",
    inputSchema: obj({ from: { type: "string" }, to: { type: "string" }, summary }, ["from", "to"]),
    annotations: { readOnlyHint: false, destructiveHint: false },
    run(a, meta) {
      return change("memory_move", meta, a?.summary, `${a?.from} → ${a?.to} 이동`, () => moveNote(dir, String(a?.from ?? ""), String(a?.to ?? "")));
    },
  },
  {
    name: "memory_delete",
    description: "Delete a note (git rm), only after merging its content into another note. Never AGENTS.md or README.md.",
    inputSchema: obj({ path: { type: "string" }, summary }, ["path"]),
    annotations: { readOnlyHint: false, destructiveHint: true },
    run(a, meta) {
      return change("memory_delete", meta, a?.summary, `${a?.path} 삭제`, () => deleteNote(dir, String(a?.path ?? "")));
    },
  },
  {
    name: "memory_undo",
    description: "Revert the most recent change to the notes (the previous turn, or a change made through these tools), when the user asks to forget or cancel what they just said. Not the librarian's tidying. Not for corrections; edit the note instead.",
    inputSchema: obj({}),
    annotations: { readOnlyHint: false, destructiveHint: true },
    run() {
      return locked(async () => {
        const subject = await undoLast(dir);
        await pushIfAhead(dir).catch((err) => console.error("memory push failed", err));
        return subject ? `Reverted the last saved change (request: "${subject}").` : "Nothing to undo: the last change was not made by Kkachi or was already undone.";
      });
    },
  },
];

// Results are JSON text. kind: "change" (a turn), "tidy" (the librarian), "review" (idle review).
const kind = (k: unknown): Kind => (k === "tidy" || k === "review" ? k : "change");
const coreTools: McpTool[] = [
  { name: "git_sync", description: "Pull before a turn (fast-forward only).", inputSchema: obj({}), internal: true,
    run: () => locked(async () => { await pull(dir); return json({}); }) },
  { name: "git_set_aside", description: "Stash changes left by an interrupted run (git stash list keeps them).", inputSchema: obj({}), internal: true,
    run: () => locked(async () => json({ stashed: await stashLeftovers(dir) })) },
  { name: "git_checkpoint", description: "Commit everything as one commit and push. Returns the commit and its files.", inputSchema: obj({ kind: { type: "string" }, summary: { type: "string" } }), internal: true,
    run: (a) => locked(async () => {
      const commit = await commitAll(dir, message(kind(a?.kind), String(a?.summary ?? "")));
      const files = commit ? await filesIn(dir, commit) : [];
      await pushIfAhead(dir);
      return json({ commit, files });
    }) },
  { name: "git_head", description: "The current commit.", inputSchema: obj({}), internal: true,
    run: () => locked(async () => json({ head: await git(dir, "rev-parse", "HEAD") })) },
  { name: "git_changes", description: "Notes changed since a commit (all notes if none or unknown).", inputSchema: obj({ since: { type: "string" } }), internal: true,
    run: (a) => locked(async () => {
      const all = async () => (await git(dir, "ls-files", "*.md")).split("\n").filter(Boolean);
      try { return json({ files: a?.since ? (await git(dir, "diff", "--name-only", `${a.since}..HEAD`, "--", "*.md")).split("\n").filter(Boolean) : await all() }); }
      catch { return json({ files: await all() }); }
    }) },
  { name: "git_staged", description: "Stage everything and list it as {code, path} (R moved, D deleted, else edited).", inputSchema: obj({}), internal: true,
    run: () => locked(async () => {
      await git(dir, "add", "-A");
      const lines = (await git(dir, "status", "--porcelain")).split("\n").filter(Boolean);
      return json(lines.map((l) => ({ code: l.slice(0, 2).trim(), path: l.slice(3) })));
    }) },
  { name: "git_discard", description: "Throw away uncommitted changes (a cancelled tidy).", inputSchema: obj({}), internal: true,
    run: () => locked(async () => { await git(dir, "reset", "--hard", "--quiet"); await git(dir, "clean", "-fdq"); return json({}); }) },
  { name: "git_draft_open", description: "An isolated checkout to edit (git worktree). Fails if the repo has uncommitted changes.", inputSchema: obj({}), internal: true,
    run: () => locked(async () => json(await draftOpen(dir))) },
  { name: "git_draft_publish", description: "Commit a draft (new or changed notes only) and fast-forward the repo to it, unless the repo moved meanwhile.", inputSchema: obj({ path: { type: "string" }, kind: { type: "string" }, summary: { type: "string" } }, ["path"]), internal: true,
    run: (a) => locked(async () => json(await draftPublish(dir, String(a?.path), message(kind(a?.kind), String(a?.summary ?? ""))))) },
  { name: "git_draft_close", description: "Remove a draft.", inputSchema: obj({ path: { type: "string" } }, ["path"]), internal: true,
    run: (a) => locked(async () => { await draftClose(dir, String(a?.path)); return json({}); }) },
];

export const service: McpService = {
  name: "kkachi-memory",
  instructions: "The user's personal memory: Markdown notes in a git repo (plans, decisions, preferences, facts about their life). Search or list before writing, and add to an existing note rather than creating a near-duplicate. Every change is one git commit; memory_undo reverts the last one.",
  tools: [...agentTools, ...coreTools],
};
