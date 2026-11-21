// One conversational turn: sync notes, prompt opencode, stream speakable sentences, collect sources,
// commit and push. There are no fixed voice commands: the agent decides, using the kkachi MCP tools.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";
import { commitTurn, pull, pushIfAhead } from "./git";
import { idle as librarianIdle, scheduleTidy } from "./librarian";
import { createSession, prompt, sessionExists, subscribe, type OcEvent } from "./opencode";

export type TurnEvent =
  | { type: "sentence"; text: string }
  | { type: "activity"; tool: string; path?: string }
  | { type: "end" } // the agent ended the conversation; stop listening after speaking
  | { type: "done"; sources: string[]; changed: string[]; commit: string | null }
  | { type: "error"; message: string };

const TURN_TIMEOUT_MS = 120_000;
const stateFile = join(config.dataDir, "state.json");
let busy = false;

// ---- session state ----
async function currentSession(): Promise<string> {
  if (existsSync(stateFile)) {
    const { sessionId } = await Bun.file(stateFile).json();
    if (sessionId && (await sessionExists(sessionId))) return sessionId;
  }
  return newSession();
}

async function newSession() {
  const sessionId = await createSession();
  await Bun.write(stateFile, JSON.stringify({ sessionId }));
  return sessionId;
}

// ---- speech text ----
// Sentence boundary: terminal punctuation followed by whitespace, or a newline.
const BOUNDARY = /[.!?…。](?=\s)|\n/;

function speakable(s: string): string {
  return s
    .replace(/\S+\.md\b/g, "") // file paths belong on screen, not in speech
    .replace(/[*_`#>|]/g, "")
    .replace(/^\s*(?:[-•]|\d+\.)\s+/, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const MEMORY_PREFIXES = [config.memoryDir, config.memoryDir.replace(/^\/private/, "")];

function relPath(p: string): string {
  for (const prefix of MEMORY_PREFIXES) {
    if (p === prefix) return "";
    if (p.startsWith(prefix + "/")) return p.slice(prefix.length + 1);
  }
  return p;
}

// A note the agent used as a source: a Markdown file inside the memory repo, not the rules file.
const isNote = (rel: string) => rel.endsWith(".md") && !rel.startsWith("/") && rel !== "AGENTS.md";

// Absolute .md paths mentioned in a tool result (grep output lists matching files).
function notesIn(content: any): string[] {
  const text = (Array.isArray(content) ? content : []).map((c: any) => c?.text ?? "").join("\n");
  return [...text.matchAll(/(\/\S+?\.md)\b/g)].map((m) => relPath(m[1])).filter(isNote);
}

export async function runTurn(text: string, emit: (e: TurnEvent) => void) {
  if (busy) { emit({ type: "error", message: "아직 앞의 말을 처리하고 있어요." }); return; }
  busy = true;
  try {
    await librarianIdle(); // never let the librarian and a conversation edit at the same time
    try {
      await pull(config.memoryDir);
    } catch (err) {
      console.error("pull failed", err);
      emit({ type: "error", message: "노트 저장소를 동기화하지 못했어요. 컴퓨터에서 확인이 필요해요." });
      return;
    }
    const sessionId = await currentSession();
    await streamTurn(sessionId, text, emit);
  } finally {
    busy = false;
  }
}

async function streamTurn(sessionId: string, text: string, emit: (e: TurnEvent) => void) {
  let buf = "";
  let muted = false; // set once the model starts a "Sources:" footer
  const toolNames = new Map<string, string>();
  const toolInputs = new Map<string, any>();
  const sources = new Set<string>();
  const changed = new Set<string>();

  const flushSentences = (final: boolean) => {
    for (;;) {
      if (!muted) {
        const footer = buf.search(/\n?\s*(sources|출처)\s*:/i);
        if (footer >= 0) { buf = buf.slice(0, footer) + "\n"; muted = true; }
      }
      const m = BOUNDARY.exec(buf);
      if (!m) break;
      const sentence = speakable(buf.slice(0, m.index + 1));
      buf = buf.slice(m.index + 1);
      if (/[\p{L}\p{N}]/u.test(sentence)) emit({ type: "sentence", text: sentence });
    }
    if (final) {
      const rest = speakable(buf);
      if (/[\p{L}\p{N}]/u.test(rest)) emit({ type: "sentence", text: rest });
      buf = "";
    }
  };

  let ended = false, tidyRequested = false;
  let finish!: (outcome: "succeeded" | "failed" | "interrupted", detail?: any) => void;
  const finished = new Promise<{ outcome: string; detail?: any }>((res) => (finish = (outcome, detail) => res({ outcome, detail })));

  const onEvent = (e: OcEvent) => {
    if (e.data?.sessionID !== sessionId) return;
    const d = e.data;
    switch (e.type) {
      case "session.text.delta":
        if (!muted) { buf += d.delta; flushSentences(false); }
        break;
      case "session.text.ended":
        if (!muted) { buf += "\n"; flushSentences(false); }
        break;
      case "session.tool.input.started":
        toolNames.set(d.id, d.name);
        break;
      case "session.tool.called": {
        toolInputs.set(d.id, d.input);
        const name = toolNames.get(d.id) ?? "tool";
        if (name.endsWith("end_conversation")) { ended = true; break; }
        if (name.endsWith("tidy_notes")) { tidyRequested = true; break; }
        const path = d.input?.path ?? d.input?.filePath;
        emit({ type: "activity", tool: name, path: path ? relPath(path) || undefined : undefined });
        break;
      }
      case "session.tool.success": {
        const name = toolNames.get(d.id);
        if (name === "grep") { for (const n of notesIn(d.content)) sources.add(n); break; }
        const path = toolInputs.get(d.id)?.path ?? toolInputs.get(d.id)?.filePath;
        if (!path) break;
        const rel = relPath(path);
        if (!isNote(rel)) break;
        if (name === "read") sources.add(rel);
        if (name === "edit" || name === "write" || name === "patch") changed.add(rel);
        break;
      }
      case "session.execution.succeeded": finish("succeeded"); break;
      case "session.execution.failed": finish("failed", d); break;
      case "session.execution.interrupted": finish("interrupted", d); break;
    }
  };

  const close = await subscribe(onEvent);
  try {
    await prompt(sessionId, text);
    const timeout = Bun.sleep(TURN_TIMEOUT_MS).then(() => ({ outcome: "timeout" }));
    const { outcome, detail } = (await Promise.race([finished, timeout])) as { outcome: string; detail?: any };
    flushSentences(true);
    if (outcome !== "succeeded") {
      console.error("turn", outcome, JSON.stringify(detail ?? {}).slice(0, 500));
      emit({ type: "error", message: outcome === "timeout" ? "답이 너무 오래 걸려요. 다시 말해 주세요." : "모델이 응답하지 않아요. 잠시 뒤에 다시 말해 주세요." });
      return;
    }
    for (const c of changed) sources.add(c);
    let commit: string | null = null;
    try {
      commit = await commitTurn(config.memoryDir, text);
      await pushIfAhead(config.memoryDir); // also pushes an undo commit made by the MCP tool
    } catch (err) {
      console.error("commit/push failed", err);
      emit({ type: "sentence", text: "노트는 고쳤지만 저장소에 올리지는 못했어요." });
    }
    emit({ type: "done", sources: [...sources], changed: [...changed], commit });
    if (ended) emit({ type: "end" });
    if (ended || tidyRequested) scheduleTidy();
  } finally {
    close();
  }
}
