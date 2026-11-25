// A device as a port: someone in the room holds the button on /device, speaks, and Kkachi answers out
// loud on that device. Anyone nearby can talk to it, so it gets far less than the phone app: its own
// Pi process and session (no personal conversation carries over) with only the memory and device
// tools (see PiOptions.port). Memory changes are commits made through src/memory-mcp.ts.
import { log } from "./log";
import { currentModel } from "./models";
import { Pi } from "./pi";
import { recordTurn as queueForReview } from "./review";
import { now } from "./turn";

const IDLE_MS = 10 * 60_000; // a quiet port's Pi stops; the next question starts it again (same session)
const TURN_TIMEOUT_MS = 3 * 60_000;
const ports = new Map<string, { pi: Pi; queue: Promise<unknown>; idle?: ReturnType<typeof setTimeout> }>();

function portFor(id: string) {
  let port = ports.get(id);
  if (!port) {
    const pi = new Pi({ prompt: "device.md", mode: "replace", session: "continue", port: id });
    port = { pi, queue: pi.start(currentModel()) };
    ports.set(id, port);
    pi.exited.then(() => { if (ports.get(id)?.pi === pi) ports.delete(id); });
    stopWhenIdle(id, port);
  }
  return port;
}

function stopWhenIdle(id: string, port: NonNullable<ReturnType<typeof ports.get>>) {
  clearTimeout(port.idle);
  port.idle = setTimeout(() => { if (ports.get(id) === port) { ports.delete(id); port.pi.stop(); } }, IDLE_MS);
}

/** Start a device's Pi while someone is still speaking (the button went down): it takes seconds. */
export function warmPort(id: string) { portFor(id); }

/** One spoken question from a device. Returns the reply to read aloud there. */
export async function talk(device: { id: string; name: string }, text: string): Promise<string> {
  const port = portFor(device.id);
  clearTimeout(port.idle);
  const turn = port.queue.catch(() => {}).then(async () => {
    const t0 = performance.now();
    let error = "";
    const run = port.pi.run(`[지금: ${now()}] [기기: ${device.name}]\n${text}`, (e) => {
      if (e.type === "message_end" && e.message?.role === "assistant" && e.message.stopReason === "error") error = String(e.message.errorMessage ?? "error");
    });
    const finished = await Promise.race([run.then(() => true), Bun.sleep(TURN_TIMEOUT_MS).then(() => false)]);
    if (!finished) await port.pi.abort();
    const reply = finished && !error ? (await port.pi.lastText())?.trim() ?? "" : "";
    log("port_turn", { device: device.name, text, totalMs: Math.round(performance.now() - t0), error: error ? error.slice(0, 200) : finished ? undefined : "timeout" });
    // The idle review reads port conversations too ("[거실] …"), to catch what was worth keeping.
    queueForReview({ t: new Date().toISOString(), user: `[${device.name}] ${text}`, reply, saved: [] });
    return reply || "지금은 답하기 어려워요. 잠시 뒤에 다시 말해 주세요.";
  });
  port.queue = turn;
  try { return await turn; } finally { stopWhenIdle(device.id, port); }
}
