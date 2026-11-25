// What the memory tools (src/memory-tools.ts) do, served at /mcp/memory by src/mcp.ts, for agents
// that do not work on the files directly: other agents, and device ports (src/port.ts).
// Kkachi's own Pi edits the files. Every change is one commit ("kkachi: …"), pushed like a turn, so
// "방금 거 취소해" and memory_undo revert it. Changes wait for the running turn and pause background
// review and tidying.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path/posix";
import { config } from "./config";
import { COMMIT_PREFIX, commitAll, pull, pushIfAhead, undoLast } from "./git";
import { cancelTidy, scheduleTidy } from "./librarian";
import { log } from "./log";
import type { McpTool } from "../lib/mcp-server";
import { MEMORY_TOOL_DEFS } from "./memory-tools";
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

const run: Record<string, McpTool["run"]> = {
  async memory_list(a) {
    const folder = a?.folder ? clean(dir(), String(a.folder)) + "/" : "";
    const files = (await mdFiles(dir())).filter((f) => f.startsWith(folder));
    return files.map((f) => `${f}${title(read(f)) ? ` — ${title(read(f))}` : ""}`).join("\n") || "No notes there.";
  },
  async memory_search(a) {
    const words = String(a?.query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) throw new Error("query is empty");
    const hits = [];
    for (const f of await mdFiles(dir())) {
      const text = read(f), lower = text.toLowerCase(), path = f.toLowerCase();
      const score = words.reduce((s, w) => s + (lower.split(w).length - 1) + (path.includes(w) ? 3 : 0), 0);
      if (!score) continue;
      const lines = text.split("\n").filter((l) => words.some((w) => l.toLowerCase().includes(w))).slice(0, 3);
      hits.push({ score, text: [`${f}${title(text) ? ` — ${title(text)}` : ""}`, ...lines.map((l) => `  ${l.trim().slice(0, 200)}`)].join("\n") });
    }
    return hits.sort((x, y) => y.score - x.score).slice(0, 10).map((h) => h.text).join("\n\n") || "No matching notes.";
  },
  memory_read(a) {
    const path = notePath(a?.path);
    if (!existsSync(join(dir(), path))) throw new Error(`not found: ${path}`);
    return read(path);
  },
  memory_write(a) {
    const path = notePath(a?.path, { editable: true });
    return change("memory_write", a?.summary, `${path} 작성`, async () => {
      if (existsSync(join(dir(), path))) throw new Error(`already exists: ${path}; use memory_edit`);
      mkdirSync(dirname(join(dir(), path)), { recursive: true });
      writeFileSync(join(dir(), path), String(a?.content ?? "").replace(/\n?$/, "\n"));
      return `Created ${path}.`;
    });
  },
  memory_edit(a) {
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
  memory_move(a) {
    return change("memory_move", a?.summary, `${a?.from} → ${a?.to} 이동`, () => moveNote(dir(), String(a?.from ?? ""), String(a?.to ?? "")));
  },
  memory_undo() {
    return change("memory_undo", "", "undo", async () => {
      const subject = await undoLast(dir());
      return subject ? `Reverted "${subject}".` : "Nothing to undo.";
    });
  },
};

export const MEMORY_TOOLS: McpTool[] = MEMORY_TOOL_DEFS.map((t) => ({ ...t, run: run[t.name] }));
