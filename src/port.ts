// Device sessions of their own (docs/bus.md): what is said to spare devices when the settings keep
// it apart from Kkachi Home's conversation, one session for all devices ("home") or one per device.
// Tools are the setting's: "full" gives Kkachi Home's tools and waits in line with its turns (core
// commits each turn), "limited" gives the notes, speaking and the lamp (each note change is its own
// commit by the memory service) and does not wait.
import { log } from "./log";
import { cancelTidy } from "./librarian";
import { memory } from "./memory";
import { currentModel } from "./models";
import { Pi } from "./pi";
import { cancelReview, recordTurn as queueForReview } from "./review";
import { inTurnQueue, now } from "./turn";

export type Tools = "full" | "limited";
type Port = { pi: Pi; queue: Promise<unknown>; idle?: ReturnType<typeof setTimeout> };

const STOP_AFTER_MS = 10 * 60_000; // a quiet session's Pi stops; the next question starts it again
const TURN_TIMEOUT_MS = 3 * 60_000;
const ports = new Map<string, Port>();          // `${session}:${tools}`: a tools change starts a new Pi
const lastTurnAt = new Map<string, number>();   // per session, for starting over after a quiet spell

function portFor(session: string, tools: Tools) {
  const key = `${session}:${tools}`;
  let port = ports.get(key);
  if (!port) {
    const pi = new Pi({ prompt: "device.md", mode: "replace", session: "continue", port: session, portTools: tools, mcp: tools === "full" ? "chat" : "port" });
    port = { pi, queue: pi.start(currentModel()) };
    ports.set(key, port);
    pi.exited.then(() => { if (ports.get(key)?.pi === pi) ports.delete(key); });
    stopWhenIdle(key, port);
  }
  return port;
}

function stopWhenIdle(key: string, port: Port) {
  clearTimeout(port.idle);
  port.idle = setTimeout(() => { if (ports.get(key) === port) { ports.delete(key); port.pi.stop(); } }, STOP_AFTER_MS);
}

/** Start a session's Pi while someone is still speaking (the button went down): it takes seconds. */
export function warmPort(session: string, tools: Tools) { portFor(session, tools); }

/** One thing said to a device, answered in its session. Returns the answer. */
export async function talk(session: string, device: { name: string }, text: string, opts: { tools: Tools; idleMin: number; header: string }): Promise<string> {
  const port = portFor(session, opts.tools);
  const key = `${session}:${opts.tools}`;
  clearTimeout(port.idle);
  const run = async () => {
    const t0 = performance.now();
    if (opts.tools === "full") await Promise.all([cancelReview(), cancelTidy()]); // it edits the notes in place
    const last = lastTurnAt.get(session);
    if (opts.idleMin > 0 && last && Date.now() - last > opts.idleMin * 60_000) await port.pi.newSession(); // a new conversation
    lastTurnAt.set(session, Date.now());
    let error = "";
    const run = port.pi.run(`[지금: ${now()}] ${opts.header}\n${text}`, (e) => {
      if (e.type === "message_end" && e.message?.role === "assistant" && e.message.stopReason === "error") error = String(e.message.errorMessage ?? "error");
    });
    const finished = await Promise.race([run.then(() => true), Bun.sleep(TURN_TIMEOUT_MS).then(() => false)]);
    if (!finished) await port.pi.abort();
    const reply = finished && !error ? (await port.pi.lastText())?.trim() ?? "" : "";
    if (opts.tools === "full") await memory.checkpoint("change", `[${device.name}] ${text}`).catch((err) => console.error("device turn commit failed", err));
    log("port_turn", { session, device: device.name, tools: opts.tools, text, totalMs: Math.round(performance.now() - t0), error: error ? error.slice(0, 200) : finished ? undefined : "timeout" });
    // The idle review reads device conversations too ("[거실] …"), to catch what was worth keeping.
    queueForReview({ t: new Date().toISOString(), user: `[${device.name}] ${text}`, reply, saved: [] });
    return reply || "지금은 답하기 어려워요. 잠시 뒤에 다시 말해 주세요.";
  };
  const turn = port.queue.catch(() => {}).then(() => (opts.tools === "full" ? inTurnQueue(run) : run()));
  port.queue = turn;
  try { return await turn; } finally { stopWhenIdle(key, port); }
}
