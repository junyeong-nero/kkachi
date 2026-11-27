// Spare phones and tablets joined to Kkachi as devices. A device opens /device, connects over a
// WebSocket and does things for agents: speak, take a photo, measure sound, read its sensors, act
// as a lamp. Kkachi Home can read its sensors too, to show what is happening in that room. A new device waits until you allow it in the app's settings; allowed devices are
// remembered in data/devices.json with a secret token. Photos and readings pass through memory only.
// The messages below are written up in PROTOCOL.md.
//
// Device → server: {type:"hello", name, token?, armed, features, version},
//   {type:"state", armed, perms} (sound unlocked, permissions granted),
//   {type:"result", id, ok, data?|error?},
//   {type:"input", id, kind:"talk", age, audio, mime} (something said; acked once core has it, docs/bus.md),
//   {type:"done"|"failed", id, error?} (pages from before "result")
// Server → device: {type:"pending"|"ready", name, token}, {type:"forgotten"}, {type:"update"},
//   {type:"use", pads, agent} (whether the talk pad shows, and what is open to the agent: set in Kkachi Home),
//   {type:"ack", id, ok, error?}, {type:"reply", inputId, heard, text?, audio?, mime?},
//   requests with an id: {type:"speak", text, audio, mime}, {type:"snapshot", camera},
//   {type:"sound", seconds}, {type:"sensors"}, {type:"brightness"}, {type:"light", on, color, brightness}
//   (by: "home" on a request from Kkachi Home, not the agent: the page's log says so)
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerWebSocket, WebSocketHandler } from "bun";
import { core, speech } from "./core";
import { dataDir, log } from "./data";
import type { Content } from "./lib/mcp-server";
import { type Brightness, brightnessFrom } from "./brightness";

type Socket = ServerWebSocket<{ id?: string }>;
type Features = Record<string, boolean>;
interface Device {
  id: string; name: string; token: string; allowed: boolean; armed: boolean; socket?: Socket;
  form?: "phone" | "tablet"; // what kind of thing it is, for its picture in the app; kept, so an offline one still has it
  features: Features; // web APIs the browser has
  perms: Features;    // mic, camera, motion, location: allowed on the device
  agent?: Features;   // which of its inputs and outputs are open to Kkachi (the agent), chosen in Kkachi Home; kept
  since?: number;     // when its socket opened, for the log
}
const bools = (o: unknown): Features => o && typeof o === "object" ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, !!v])) : {};

const file = join(dataDir, "devices.json");
const devices = new Map<string, Device>(); // allowed ones, plus pending ones while they are connected
for (const d of existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : []) devices.set(d.id, { ...d, allowed: true, armed: false, features: {}, perms: {} });

function save() {
  const allowed = [...devices.values()].filter((d) => d.allowed).map(({ id, name, token, form, agent }) => ({ id, name, token, form, agent }));
  writeFileSync(file, JSON.stringify(allowed, null, 2), { mode: 0o600 });
}
const send = (d: Device, msg: object) => d.socket?.send(JSON.stringify(msg));
const randomId = () => Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("hex");
const cleanName = (name: unknown) => String(name ?? "").replace(/\s+/g, " ").trim().slice(0, 40) || "이름 없는 기기";

// The page's version: a device sits unattended for days, so it is told when /device has changed.
export const page = join(import.meta.dir, "device.html");
export const pageVersion = () => createHash("sha1").update(readFileSync(page)).digest("hex").slice(0, 12);

// What a device has to give. Two questions are kept apart:
// - can(): what works there right now (online, sound unlocked, permission given).
// - opened(): what is open to the agent. Chosen in Kkachi Home and nowhere else, and everything is
//   open on a new device: its voice reaches the agent, and the agent may use its speaker, lamp,
//   camera and sensors.
const CAPS = ["talk", "photo", "sound level", "motion sensors", "location", "speak", "lamp"] as const;
function can(d: Device): string[] {
  if (!d.socket) return [];
  return [
    d.armed && "speak",
    d.form === "tablet" && "lamp", // a lit lamp is the whole screen: on a phone it lay over the talk pad and took its touches
    d.armed && d.perms.mic && "talk",
    d.perms.camera && "photo",
    d.armed && d.perms.mic && "sound level",
    d.perms.motion && "motion sensors",
    d.perms.location && "location",
  ].filter((x): x is string => !!x);
}
const opened = (d: Device, cap: string) => d.agent?.[cap] !== false;
/** The talk pad shows on a device's screen while its voice is open to the agent: it goes nowhere else. */
const tellUse = (d: Device) => send(d, { type: "use", pads: opened(d, "talk") ? ["talk"] : [], agent: Object.fromEntries(CAPS.map((c) => [c, opened(d, c)])) });
/** Open one of a device's inputs or outputs to Kkachi, or close it (Kkachi Home's agent screen). */
export function setAgent(id: string, cap: unknown, open: unknown): boolean {
  const d = devices.get(id);
  if (!d?.allowed || !CAPS.includes(cap as (typeof CAPS)[number])) return false;
  d.agent = { ...d.agent, [cap as string]: !!open };
  save();
  tellUse(d);
  log("device_agent", { name: d.name, cap, open: !!open });
  return true;
}

export type DeviceInfo = { id: string; name: string; kind: string; allowed: boolean; online: boolean; armed: boolean; can: string[]; agent: Features; features: Features };
export const listDevices = (): DeviceInfo[] =>
  [...devices.values()].map((d) => ({ id: d.id, name: d.name, kind: d.form ?? "phone", allowed: d.allowed, online: !!d.socket, armed: !!d.socket && d.armed, can: can(d), agent: Object.fromEntries(CAPS.map((c) => [c, opened(d, c)])), features: d.features }));

export function allowDevice(id: string): boolean {
  const d = devices.get(id);
  if (!d) return false;
  d.allowed = true;
  save();
  send(d, { type: "ready", name: d.name, token: d.token });
  tellUse(d);
  log("device_allowed", { name: d.name });
  return true;
}

export function forgetDevice(id: string): boolean {
  const d = devices.get(id);
  if (!d) return false;
  devices.delete(id);
  save();
  send(d, { type: "forgotten" });
  d.socket?.close();
  log("device_forgotten", { name: d.name });
  return true;
}

const waiting = new Map<string, (r: { ok: boolean; data?: any; error?: string }) => void>();

export const deviceSocket: WebSocketHandler<{ id?: string }> = {
  message(ws, raw) {
    let msg: any;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (msg.type === "hello") {
      const token = typeof msg.token === "string" && /^[0-9a-f]{48}$/.test(msg.token) ? msg.token : randomId();
      let d = [...devices.values()].find((x) => x.token === token);
      // The same device again, from another page (a second tab, the same address opened twice): the new
      // one wins, and the old one is told, so that it stops. Untold, it took the close for a lost
      // connection and came back, which closed the new one, and the two knocked each other off for good.
      if (d?.socket && d.socket !== ws) { const old = d.socket; d.socket = undefined; try { old.send(JSON.stringify({ type: "replaced" })); } catch {} old.close(); if (d.allowed) log("device_replaced", { name: d.name }); }
      if (!d) { // new, or pending before a server restart: waits for approval again
        d = { id: randomId().slice(0, 12), name: cleanName(msg.name), token, allowed: false, armed: false, features: {}, perms: {} };
        devices.set(d.id, d);
      }
      d.socket = ws; d.since = Date.now();
      if (d.allowed) log("device_online", { name: d.name });
      const form = msg.form === "tablet" ? "tablet" : "phone"; // pages from before this say nothing: a phone
      if (d.form !== form) { d.form = form; if (d.allowed) save(); }
      d.armed = !!msg.armed;
      d.features = bools(msg.features);
      d.perms = {}; // a fresh page reports them in its next "state"
      ws.data.id = d.id;
      send(d, { type: d.allowed ? "ready" : "pending", name: d.name, token: d.token });
      if (d.allowed) tellUse(d);
      if (msg.version !== pageVersion()) send(d, { type: "update" });
      const last = replies.get(d.id); // an answer that came while the page was away
      if (d.allowed && last && Date.now() - last.at < REPLY_KEEP_MS) for (const m of last.msgs) send(d, m);
      return;
    }
    // The page says it is there every 25 s, and takes silence for a dead connection (a phone's network
    // can drop one without either end hearing of it).
    if (msg.type === "ping") { ws.send('{"type":"pong"}'); return; }
    const d = ws.data.id ? devices.get(ws.data.id) : undefined;
    if (!d) return;
    if (msg.type === "state") {
      d.armed = !!msg.armed;
      if (msg.perms) d.perms = bools(msg.perms);
    }
    if (msg.type === "input") receive(d, msg);
    if (typeof msg.id === "string") {
      if (msg.type === "result") waiting.get(msg.id)?.({ ok: !!msg.ok, data: msg.data, error: msg.error });
      if (msg.type === "done") waiting.get(msg.id)?.({ ok: true });
      if (msg.type === "failed") waiting.get(msg.id)?.({ ok: false, error: msg.error });
    }
  },
  close(ws, code, reason) {
    const d = ws.data.id ? devices.get(ws.data.id) : undefined;
    if (!d || d.socket !== ws) return;
    d.socket = undefined;
    if (d.allowed) log("device_offline", { name: d.name, afterSec: Math.round((Date.now() - (d.since ?? Date.now())) / 1000), code, reason: String(reason ?? "").slice(0, 80) }); // how long it held, to tell a flaky link from a page that was closed
    if (!d.allowed) devices.delete(d.id); // a pending request lasts as long as its page is open
  },
};

// ---- inputs the device starts (docs/bus.md): forwarded to core once, acked when core has them ----
const MAX_AUDIO_CHARS = 4_000_000; // base64, about 3 MB: 30 s of 16 kHz WAV is under 1 MB
const seen = new Map<string, { at: number; done: boolean }>(); // input id -> forwarded (done) or in flight
async function receive(d: Device, msg: any) {
  const id = typeof msg.id === "string" && /^[\w-]{8,64}$/.test(msg.id) ? msg.id : null;
  if (!id) return;
  const ack = (ok: boolean, error?: string) => send(d, { type: "ack", id, ok, ...(error && { error }) });
  if (!d.allowed) return ack(false, "not allowed");
  if (msg.kind !== "talk") return ack(false, "unknown kind");
  if (!opened(d, "talk")) return ack(false, "switched off"); // its voice is closed to the agent: it goes nowhere
  if (typeof msg.audio !== "string" || msg.audio.length > MAX_AUDIO_CHARS) return ack(false, "bad audio");
  if (!process.env.KKACHI_CORE_URL) return ack(false, "no agent"); // running on its own: nobody to hear it
  for (const [k, v] of seen) if (Date.now() - v.at > 10 * 60_000) seen.delete(k);
  const prior = seen.get(id);
  if (prior) { if (prior.done) ack(true); return; } // a resend: already with core, or still on its way
  seen.set(id, { at: Date.now(), done: false });
  try {
    const r = await core("/api/bus/input", { id, source: { id: d.id, name: d.name }, kind: msg.kind, age: Number(msg.age) || 0, audio: msg.audio, mime: String(msg.mime ?? "audio/wav") }, 15_000);
    if (r.accepted) { seen.set(id, { at: Date.now(), done: true }); ack(true); }
    else { seen.delete(id); ack(false, r.reason ?? "refused"); }
  } catch (err) {
    seen.delete(id); // core is away: no ack, and the device sends it again
    console.error("input not forwarded", (err as Error).message);
  }
}

// The answer core sends back to the device that heard it. Kept for two minutes, so a page that was
// away (screen off, reconnecting) still gets it.
const REPLY_KEEP_MS = 2 * 60_000;
const replies = new Map<string, { inputId: string; msgs: object[]; at: number }>(); // per device: the parts of its latest answer
// An answer comes in parts, a sentence each, while the agent is still writing (part: 0, 1, …; last ends
// it). Each part's voice is made as soon as it comes and sent when it is ready, so parts can arrive out
// of order: the page plays them by number. A voice the server is slow to make (Edge TTS sometimes takes
// 20 s) is not waited for past SPEECH_WAIT_MS: the device says that part with its own voice.
const SPEECH_WAIT_MS = 6000;
export async function replyOn(target: string, a: { inputId: string; heard: string; text?: string; part?: number; last?: boolean; show?: string }): Promise<string> {
  const d = find(target);
  if (!d) throw new Error(`No device named "${target}".`);
  // Without audio the device says the text with its own voice, at this rate.
  const aloud = !!a.text && d.armed && opened(d, "speak"); // its speaker is Kkachi's to use: otherwise the words only show
  const said = aloud ? await speech(a.text!, SPEECH_WAIT_MS).catch(() => ({ rate: 0 })) : { rate: 0, quiet: true };
  const msg = { type: "reply", ...a, ...said };
  const kept = replies.get(d.id);
  if (kept?.inputId === a.inputId) { kept.msgs.push(msg); kept.at = Date.now(); }
  else replies.set(d.id, { inputId: a.inputId, msgs: [msg], at: Date.now() });
  send(d, msg);
  log("device_reply", { name: d.name, heard: !!a.heard, audio: "audio" in said, online: !!d.socket });
  return d.socket ? "delivered" : "device offline; kept for two minutes";
}

// Find an allowed device by name ("거실", "거실 폰"), forgiving case and spaces, or by id.
function find(target: string): Device | undefined {
  const key = (s: string) => s.toLowerCase().replace(/\s+/g, "");
  const allowed = [...devices.values()].filter((d) => d.allowed);
  return allowed.find((d) => d.id === target) ?? allowed.find((d) => key(d.name) === key(target))
    ?? allowed.find((d) => key(d.name).includes(key(target)) || key(target).includes(key(d.name)));
}

// What each request needs: one of these abilities (see can()).
const NEEDS: Record<string, string[]> = { speak: ["speak"], snapshot: ["photo"], brightness: ["photo"], sound: ["sound level"], sensors: ["motion sensors", "location"], light: ["lamp"] };

export function describeDevices(): string {
  const allowed = listDevices().filter((d) => d.allowed);
  if (!allowed.length) return "No devices yet. The user can add one by opening /device on a spare phone or tablet and allowing it in Kkachi's settings.";
  return allowed.map((d) => {
    const yours = d.can.filter((c) => d.agent[c]), closed = d.can.filter((c) => !d.agent[c]);
    return `- ${d.name}: ${!d.online ? "offline" : `online; can: ${yours.join(", ") || "nothing right now"}${closed.length ? `; not open to you (the user closed them in Kkachi Home): ${closed.join(", ")}` : ""}${d.armed ? "" : " (needs a tap on its screen to make sound)"}`}`;
  }).join("\n");
}

/** Send a request to a device and wait for its result. */
/** The device for a request, or why it cannot take it (offline, needs a tap, switched off, ...). */
function ready(target: string, type: string, opts: { armed?: boolean; agent?: boolean } = {}): Device { // agent: asked by Kkachi, not by Kkachi Home
  const d = find(target);
  if (!d) throw new Error(`No device named "${target}".\n${describeDevices()}`);
  if (!d.socket) throw new Error(`${d.name} is offline: its /device page is closed or the screen is off.`);
  const needs = NEEDS[type] ?? [];
  if (opts.agent && needs.length && !needs.some((n) => opened(d, n))) throw new Error(`${d.name} cannot do this: the user has not opened it to Kkachi (Kkachi Home, the agent screen).`);
  if (needs.length && !needs.some((n) => can(d).includes(n))) {
    if (opts.armed && !d.armed) throw new Error(`${d.name} needs a tap on its screen first.`);
    throw new Error(`${d.name} cannot do this (${needs.join(" or ")}): not allowed or not supported there (or its page needs a reload).`);
  }
  return d;
}

async function ask(target: string, request: Record<string, unknown> & { type: string }, timeoutMs: number, opts: { armed?: boolean; agent?: boolean } = {}) {
  const d = ready(target, request.type, opts);
  const id = crypto.randomUUID();
  const result = new Promise<{ ok: boolean; data?: any; error?: string }>((resolve) => {
    waiting.set(id, resolve);
    setTimeout(() => resolve({ ok: false, error: "no answer from the device" }), timeoutMs);
  });
  send(d, { ...request, id });
  const r = await result;
  waiting.delete(id);
  log("device_request", { name: d.name, type: request.type, ok: r.ok, error: r.error });
  if (!r.ok) throw new Error(`${d.name} could not do it: ${r.error ?? "unknown error"}`);
  return { name: d.name, data: r.data };
}

/** Speak text out loud on a device; resolves once the device has played it. */
export async function speakOn(target: string, text: string): Promise<string> {
  ready(target, "speak", { armed: true, agent: true }); // before making the speech
  const said = await speech(text); // no audio: the device's own voice
  const { name } = await ask(target, { type: "speak", text, ...said }, 60_000, { armed: true, agent: true });
  return `Said it on ${name}.`;
}


/** One photo from a device's camera, plus how bright it is (0 dark to 100 bright). Not kept. */
export async function snapshotOn(target: string, camera: unknown): Promise<Content[]> {
  const facing = camera === "front" ? "front" : "back";
  const { name, data } = await ask(target, { type: "snapshot", camera: facing }, 20_000, { agent: true });
  if (typeof data?.data !== "string" || !/^[A-Za-z0-9+/]+=*$/.test(data.data)) throw new Error(`${name} sent no photo`);
  return [
    { type: "image", data: data.data, mimeType: "image/jpeg" },
    { type: "text", text: `Photo from ${name} (${facing} camera, ${data.width}×${data.height}). Brightness ${data.brightness}/100.` },
  ];
}

const LEVEL: Record<Brightness["level"], string> = {
  dark: "dark (lights probably off)", dim: "dim", lit: "lit like a room with its lights on", bright: "bright", daylight: "very bright, like daylight",
};

export async function brightnessOn(target: string): Promise<string> {
  const { name, data } = await ask(target, { type: "brightness" }, 15_000, { agent: true });
  const b = brightnessFrom(data ?? {});
  return `${name}: ${LEVEL[b.level]}.${b.lux != null ? ` About ${b.lux} lux (estimated from the camera's exposure).` : ` No exposure reading from this camera, so only dark, dim or lit (auto exposure brightens a dim room).`} Frame brightness ${Math.round(b.luma * 100)}/100. No photo was taken or kept.`;
}

export async function soundLevelOn(target: string, seconds: unknown): Promise<string> {
  const s = Math.min(10, Math.max(1, Number(seconds) || 3));
  const { name, data } = await ask(target, { type: "sound", seconds: s }, (s + 10) * 1000, { armed: true, agent: true });
  const avg = Number(data?.avg), peak = Number(data?.peak);
  const label = avg < -55 ? "quiet" : avg < -35 ? "moderate" : "loud";
  return `${name}: ${label}. Average ${avg.toFixed(0)} dBFS, peak ${peak.toFixed(0)} dBFS over ${s} s (0 is the loudest the mic can take; about -60 is a silent room).`;
}

export async function sensorsOn(target: string): Promise<string> {
  const here = find(target), skip = here ? ["motion sensors", "location"].filter((c) => !opened(here, c)) : []; // read only what is open to Kkachi
  const { name, data } = await ask(target, { type: "sensors", skip }, 15_000, { agent: true });
  const lines = [`${name}:`];
  if (data?.pose) lines.push(`- lying: ${data.pose} (tilt front-back ${data.beta}°, left-right ${data.gamma}°)`);
  if (data?.heading != null) lines.push(`- compass heading: ${data.heading}° (0 = north)`);
  if (data?.lastMovedAgoSec != null) lines.push(`- last moved: ${data.lastMovedAgoSec < 5 ? "moving now" : `${Math.round(data.lastMovedAgoSec / 60)} min ago`} (strongest shake in the last 10 min: ${data.maxRecent} m/s²)`);
  else if (data?.motion) lines.push("- not moved since its page started");
  if (data?.location) lines.push(`- location: ${data.location.lat}, ${data.location.lon} (±${data.location.accuracy} m)`);
  for (const [k, v] of Object.entries(data?.unavailable ?? {})) lines.push(`- ${k}: unavailable (${v})`);
  return lines.join("\n");
}

/** What is happening in a device's room, for Kkachi Home: its sensors, how loud it is, or a photo, as
 * the device gives them. Asked by the user, not the agent, so what is closed to the agent is read too;
 * the device's own log says Kkachi Home asked. Nothing is kept. */
export async function readOn(id: string, what: unknown): Promise<object> {
  const d = devices.get(id);
  if (!d?.allowed) throw new Error("no such device");
  if (what === "sensors") return (await ask(d.id, { type: "sensors", skip: [], by: "home" }, 15_000)).data ?? {};
  if (what === "sound") {
    const { data } = await ask(d.id, { type: "sound", seconds: 2, by: "home" }, 12_000, { armed: true });
    return { avg: Math.round(Number(data?.avg)), peak: Math.round(Number(data?.peak)) };
  }
  if (what === "brightness") return brightnessFrom((await ask(d.id, { type: "brightness", by: "home" }, 15_000)).data ?? {});
  if (what === "photo") {
    const { data } = await ask(d.id, { type: "snapshot", camera: "back", by: "home" }, 20_000);
    if (typeof data?.data !== "string" || !/^[A-Za-z0-9+/]+=*$/.test(data.data)) throw new Error("no photo");
    return { data: data.data, width: data.width, height: data.height, brightness: data.brightness };
  }
  throw new Error("read what?");
}

export async function lightOn(target: string, a: any): Promise<string> {
  const on = !!a?.on, color = String(a?.color ?? "#ffe6c4").slice(0, 40), brightness = Math.min(100, Math.max(0, Number(a?.brightness ?? 100)));
  const { name } = await ask(target, { type: "light", on, color, brightness }, 10_000, { agent: true });
  return on ? `Lamp on in ${name}: ${color} at ${brightness}%.` : `Lamp off in ${name}.`;
}
