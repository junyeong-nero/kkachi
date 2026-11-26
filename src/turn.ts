// One conversational turn: sync notes, prompt Pi, stream speakable sentences, collect sources,
// commit and push. There are no fixed voice commands: the agent decides, using pi/kkachi.ts tools.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";
import { log } from "./log";
import { memory } from "./memory";
import { cancelTidy, scheduleTidy } from "./librarian";
import { currentModel, isLimitError, markLimited, modelOrder } from "./models";
import { cancelReview, recordTurn as queueForReview, resumeReviews, type ReviewIssue } from "./review";
import { authedProviders, settings } from "./settings";
import { Pi, type PiEvent, type PiImage } from "./pi";

export type TurnEvent =
  | { type: "delta"; text: string }                         // live text for the screen, as it streams
  | { type: "aside" }                                       // the text so far was narration before a tool call: keep it, muted, and stop speaking it
  | { type: "sentence"; text: string; silent?: boolean }    // a finished sentence to speak (silent: too long, screen only)
  | { type: "activity"; tool: string; path?: string }
  | { type: "photo"; data: string; mimeType: string }      // an image a tool returned (a device photo), shown under the reply, not kept
  | { type: "end"; reason: "done" | "handoff" } // stop listening after speaking
  | { type: "done"; sources: string[]; changed: string[]; titles: Record<string, string>; commit: string | null }
  | { type: "error"; message: string; issue?: ReviewIssue };

let currentTurn: Promise<void> | null = null;
const MAX_SPOKEN_SENTENCES = 2; // long replies are tiring to listen to; the rest is shown on screen

// ---- the long-lived conversation agent ----
let agent: Pi | null = null;
let agentModel = "";
let starting: Promise<Pi> | null = null; // one Pi, even when the first turn arrives while it starts

async function conversation(): Promise<Pi> {
  if (!agent) {
    starting ??= (async () => {
      agentModel = currentModel();
      const pi = new Pi({ prompt: "kkachi.md", mode: "append", session: "continue", mcp: "chat" });
      await pi.start(agentModel);
      pi.exited.then((code) => { console.error(`pi exited (${code}); restarting on next turn`); if (agent === pi) agent = null; });
      agent = pi;
      return pi;
    })().finally(() => (starting = null));
    await starting;
  }
  if (!agent) throw new Error("pi did not start");
  const model = currentModel();
  if (model !== agentModel) { await agent.setModel(model); agentModel = model; }
  return agent;
}

/** For the phone app's status screen: whether a turn is running now, and on which model. */
export const agentState = () => ({ busy: !!currentTurn, model: agentModel || currentModel() });

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
  if ((await memory.setAside()).stashed) console.error("memory repo had uncommitted changes; stashed them");
  await conversation();
  resumeReviews();
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
// A device turn (docs/bus.md) waits its turn instead of stopping the one running, and names its
// device in the prompt's header, the commit and the review journal.
export type TurnSource = { device: string; header: string };
export async function runTurn(text: string, emit: (e: TurnEvent) => void, images: PiImage[] = [], source?: TurnSource) {
  if (currentTurn && !source) await agent?.abort();
  // Photos go to the model only. The log, the commit message and the review journal note that there were some.
  const said = (source ? `[${source.device}] ` : "") + (images.length ? `${text} [사진 ${images.length}장]`.trim() : text);
  const turn = queue.then(async () => {
    await Promise.all([cancelReview(), cancelTidy()]); // a foreground turn has priority over both jobs
    const t = new Date().toISOString();
    let reply = "", saved: string[] = [];
    let issue: ReviewIssue | undefined;
    try {
      await doTurn(text, said, images, source?.header ?? "", (e) => {
        if (e.type === "delta") reply += e.text;
        if (e.type === "aside") reply = ""; // keep the answer, not progress before a tool call
        if (e.type === "done") saved = e.changed;
        if (e.type === "error") issue = e.issue;
        emit(e);
      });
    } finally {
      // Once per submitted turn, not once per model fallback or stream reconnect.
      queueForReview({ t, user: said, reply, saved, issue });
    }
  });
  queue = turn.catch(() => {});
  currentTurn = turn;
  try { await turn; } finally { if (currentTurn === turn) currentTurn = null; }
}
let queue: Promise<void> = Promise.resolve();

/** Run fn in line with conversation turns, so two agents never edit the notes at the same time. */
export function inTurnQueue<T>(fn: () => Promise<T>): Promise<T> {
  const op = queue.then(fn);
  queue = op.then(() => {}, () => {});
  return op;
}


async function doTurn(text: string, said: string, images: PiImage[], header: string, emit: (e: TurnEvent) => void) {
  try {
    await memory.sync();
  } catch (err) {
    console.error("pull failed", err);
    emit({ type: "error", message: "노트 저장소를 동기화하지 못했어요. 컴퓨터에서 확인이 필요해요." });
    return;
  }
  // Retry on the next model when a model is rate-limited before saying anything.
  for (let attempt = 0; ; attempt++) {
    const pi = await conversation();
    const limited = await streamTurn(pi, `[지금: ${now()}]${header ? " " + header : ""}\n${text}`, said, images, emit);
    if (!limited) break;
    if (!markLimited(agentModel, limited) || attempt + 1 >= modelOrder().length) {
      emit({ type: "error", message: "지금 모델들이 모두 바빠요. 잠시 뒤에 다시 말해 주세요." });
      break;
    }
  }
}

/** Runs one prompt. Returns the error message if the model was rate-limited before speaking. */
async function streamTurn(pi: Pi, message: string, text: string, images: PiImage[], emit: (e: TurnEvent) => void): Promise<string | null> {
  const t0 = performance.now();
  let firstSentenceMs = 0, tools = 0, aborted = false;
  let said = false;
  let error = "";
  let end: "done" | "handoff" | null = null;
  let tidyRequested = false, usedSearch = false;
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
          if (shown.trim()) emit({ type: "aside" });
          shown = ""; pending = "";
        }
        if (u?.type !== "text_delta" || toolMessage) break;
        const delta: string = u.delta;
        if (!delta) break;
        said = true;
        shown += delta;
        emit({ type: "delta", text: delta }); // the screen gets everything
        if (footer) break;                     // the ear does not: no "Sources:" footer
        const cut = shown.search(/\n\s*(?:sources|출처)\s*:/i);
        pending += cut >= 0 ? delta.slice(0, Math.max(0, cut - (shown.length - delta.length))) : delta;
        if (cut >= 0) footer = true;
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
        if (/browser|web_search|fetch_content|source_check|get_search_content/i.test(name === "mcp" ? e.args?.tool ?? "" : name)) usedSearch = true;
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
        // A photo a tool brought back (a device camera, say) is shown under the reply. Not kept.
        if (!e.isError) for (const c of e.result?.content ?? []) if (c.type === "image") emit({ type: "photo", data: c.data, mimeType: c.mimeType });
        const t = toolArgs.get(e.toolCallId);
        if (!t?.path || e.isError || !isNote(t.path)) break;
        if (t.name === "read") sources.add(t.path);
        if (t.name === "edit" || t.name === "write") changed.add(t.path);
        break;
      }
    }
  };

  await pi.run(message, (e) => { if (e.type === "agent_settled" && e.aborted) aborted = true; onEvent(e); }, images);
  log("turn", { model: agentModel, text, firstSentenceMs, totalMs: Math.round(performance.now() - t0), tools, aborted, error: error ? error.slice(0, 200) : undefined });
  if (error) {
    if (!said && isLimitError(error)) return error;
    // Keep a non-sensitive failure category for memory review, not the provider's raw error or tool arguments.
    const issue = !aborted && usedSearch && isLimitError(error) ? "search_rate_limit" : undefined;
    emit({ type: "error", message: "모델이 응답하지 않아요. 잠시 뒤에 다시 말해 주세요.", issue });
    return null;
  }

  let commit: string | null = null;
  try {
    // One turn, one commit, pushed (the memory service). The agent may change notes with bash too;
    // the commit is the authoritative list.
    const saved = await memory.checkpoint("change", text);
    commit = saved.commit;
    for (const f of saved.files) if (isNote(f)) changed.add(f);
    for (const c of changed) sources.add(c);
  } catch (err) {
    console.error("commit/push failed", err);
    emit({ type: "sentence", text: "기억은 해두었는데 GitHub 에 올리지는 못했어요." });
  }
  emit({ type: "done", sources: [...sources], changed: [...changed], titles: noteTitles([...sources]), commit });
  if (end) emit({ type: "end", reason: end });
  if (end || tidyRequested) scheduleTidy();
  return null;
}
