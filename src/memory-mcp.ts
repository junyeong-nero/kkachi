// The memory repo as MCP tools (served at /mcp/memory by src/mcp.ts) for agents that do not work on
// the files directly: other agents now, restricted ports later. Kkachi's own Pi edits the files.
// Every change is one commit ("kkachi: …"), pushed like a turn, so "방금 거 취소해" and memory_undo
// revert it. Changes wait for the running turn and pause background review and tidying.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path/posix";
import { config } from "./config";
import { COMMIT_PREFIX, commitAll, pull, pushIfAhead, undoLast } from "./git";
import { cancelTidy, scheduleTidy } from "./librarian";
import { log } from "./log";
import type { McpTool } from "./mcp";
import { clean, mdFiles, moveNote } from "./notes";
import { cancelReview, resumeReviews } from "./review";
import { afterTurns } from "./turn";

const dir = () => config.memoryDir;
const RULES = new Set(["AGENTS.md", "README.md", ".gitignore"]); // the repo's rules and the librarian's catalog

function notePath(p: unknown, { editable = false } = {}): string {
  const path = clean(dir(), String(p ?? ""));
  if (!path.endsWith(".md")) throw new Error("a note path ends with .md");
  if (editable && RULES.has(path)) throw new Error(`${path} is maintained by Kkachi; change notes instead`);
  return path;
}
const read = (path: string) => readFileSync(join(dir(), path), "utf8");
const title = (text: string) => text.match(/^title:\s*(.+)$/m)?.[1]?.trim() ?? text.match(/^# (.+)$/m)?.[1]?.trim() ?? "";

async function change(tool: string, summary: unknown, fallback: string, apply: () => Promise<string>): Promise<string> {
  return afterTurns(async () => {
    const [, tidying] = await Promise.all([cancelReview(), cancelTidy()]);
    try {
      await pull(dir());
      const out = await apply();
      const line = String(summary ?? "").replace(/\s+/g, " ").trim().slice(0, 60) || fallback;
      const commit = await commitAll(dir(), COMMIT_PREFIX + line);
      await pushIfAhead(dir()).catch((err) => console.error("memory push failed", err));
      log("memory_mcp", { tool, commit });
      return commit ? `${out} (commit ${commit})` : out;
    } finally {
      resumeReviews(); // a paused review resumes; a cancelled tidy runs again
      if (tidying) scheduleTidy();
    }
  });
}

const summary = { type: "string", description: "One line about the change, in the user's language; becomes the commit message" };

export const MEMORY_TOOLS: McpTool[] = [
  {
    name: "memory_list",
    description: "List notes (path and title), optionally only under a folder such as projects or areas/health. The repo's README.md is a catalog of the notes.",
    inputSchema: { type: "object", properties: { folder: { type: "string" } } },
    annotations: { readOnlyHint: true },
    async run(a) {
      const folder = a?.folder ? clean(dir(), String(a.folder)) + "/" : "";
      const files = (await mdFiles(dir())).filter((f) => f.startsWith(folder));
      return files.map((f) => `${f}${title(read(f)) ? ` — ${title(read(f))}` : ""}`).join("\n") || "No notes there.";
    },
  },
  {
    name: "memory_search",
    description: "Find notes containing words (case-insensitive substrings; Korean words match inside longer words). Returns the best notes with matching lines.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    annotations: { readOnlyHint: true },
    async run(a) {
      const words = String(a?.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      if (!words.length) throw new Error("query is empty");
      const hits = [];
      for (const f of await mdFiles(dir())) {
        const text = read(f), lower = text.toLowerCase(), path = f.toLowerCase();
        const score = words.reduce((s, w) => s + (lower.split(w).length - 1) + (path.includes(w) ? 3 : 0), 0);
        if (!score) continue;
        const lines = text.split("\n").filter((l) => words.some((w) => l.toLowerCase().includes(w))).slice(0, 3);
        hits.push({ f, score, text: [`${f}${title(text) ? ` — ${title(text)}` : ""}`, ...lines.map((l) => `  ${l.trim().slice(0, 200)}`)].join("\n") });
      }
      return hits.sort((x, y) => y.score - x.score).slice(0, 10).map((h) => h.text).join("\n\n") || "No matching notes.";
    },
  },
  {
    name: "memory_read",
    description: "Read a note by its path, e.g. projects/trip/index.md.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    annotations: { readOnlyHint: true },
    run(a) {
      const path = notePath(a?.path);
      if (!existsSync(join(dir(), path))) throw new Error(`not found: ${path}`);
      return read(path);
    },
  },
  {
    name: "memory_write",
    description: "Create a new note. Fails if the path exists: use memory_edit for existing notes. Follow the folder and naming rules in the repo's AGENTS.md (memory_read AGENTS.md).",
    inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, summary }, required: ["path", "content"] },
    annotations: { readOnlyHint: false, destructiveHint: false },
    run(a) {
      const path = notePath(a?.path, { editable: true });
      return change("memory_write", a?.summary, `${path} 작성`, async () => {
        if (existsSync(join(dir(), path))) throw new Error(`already exists: ${path}; use memory_edit`);
        mkdirSync(dirname(join(dir(), path)), { recursive: true });
        writeFileSync(join(dir(), path), String(a?.content ?? "").replace(/\n?$/, "\n"));
        return `Created ${path}.`;
      });
    },
  },
  {
    name: "memory_edit",
    description: "Change a note by replacing old_text, which must appear exactly once, with new_text. To add, include nearby text in old_text and repeat it in new_text.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" }, summary }, required: ["path", "old_text", "new_text"] },
    annotations: { readOnlyHint: false, destructiveHint: true },
    run(a) {
      const path = notePath(a?.path, { editable: true });
      const oldText = String(a?.old_text ?? ""), newText = String(a?.new_text ?? "");
      return change("memory_edit", a?.summary, `${path} 수정`, async () => {
        if (!existsSync(join(dir(), path))) throw new Error(`not found: ${path}`);
        const text = read(path);
        const count = oldText ? text.split(oldText).length - 1 : 0;
        if (count !== 1) throw new Error(count ? `old_text appears ${count} times; include more context` : "old_text is not in the note");
        writeFileSync(join(dir(), path), text.replace(oldText, () => newText));
        return `Edited ${path}.`;
      });
    },
  },
  {
    name: "memory_move",
    description: "Move or rename a note or folder and fix every link to and from it.",
    inputSchema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, summary }, required: ["from", "to"] },
    annotations: { readOnlyHint: false, destructiveHint: false },
    run(a) {
      return change("memory_move", a?.summary, `${a?.from} → ${a?.to} 이동`, () => moveNote(dir(), String(a?.from ?? ""), String(a?.to ?? "")));
    },
  },
  {
    name: "memory_undo",
    description: "Revert the most recent change to the notes made by Kkachi or through these tools (not the librarian's tidying).",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: false, destructiveHint: true },
    run() {
      return change("memory_undo", "", "undo", async () => {
        const subject = await undoLast(dir());
        return subject ? `Reverted "${subject}".` : "Nothing to undo.";
      });
    },
  },
];
