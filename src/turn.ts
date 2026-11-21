// One conversational turn: sync notes, prompt Pi, stream speakable sentences, collect sources,
// commit and push. There are no fixed voice commands: the agent decides, using pi/kkachi.ts tools.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";
import { log } from "./log";
import { commitTurn, filesIn, pull, pushIfAhead, stashLeftovers } from "./git";
import { cancelTidy, scheduleTidy } from "./librarian";
import { currentModel, isLimitError, markLimited, modelOrder } from "./models";
import { authedProviders, settings } from "./settings";
import { Pi, type PiEvent } from "./pi";

export type TurnEvent =
  | { type: "delta"; text: string }                         // live text for the screen, as it streams
  | { type: "retract" }                                     // the streamed text was narration before a tool call: drop it
  | { type: "sentence"; text: string; silent?: boolean }    // a finished sentence to speak (silent: too long, screen only)
  | { type: "activity"; tool: string; path?: string }
  | { type: "end"; reason: "done" | "handoff" } // stop listening after speaking
  | { type: "done"; sources: string[]; changed: string[]; titles: Record<string, string>; commit: string | null }
  | { type: "error"; message: string };

let currentTurn: Promise<void> | null = null;
const MAX_SPOKEN_SENTENCES = 2; // long replies are tiring to listen to; the rest is shown on screen

// ---- the long-lived conversation agent ----
let agent: Pi | null = null;
let agentModel = "";

async function conversation(): Promise<Pi> {
  if (!agent) {
    agentModel = currentModel();
    const pi = new Pi({ prompt: "kkachi.md", session: "continue" });
    await pi.start(agentModel);
    pi.exited.then((code) => { console.error(`pi exited (${code}); restarting on next turn`); if (agent === pi) agent = null; });
    agent = pi;
  }
  const model = currentModel();
  if (model !== agentModel) { await agent.setModel(model); agentModel = model; }
  return agent;
}

// ---- settings sheet hooks ----
export async function applyThinking() { await agent?.setThinking(); }

/** Start a fresh Pi session (the memory repo is untouched). */
export async function newConversation() {
  if (currentTurn) await agent?.abort();
  await queue;
  await (await conversation()).newSession();
}

/** Models the user can pick: providers they are signed in to; OpenRouter only its free models. */
export async function modelChoices(): Promise<{ id: string; provider: string; name: string }[]> {
  const authed = authedProviders();
  const all = await (await conversation()).availableModels();
  const list = all
    .filter((m) => authed.has(m.provider))
    .filter((m) => m.provider !== "openrouter" || m.id.endsWith(":free"))
    .filter((m) => !/-\d{8}$/.test(m.id)) // dated snapshots duplicate their alias
    .map((m) => ({ id: `${m.provider}/${m.id}`, provider: m.provider, name: m.name ?? m.id }));
  if (!list.some((m) => m.id === settings().model)) {
    const [provider, ...rest] = settings().model.split("/");
    list.unshift({ id: settings().model, provider, name: rest.join("/") });
  }
  return list;
}

// Pi's default prompt (which carries the date) is replaced, so every prompt states the local time.
export function now(): string {
  return new Date().toLocaleString("ko-KR", { timeZone: config.timeZone, dateStyle: "full", timeStyle: "short" });
}

export async function startConversation() {
  // A previous run may have stopped mid-turn or mid-tidy. Set leftovers aside (recoverable with
  // `git stash list`) so they never leak into the next turn's commit.
  if (await stashLeftovers(config.memoryDir)) console.error("memory repo had uncommitted changes; stashed them");
  await conversation();
}

// ---- speech text ----

function speakable(s: string): string {
  return s
    .replace(/https?:\/\/\S+/g, "")
    .replace(/\S+\.md\b/g, "") // file paths belong on screen, not in speech
    .replace(/[*_`#>|]/g, "")
    .replace(/^\s*(?:[-•]|\d+\.)\s+/, "")
    .replace(/\(\s*\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const MEMORY_PREFIXES = [config.memoryDir, config.memoryDir.replace(/^\/private/, "")];

function relPath(p: string): string {
  const clean = p.replace(/^\.\//, "");
  for (const prefix of MEMORY_PREFIXES) {
    if (clean === prefix) return "";
    if (clean.startsWith(prefix + "/")) return clean.slice(prefix.length + 1);
  }
  return clean;
}

function noteTitles(paths: string[]): Record<string, string> {
  const titles: Record<string, string> = {};
  for (const p of paths) {
    try {
      const h1 = readFileSync(join(config.memoryDir, p), "utf8").match(/^# (.+)$/m)?.[1]?.trim();
      if (h1) titles[p] = h1;
    } catch {} // deleted or moved in this turn
  }
  return titles;
}

// A note shown as a source: a Markdown file inside the memory repo, not the rules or catalog.
const isNote = (rel: string) => rel.endsWith(".md") && !rel.startsWith("/") && !rel.startsWith("..") && rel !== "AGENTS.md" && rel !== "README.md" && rel !== "vocabulary.md";

// A new utterance supersedes the one still being handled: abort it, wait for it to wind down
// (it still commits whatever it already changed), then run the new one.
export async function runTurn(text: string, emit: (e: TurnEvent) => void, raw?: string) {
  if (currentTurn) await agent?.abort();
  const turn = queue.then(() => doTurn(text, emit, raw));
  queue = turn.catch(() => {});
  currentTurn = turn;
  try { await turn; } finally { if (currentTurn === turn) currentTurn = null; }
}
let queue: Promise<void> = Promise.resolve();

async function doTurn(text: string, emit: (e: TurnEvent) => void, raw?: string) {
  // The cleaned-up transcript can be wrong about English terms; give the agent the original too.
  const heard = raw && raw.trim() !== text.trim() ? `${text}\n(음성 인식 원문: ${raw})` : text;
  await cancelTidy(); // the user comes first; the librarian retries after this conversation
  try {
    await pull(config.memoryDir);
  } catch (err) {
    console.error("pull failed", err);
    emit({ type: "error", message: "노트 저장소를 동기화하지 못했어요. 컴퓨터에서 확인이 필요해요." });
    return;
  }
  // Retry on the next model when a model is rate-limited before saying anything.
  for (let attempt = 0; ; attempt++) {
    const pi = await conversation();
    const limited = await streamTurn(pi, `[지금: ${now()}]\n${heard}`, text, emit);
    if (!limited) break;
    if (!markLimited(agentModel, limited) || attempt + 1 >= modelOrder().length) {
      emit({ type: "error", message: "지금 모델들이 모두 바빠요. 잠시 뒤에 다시 말해 주세요." });
      break;
    }
  }
}

/** Runs one prompt. Returns the error message if the model was rate-limited before speaking. */
async function streamTurn(pi: Pi, message: string, text: string, emit: (e: TurnEvent) => void): Promise<string | null> {
  const t0 = performance.now();
  let firstSentenceMs = 0, tools = 0, aborted = false;
  let said = false;
  let error = "";
  let end: "done" | "handoff" | null = null;
  let tidyRequested = false;
  const toolArgs = new Map<string, { name: string; path?: string }>();
  const sources = new Set<string>();
  const changed = new Set<string>();

  // Streaming, per assistant message: text goes to the screen as it arrives (delta) and each finished
  // sentence goes to TTS at once. If the message then calls a tool, what it said was progress
  // narration: tell the client to drop it (retract) and keep the rest of that message silent.
  let shown = "", pending = "", spokenCount = 0, toolMessage = false, footer = false;

  const speak = (part: string) => {
    const sentence = speakable(part);
    if (!/[\p{L}\p{N}]/u.test(sentence)) return;
    if (!firstSentenceMs) firstSentenceMs = Math.round(performance.now() - t0);
    emit({ type: "sentence", text: sentence, silent: ++spokenCount > MAX_SPOKEN_SENTENCES });
  };
  const flush = (final: boolean) => {
    for (let m; (m = /[.!?…。](?=\s)|\n/.exec(pending)); ) {
      speak(pending.slice(0, m.index + 1));
      pending = pending.slice(m.index + 1);
    }
    if (final) { speak(pending); pending = ""; }
  };

  const onEvent = (e: PiEvent) => {
    switch (e.type) {
      case "message_start":
        if (e.message?.role === "assistant") { shown = ""; pending = ""; spokenCount = 0; toolMessage = false; footer = false; }
        break;
      case "message_update": {
        const u = e.assistantMessageEvent;
        if (u?.type === "toolcall_start" && !toolMessage) {
          toolMessage = true;
          if (shown.trim()) emit({ type: "retract" });
          shown = ""; pending = "";
        }
        if (u?.type !== "text_delta" || toolMessage || footer) break;
        let delta: string = u.delta;
        const cut = (shown + delta).search(/\n\s*(?:sources|출처)\s*:/i); // a "Sources:" footer is not for the ear
        if (cut >= 0) { delta = delta.slice(0, Math.max(0, cut - shown.length)); footer = true; }
        if (!delta) break;
        said = true;
        shown += delta; pending += delta;
        emit({ type: "delta", text: delta });
        flush(false);
        break;
      }
      case "message_end":
        if (e.message?.role !== "assistant") break;
        if (e.message.stopReason === "error") error = String(e.message.errorMessage ?? "error");
        else if (!toolMessage) flush(true);
        break;
      case "tool_execution_start": {
        const name: string = e.toolName;
        tools++;
        if (name === "end_conversation") { end = "done"; break; }
        if (name === "handoff") { end = "handoff"; break; }
        if (name === "tidy_notes") { tidyRequested = true; break; }
        const path = typeof e.args?.path === "string" ? relPath(e.args.path) : undefined;
        toolArgs.set(e.toolCallId, { name, path });
        emit({ type: "activity", tool: name, path: path || undefined });
        break;
      }
      case "tool_execution_end": {
        const t = toolArgs.get(e.toolCallId);
        if (!t?.path || e.isError || !isNote(t.path)) break;
        if (t.name === "read") sources.add(t.path);
        if (t.name === "edit" || t.name === "write") changed.add(t.path);
        break;
      }
    }
  };

  await pi.run(message, (e) => { if (e.type === "agent_settled" && e.aborted) aborted = true; onEvent(e); });
  log("turn", { model: agentModel, text, firstSentenceMs, totalMs: Math.round(performance.now() - t0), tools, aborted, error: error ? error.slice(0, 200) : undefined });
  if (error) {
    if (!said && isLimitError(error)) return error;
    emit({ type: "error", message: "모델이 응답하지 않아요. 잠시 뒤에 다시 말해 주세요." });
    return null;
  }

  let commit: string | null = null;
  try {
    commit = await commitTurn(config.memoryDir, text);
    // The agent may change notes with bash too; the commit is the authoritative list.
    if (commit) for (const f of await filesIn(config.memoryDir, commit)) if (isNote(f)) changed.add(f);
    for (const c of changed) sources.add(c);
    await pushIfAhead(config.memoryDir); // also pushes an undo commit made by undo_last_change
  } catch (err) {
    console.error("commit/push failed", err);
    emit({ type: "sentence", text: "기억은 해두었는데 GitHub 에 올리지는 못했어요." });
  }
  emit({ type: "done", sources: [...sources], changed: [...changed], titles: noteTitles([...sources]), commit });
  if (end) emit({ type: "end", reason: end });
  if (end || tidyRequested) scheduleTidy();
  return null;
}
