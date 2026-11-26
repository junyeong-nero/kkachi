// What spare devices say (docs/bus.md). An input is accepted once, while it is fresh, then answered
// in the session the settings pick, and the answer goes where the settings say: back to the device
// that heard it, to the phone app, or both. The device only waits for the acceptance (its ack).
import { join } from "node:path";
import { config } from "./config";
import { emitFlow } from "./flow";
import { type Input, makeInbox } from "./inbox";
import { makeRouter } from "./router";
import { log } from "./log";
import { callTool } from "./mcp-bridge";
import { polish } from "./polish";
import { talk, warmPort } from "./port";
import { pushFeed } from "./feed";
import { settings } from "./settings";
import { transcribe } from "./speech";
import { runTurn } from "./turn";

const PRIVACY: Record<string, string> = { open: "", guarded: ", 개인 정보: 말하지 않기", phone: ", 개인 정보: 폰으로" };
const ELSEWHERE = "답은 폰에서 볼 수 있어요";

async function answer(e: Input) {
  const t0 = performance.now();
  // What was said goes two ways, side by side. As it was recorded, to every speaker this device's
  // voice is joined to (a walkie-talkie: not transcribed). And as words to the agent, when this
  // device's voice is open to Kkachi.
  const walkie = router.dispatch(e.source, "talk", 1, { audio: e.audio, mime: e.mime || "audio/wav" });
  walkie.then(({ sent, failed }) => { if (sent) log("device_walkie", { device: e.source.name, sent, failed, ms: Math.round(performance.now() - t0) }); });
  if (!e.agent) { // the agent does not hear it: the device is told how the walkie-talkie went
    const { sent, failed } = await walkie;
    const went = !sent ? "보낼 곳이 없어요" : failed === sent ? "전하지 못했어요. 받는 기기가 꺼져 있어요" : "전했어요";
    await callTool("devices", "device_reply", { device: e.source.id, inputId: e.id, heard: "음성", elsewhere: went }).catch((err) => console.error("device reply failed", err));
    return;
  }
  emitFlow(`agent:${e.source.id}`); // for the app's 연결 screen: a voice is on its way to the agent
  let heard = "";
  try {
    heard = await polish(await transcribe(new Blob([Buffer.from(e.audio, "base64")], { type: e.mime || "audio/wav" })));
  } catch (err) { console.error("device input stt failed", err); }
  await respond({ id: e.id, source: e.source }, heard, t0);
}

/** What was said on a device, as words, to the agent, and the agent's answer to where the settings say. */
async function respond(e: { id: string; source: { id: string; name: string } }, heard: string, t0 = performance.now()) {
  const s = settings();
  const reply = (r: { heard: string; text?: string; elsewhere?: string }) =>
    callTool("devices", "device_reply", { device: e.source.id, inputId: e.id, ...r }).catch((err) => console.error("device reply failed", err));
  if (!heard) return reply({ heard: "" });
  const t1 = performance.now();

  const header = `[기기: ${e.source.name}${PRIVACY[s.devicePrivacy] ?? ""}]`;
  let text = "";
  if (s.deviceSession === "all") { // a turn in the phone app's conversation
    await runTurn(heard, (ev) => {
      if (ev.type === "delta") text += ev.text;
      if (ev.type === "aside") text = "";
      if (ev.type === "error" && !text) text = ev.message;
    }, [], { device: e.source.name, header });
    text = text.trim();
  } else {
    text = await talk(s.deviceSession === "home" ? "home" : e.source.id, e.source, heard, { tools: s.deviceTools, idleMin: s.deviceIdleMin, header });
  }
  const t2 = performance.now();

  const toPhone = s.deviceReply !== "source", toDevice = s.deviceReply !== "phone";
  if (toPhone || s.deviceSession === "all") pushFeed({ kind: "turn", from: e.source.name, heard, text, speak: toPhone });
  await reply(toDevice ? { heard, text } : { heard, elsewhere: ELSEWHERE });
  const ms = (a: number, b: number) => Math.round(b - a);
  log("device_input", { device: e.source.name, session: s.deviceSession, reply: s.deviceReply, sttMs: ms(t0, t1), turnMs: ms(t1, t2), replyMs: ms(t2, performance.now()) });
}

/** Inputs joined straight to outputs (src/router.ts), through the devices service's core-only tools.
 * To a lamp: its brightness alone from a dial, or a toggle from a button (device_dim: one way, no
 * waiting for the device). To a speaker: what was said, as recorded (device_play). */
export const router = makeRouter(join(config.dataDir, "routes.json"), async (link, value, source, said) => {
  if (link.to.output === "speak") return callTool("devices", "device_play", { device: link.to.device, from: source.name, ...(said as object) });
  return callTool("devices", "device_dim", link.from.kind === "click" ? { device: link.to.device, toggle: true } : { device: link.to.device, brightness: value });
}, emitFlow);
/** Tell the devices service which inputs are joined to something, so each device shows a pad for them.
 * After a link is made, switched or removed, and once the services are up. */
export const syncLinks = () => callTool("devices", "device_links", { links: router.joined() }).catch((err) => console.error("links not passed on", (err as Error).message));

export const accept = makeInbox((e) => { answer(e).catch((err) => console.error("device input failed", err)); });

/** The talk button went down: start the Pi that will answer, unless it is the phone app's (always running). */
export function warm(source: { id: string }) {
  const s = settings();
  if (s.deviceSession !== "all") warmPort(s.deviceSession === "home" ? "home" : source.id, s.deviceTools);
}

export function parseInput(body: any): Input | null {
  const ok = typeof body?.id === "string" && /^[\w-]{8,64}$/.test(body.id)
    && typeof body.source?.id === "string" && typeof body.source?.name === "string"
    && body.kind === "talk" && typeof body.audio === "string" && typeof body.age === "number";
  return ok ? { id: body.id, source: { id: body.source.id, name: body.source.name }, kind: "talk", age: body.age, audio: body.audio, mime: String(body.mime ?? "audio/wav"), agent: body.agent !== false } : null;
}
