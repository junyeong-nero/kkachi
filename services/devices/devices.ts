// Spare phones and tablets joined to Kkachi as devices. A device opens /device, connects over a
// WebSocket and does things for agents: speak, take a photo, measure sound, read its sensors, act
// as a lamp. A new device waits until you allow it in the app's settings; allowed devices are
// remembered in data/devices.json with a secret token. Photos and readings pass through memory only.
// The messages below are written up in PROTOCOL.md.
//
// Device → server: {type:"hello", name, token?, armed, features, version},
//   {type:"state", armed, perms} (sound unlocked, permissions granted),
//   {type:"result", id, ok, data?|error?}, {type:"warm"} (talk button went down: core gets ready),
//   {type:"input", id, kind:"talk", age, audio, mime} (something said; acked once core has it, docs/bus.md),
//   {type:"value", kind:"dial"|"click", value} (its dial moved, 0 to 100, or its button was pressed; never acked or sent again),
//   {type:"done"|"failed", id, error?} (pages from before "result")
// Server → device: {type:"pending"|"ready", name, token}, {type:"forgotten"}, {type:"update"},
//   {type:"use", pads, agent} (which pads to show, and what is open to the agent: set in the phone app),
//   {type:"ack", id, ok, error?}, {type:"reply", inputId, heard, text?, elsewhere?, audio?, mime?},
//   requests with an id: {type:"speak", text, audio, mime, from?} (from: a recording from that device, not Kkachi's words), {type:"snapshot", camera},
//   {type:"sound", seconds}, {type:"sensors"}, {type:"light", on, color, brightness},
//   and without an id, nothing to answer: {type:"dim", brightness} (a dial joined to its lamp moved),
//   {type:"dim", toggle:true} (a button joined to it was pressed)
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerWebSocket, WebSocketHandler } from "bun";
import { core, speech } from "./core";
import { dataDir, log } from "./data";
import type { Content } from "./lib/mcp-server";

type Socket = ServerWebSocket<{ id?: string }>;
type Features = Record<string, boolean>;
interface Device {
  id: string; name: string; token: string; allowed: boolean; armed: boolean; socket?: Socket;
  form?: "phone" | "tablet"; // what kind of thing it is, for its picture in the app; kept, so an offline one still has it
  features: Features; // web APIs the browser has
  perms: Features;    // mic, camera, motion, location: allowed on the device
  agent?: Features;   // which of its inputs and outputs are open to Kkachi (the agent), chosen in the phone app; kept
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

// What a device has to give, as inputs and outputs. Two questions are kept apart:
// - can(): what works there right now (online, sound unlocked, permission given). Anything that works
//   can be joined straight to another device (core's router), whatever the agent may use.
// - opened(): what is open to the agent. Chosen in the phone app and nowhere else, and everything is
//   open on a new device: its voice reaches the agent (in the app, the link "음성 → 에이전트"), and the
//   agent may use its speaker, lamp and sensors. A button and a dial never go to the agent: they are
//   joined to outputs.
const CAPS = ["talk", "click", "dial", "photo", "sound level", "motion sensors", "location", "speak", "lamp"] as const;
const PADS = ["talk", "click", "dial"] as const; // the inputs that are something to touch on the device's screen
function can(d: Device): string[] {
  if (!d.socket) return [];
  return [
    d.armed && "speak",
    d.form === "tablet" && "lamp", // a lit lamp is the whole screen: on a phone it lay over the pads and took their touches
    d.armed && d.perms.mic && "talk",
    d.perms.camera && "photo",
    d.armed && d.perms.mic && "sound level",
    d.perms.motion && "motion sensors",
    d.perms.location && "location",
    "dial", "click",
  ].filter((x): x is string => !!x);
}
const opened = (d: Device, cap: string) => cap !== "dial" && cap !== "click" && d.agent?.[cap] !== false; // a button and a dial are for outputs only

// Which inputs of each device are joined straight to an output: told by core whenever its links change.
const joined = new Map<string, Set<string>>();
/** A pad shows on a device's screen for each input that goes somewhere: to the agent, or to an output. */
const pads = (d: Device) => PADS.filter((k) => opened(d, k) || joined.get(d.id)?.has(k));
const tellUse = (d: Device) => send(d, { type: "use", pads: pads(d), agent: Object.fromEntries(CAPS.map((c) => [c, opened(d, c)])) });

export function setJoined(links: unknown) {
  joined.clear();
  for (const [id, kinds] of Object.entries((links ?? {}) as Record<string, unknown>)) if (Array.isArray(kinds)) joined.set(id, new Set(kinds.map(String)));
  for (const d of devices.values()) if (d.allowed) tellUse(d);
  return "ok";
}
/** Open one of a device's inputs or outputs to Kkachi, or close it (the phone app's agent screen). */
export function setAgent(id: string, cap: unknown, open: unknown): boolean {
  const d = devices.get(id);
  if (!d?.allowed || !CAPS.includes(cap as (typeof CAPS)[number]) || cap === "dial" || cap === "click") return false;
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
      if (d?.socket && d.socket !== ws) d.socket.close(); // the same device reconnected; drop the stale socket
      if (!d) { // new, or pending before a server restart: waits for approval again
        d = { id: randomId().slice(0, 12), name: cleanName(msg.name), token, allowed: false, armed: false, features: {}, perms: {} };
        devices.set(d.id, d);
      }
      d.socket = ws;
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
      if (d.allowed && last && Date.now() - last.at < REPLY_KEEP_MS) send(d, last.msg);
      return;
    }
    const d = ws.data.id ? devices.get(ws.data.id) : undefined;
    if (!d) return;
    if (msg.type === "state") {
      d.armed = !!msg.armed;
      if (msg.perms) d.perms = bools(msg.perms);
    }
    if (msg.type === "warm" && d.allowed && opened(d, "talk")) core("/api/bus/warm", { source: { id: d.id, name: d.name } }).catch(() => {});
    if (msg.type === "input") receive(d, msg);
    if (msg.type === "value" && d.allowed && (msg.kind === "dial" || msg.kind === "click") && pads(d).includes(msg.kind) && Number.isFinite(msg.value)) {
      core("/api/bus/value", { source: { id: d.id, name: d.name }, kind: msg.kind, value: msg.value }, 3000).catch(() => {}); // core away: it is lost; a dial's next value is newer anyway
    }
    if (typeof msg.id === "string") {
      if (msg.type === "result") waiting.get(msg.id)?.({ ok: !!msg.ok, data: msg.data, error: msg.error });
      if (msg.type === "done") waiting.get(msg.id)?.({ ok: true });
      if (msg.type === "failed") waiting.get(msg.id)?.({ ok: false, error: msg.error });
    }
  },
  close(ws) {
    const d = ws.data.id ? devices.get(ws.data.id) : undefined;
    if (!d || d.socket !== ws) return;
    d.socket = undefined;
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
  if (!pads(d).includes("talk")) return ack(false, "switched off"); // it goes nowhere: not open to the agent, not joined to anything
  if (typeof msg.audio !== "string" || msg.audio.length > MAX_AUDIO_CHARS) return ack(false, "bad audio");
  if (!process.env.KKACHI_CORE_URL) return ack(false, "no agent"); // running on its own: nobody to hear it
  for (const [k, v] of seen) if (Date.now() - v.at > 10 * 60_000) seen.delete(k);
  const prior = seen.get(id);
  if (prior) { if (prior.done) ack(true); return; } // a resend: already with core, or still on its way
  seen.set(id, { at: Date.now(), done: false });
  try {
    const r = await core("/api/bus/input", { id, source: { id: d.id, name: d.name }, kind: msg.kind, age: Number(msg.age) || 0, audio: msg.audio, mime: String(msg.mime ?? "audio/wav"), agent: opened(d, "talk") }, 15_000);
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
const replies = new Map<string, { msg: object; at: number }>();
export async function replyOn(target: string, a: { inputId: string; heard: string; text?: string; elsewhere?: string }): Promise<string> {
  const d = find(target);
  if (!d) throw new Error(`No device named "${target}".`);
  // Without audio the device says the text with its own voice, at this rate.
  const aloud = !!a.text && d.armed && opened(d, "speak"); // its speaker is Kkachi's to use: otherwise the words only show
  const said = aloud ? await speech(a.text!).catch(() => ({ rate: 0 })) : { rate: 0, quiet: true };
  const msg = { type: "reply", ...a, ...said };
  replies.set(d.id, { msg, at: Date.now() });
  send(d, msg);
  log("device_reply", { name: d.name, heard: !!a.heard, audio: "audio" in said, elsewhere: !!a.elsewhere, online: !!d.socket });
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
const NEEDS: Record<string, string[]> = { speak: ["speak"], snapshot: ["photo"], sound: ["sound level"], sensors: ["motion sensors", "location"], light: ["lamp"] };

export function describeDevices(): string {
  const allowed = listDevices().filter((d) => d.allowed);
  if (!allowed.length) return "No devices yet. The user can add one by opening /device on a spare phone or tablet and allowing it in Kkachi's settings.";
  return allowed.map((d) => {
    const yours = d.can.filter((c) => d.agent[c]), closed = d.can.filter((c) => !d.agent[c] && c !== "dial" && c !== "click");
    return `- ${d.name}: ${!d.online ? "offline" : `online; can: ${yours.join(", ") || "nothing right now"}${closed.length ? `; not open to you (the user closed them in the phone app): ${closed.join(", ")}` : ""}${d.armed ? "" : " (needs a tap on its screen to make sound)"}`}`;
  }).join("\n");
}

/** Send a request to a device and wait for its result. */
/** The device for a request, or why it cannot take it (offline, needs a tap, switched off, ...). */
function ready(target: string, type: string, opts: { armed?: boolean; agent?: boolean } = {}): Device { // agent: asked by Kkachi, not by a link
  const d = find(target);
  if (!d) throw new Error(`No device named "${target}".\n${describeDevices()}`);
  if (!d.socket) throw new Error(`${d.name} is offline: its /device page is closed or the screen is off.`);
  const needs = NEEDS[type] ?? [];
  if (opts.agent && needs.length && !needs.some((n) => opened(d, n))) throw new Error(`${d.name} cannot do this: the user has not opened it to Kkachi (phone app, the agent screen).`);
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

/** What was said on another device, played here as it was recorded (core's router: a walkie-talkie).
 * Resolves once it has been played. */
export async function playOn(target: string, a: any): Promise<string> {
  if (typeof a?.audio !== "string" || a.audio.length > MAX_AUDIO_CHARS) throw new Error("bad audio");
  const from = cleanName(a.from);
  const { name } = await ask(target, { type: "speak", text: `${from}에서 온 말`, from, audio: a.audio, mime: String(a.mime ?? "audio/wav"), rate: 0 }, 60_000, { armed: true });
  return `Played it on ${name}.`;
}

/** For an input joined to a lamp (core's router), sent one way and not waited for: the brightness
 * alone from a dial, or a toggle from a button. */
export function dimOn(target: string, a: any): string {
  const d = ready(target, "light");
  send(d, a?.toggle ? { type: "dim", toggle: true } : { type: "dim", brightness: Math.min(100, Math.max(0, Number(a?.brightness) || 0)) });
  return "sent";
}

export async function lightOn(target: string, a: any): Promise<string> {
  const on = !!a?.on, color = String(a?.color ?? "#ffe6c4").slice(0, 40), brightness = Math.min(100, Math.max(0, Number(a?.brightness ?? 100)));
  const { name } = await ask(target, { type: "light", on, color, brightness }, 10_000, { agent: true });
  return on ? `Lamp on in ${name}: ${color} at ${brightness}%.` : `Lamp off in ${name}.`;
}
