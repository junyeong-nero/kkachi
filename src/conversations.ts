// Kkachi Home's conversations, read from Pi's session files (data/pi-sessions, one JSONL file per
// conversation). The app lists them in its menu and shows the open one again when it is reopened.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";

export type PastTurn = {
  t: string;
  text: string;    // what was said, without the time and device header Kkachi put in front of it
  from?: string;   // the device it was said to, when not this app
  photos: number;  // photos sent with it (not kept: only how many)
  reply: string;   // Kkachi's last words in that turn (earlier ones were narration before a tool call)
  failed?: boolean;
};
export type ConversationSummary = { id: string; title: string; t: string; turns: number };

const ID = /^[\w.-]+$/; // a session file name without .jsonl: nothing that walks out of the folder

// Every message Kkachi sends Pi starts "[지금: <time>]", then " [기기: <name>]" when it
// was said to a device (src/turn.ts, src/bus.ts), then a new line and the words. Older sessions also
// have ", 개인 정보: …" in the device mark.
const HEADER = /^\[지금: [^\]\n]*\](?: \[기기: (.+?)(?:, 개인 정보: [^\]\n]*)?\])?[^\n]*\n?/;

export function turnsOf(jsonl: string): PastTurn[] {
  const turns: PastTurn[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; } // a line cut short while it was written
    if (e.type !== "message" || !e.message) continue;
    const m = e.message;
    const parts: any[] = typeof m.content === "string" ? [{ type: "text", text: m.content }] : Array.isArray(m.content) ? m.content : [];
    const words = parts.filter((p) => p.type === "text").map((p) => p.text ?? "").join("");
    if (m.role === "user") {
      const head = words.match(HEADER);
      turns.push({
        t: e.timestamp, text: words.slice(head?.[0].length ?? 0).trim(),
        ...(head?.[1] ? { from: head[1] } : {}),
        photos: parts.filter((p) => p.type === "image").length, reply: "",
      });
    } else if (m.role === "assistant" && turns.length) {
      const turn = turns[turns.length - 1];
      if (words.trim()) turn.reply = words.trim();
      if (m.stopReason === "error") turn.failed = true;
      else if (words.trim()) delete turn.failed; // a retry on the next model answered
    }
  }
  return turns;
}

export function summaryOf(id: string, turns: PastTurn[]): ConversationSummary | null {
  if (!turns.length) return null;
  const first = turns[0];
  return { id, title: first.text || (first.photos ? "📷" : "…"), t: turns[turns.length - 1].t, turns: turns.length };
}

const cache = new Map<string, { mtime: number; turns: PastTurn[] }>(); // parsed once per change
function read(dir: string, id: string): PastTurn[] {
  const file = join(dir, `${id}.jsonl`);
  const mtime = statSync(file).mtimeMs;
  const hit = cache.get(id);
  if (hit?.mtime === mtime) return hit.turns;
  const turns = turnsOf(readFileSync(file, "utf8"));
  cache.set(id, { mtime, turns });
  return turns;
}

const ids = (dir: string): string[] => {
  try { return readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => f.slice(0, -6)); } catch { return []; }
};

/** The newest file: the one Pi continues when it starts. */
export function newestId(dir: string): string | null {
  let best: string | null = null, at = -1;
  for (const id of ids(dir)) { const m = statSync(join(dir, `${id}.jsonl`)).mtimeMs; if (m > at) { at = m; best = id; } }
  return best;
}

export const idOf = (sessionFile: string) => basename(sessionFile).replace(/\.jsonl$/, "");
export const fileOf = (dir: string, id: string) => (ID.test(id) && ids(dir).includes(id) ? join(dir, `${id}.jsonl`) : null);

export function conversations(dir: string, limit = 50): ConversationSummary[] {
  return ids(dir).map((id) => summaryOf(id, read(dir, id))).filter((s): s is ConversationSummary => !!s)
    .sort((a, b) => b.t.localeCompare(a.t)).slice(0, limit);
}

export function transcript(dir: string, id: string | null): PastTurn[] {
  return id && fileOf(dir, id) ? read(dir, id) : [];
}
