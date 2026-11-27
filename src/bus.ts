// What spare devices say (docs/bus.md). An input is accepted once, while it is fresh, then answered
// in the session the settings pick, and the answer goes where the settings say: back to the device
// that heard it, to Kkachi Home, or both. The device only waits for the acceptance (its ack).
import { type Input, makeInbox } from "./inbox";
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
  let heard = "";
  try {
    heard = await polish(await transcribe(new Blob([Buffer.from(e.audio, "base64")], { type: e.mime || "audio/wav" })));
  } catch (err) { console.error("device input stt failed", err); }
  await respond({ id: e.id, source: e.source }, heard, t0);
}

/** What was said on a device, as words, to the agent, and the agent's answer to where the settings say. */
async function respond(e: { id: string; source: { id: string; name: string } }, heard: string, t0 = performance.now()) {
  const s = settings();
  const reply = (r: { heard: string; text?: string; elsewhere?: string; part?: number; last?: boolean; show?: string }) =>
    callTool("devices", "device_reply", { device: e.source.id, inputId: e.id, ...r }).catch((err) => console.error("device reply failed", err));
  if (!heard) return reply({ heard: "" });
  const t1 = performance.now();
  const toPhone = s.deviceReply !== "source", toDevice = s.deviceReply !== "phone";

  // The answer goes to the device a sentence at a time, each as soon as it is written, so the device
  // starts speaking while the agent is still writing (and each sentence's voice is made on its own, side
  // by side). Waiting for the whole answer and then for one voice file of all of it took 10 to 30 s.
  const sent: Promise<unknown>[] = [];
  let parts = 0, firstMs = 0;
  const say = (words: string) => {
    if (!toDevice || !words.trim()) return;
    if (!parts) firstMs = Math.round(performance.now() - t1);
    sent.push(reply({ heard, text: words.trim(), part: parts++ }));
  };

  const header = `[기기: ${e.source.name}${PRIVACY[s.devicePrivacy] ?? ""}]`;
  let text = "";
  if (s.deviceSession === "all") { // a turn in Kkachi Home's conversation
    await runTurn(heard, (ev) => {
      if (ev.type === "delta") text += ev.text;
      if (ev.type === "aside") text = ""; // what was said before a tool call ("찾아볼게요") has been spoken, as a sign of life; it is not the answer
      if (ev.type === "sentence") say(ev.text);
      if (ev.type === "error") { if (!text) text = ev.message; say(ev.message); }
    }, [], { device: e.source.name, header });
    text = text.trim();
  } else {
    text = await talk(s.deviceSession === "home" ? "home" : e.source.id, e.source, heard, { tools: s.deviceTools, idleMin: s.deviceIdleMin, header });
    for (const sentence of text.split(/(?<=[.!?…。])\s+|\n+/)) say(sentence); // its Pi gives the answer whole: still a voice per sentence, side by side
  }
  const t2 = performance.now();

  if (toPhone || s.deviceSession === "all") pushFeed({ kind: "turn", from: e.source.name, heard, text, speak: toPhone });
  if (!toDevice) await reply({ heard, elsewhere: ELSEWHERE });
  else {
    if (!parts) say(text || "지금은 답하기 어려워요. 잠시 뒤에 다시 말해 주세요.");
    sent.push(reply({ heard, part: parts++, last: true, show: text })); // ends it, and leaves the answer on its screen
    await Promise.all(sent);
  }
  const ms = (a: number, b: number) => Math.round(b - a);
  log("device_input", { device: e.source.name, session: s.deviceSession, reply: s.deviceReply, sttMs: ms(t0, t1), firstMs, turnMs: ms(t1, t2), replyMs: ms(t2, performance.now()), parts });
}

export const accept = makeInbox((e) => { answer(e).catch((err) => console.error("device input failed", err)); });

/** The talk button went down: start the Pi that will answer, unless it is Kkachi Home's (always running). */
export function warm(source: { id: string }) {
  const s = settings();
  if (s.deviceSession !== "all") warmPort(s.deviceSession === "home" ? "home" : source.id, s.deviceTools);
}

export function parseInput(body: any): Input | null {
  const ok = typeof body?.id === "string" && /^[\w-]{8,64}$/.test(body.id)
    && typeof body.source?.id === "string" && typeof body.source?.name === "string"
    && body.kind === "talk" && typeof body.audio === "string" && typeof body.age === "number";
  return ok ? { id: body.id, source: { id: body.source.id, name: body.source.name }, kind: "talk", age: body.age, audio: body.audio, mime: String(body.mime ?? "audio/wav") } : null;
}
