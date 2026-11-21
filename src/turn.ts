// One conversational turn: sync notes, prompt Pi, stream speakable sentences, collect sources,
// commit and push. There are no fixed voice commands: the agent decides, using pi/kkachi.ts tools.
import { config } from "./config";
import { commitTurn, filesIn, pull, pushIfAhead, stashLeftovers } from "./git";
import { cancelTidy, scheduleTidy } from "./librarian";
import { currentModel, isLimitError, markLimited } from "./models";
import { Pi, type PiEvent } from "./pi";

export type TurnEvent =
  | { type: "sentence"; text: string; silent?: boolean } // silent: shown on screen, not spoken
  | { type: "activity"; tool: string; path?: string }
  | { type: "end"; reason: "done" | "handoff" } // stop listening after speaking
  | { type: "done"; sources: string[]; changed: string[]; commit: string | null }
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
// Split into sentences at terminal punctuation followed by whitespace (not inside "server.ts"), or newlines.
const sentences = (text: string) => text.split(/(?<=[.!?…。])\s+|\n+/);

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

// A note shown as a source: a Markdown file inside the memory repo, not the rules or catalog.
const isNote = (rel: string) => rel.endsWith(".md") && !rel.startsWith("/") && !rel.startsWith("..") && rel !== "AGENTS.md" && rel !== "README.md";

// A new utterance supersedes the one still being handled: abort it, wait for it to wind down
// (it still commits whatever it already changed), then run the new one.
export async function runTurn(text: string, emit: (e: TurnEvent) => void) {
  if (currentTurn) await agent?.abort();
  const turn = queue.then(() => doTurn(text, emit));
  queue = turn.catch(() => {});
  currentTurn = turn;
  try { await turn; } finally { if (currentTurn === turn) currentTurn = null; }
}
let queue: Promise<void> = Promise.resolve();

async function doTurn(text: string, emit: (e: TurnEvent) => void) {
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
    const limited = await streamTurn(pi, `[지금: ${now()}]\n${text}`, text, emit);
    if (!limited) break;
    if (!markLimited(agentModel, limited) || attempt + 1 >= config.models.length) {
      emit({ type: "error", message: "지금 모델들이 모두 바빠요. 잠시 뒤에 다시 말해 주세요." });
      break;
    }
  }
}

/** Runs one prompt. Returns the error message if the model was rate-limited before speaking. */
async function streamTurn(pi: Pi, message: string, text: string, emit: (e: TurnEvent) => void): Promise<string | null> {
  let said = false;
  let error = "";
  let end: "done" | "handoff" | null = null;
  let tidyRequested = false;
  const toolArgs = new Map<string, { name: string; path?: string }>();
  const sources = new Set<string>();
  const changed = new Set<string>();

  // Speak only an assistant message that ends the run (stopReason "stop"). Text the model writes
  // before calling tools is progress narration and stays silent.
  const speakMessage = (message: any) => {
    const body = (message.content ?? []).filter((c: any) => c.type === "text").map((c: any) => c.text).join("\n");
    const spoken = body.split(/\n\s*(?:sources|출처)\s*:/i)[0];
    let count = 0;
    for (const part of sentences(spoken)) {
      const sentence = speakable(part);
      if (!/[\p{L}\p{N}]/u.test(sentence)) continue;
      said = true;
      emit({ type: "sentence", text: sentence, silent: ++count > MAX_SPOKEN_SENTENCES });
    }
  };

  const onEvent = (e: PiEvent) => {
    switch (e.type) {
      case "message_end":
        if (e.message?.role !== "assistant") break;
        if (e.message.stopReason === "error") error = String(e.message.errorMessage ?? "error");
        else if (e.message.stopReason === "stop") speakMessage(e.message);
        break;
      case "tool_execution_start": {
        const name: string = e.toolName;
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

  await pi.run(message, onEvent);
  if (error) {
    console.error(`turn failed (${agentModel}): ${error.slice(0, 300)}`);
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
  emit({ type: "done", sources: [...sources], changed: [...changed], commit });
  if (end) emit({ type: "end", reason: end });
  if (end || tidyRequested) scheduleTidy();
  return null;
}
