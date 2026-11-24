// Spare phones and tablets joined to Kkachi as devices. A device opens /device, connects over a
// WebSocket and does things for the agent (speak, for now). A new device waits until you allow it
// in the app's settings; allowed devices are remembered in data/devices.json with a secret token.
//
// Device → server: {type:"hello", name, token?, armed}, {type:"state", armed}, {type:"done"|"failed", id, error?}
// Server → device: {type:"pending"|"ready", name, token}, {type:"speak", id, text, audio, mime}, {type:"forgotten"}
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerWebSocket, WebSocketHandler } from "bun";
import { config } from "./config";
import { log } from "./log";
import { synthesize } from "./speech";

type Socket = ServerWebSocket<{ id?: string }>;
interface Device { id: string; name: string; token: string; allowed: boolean; armed: boolean; socket?: Socket }

const file = join(config.dataDir, "devices.json");
const devices = new Map<string, Device>(); // allowed ones, plus pending ones while they are connected
for (const d of existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : []) devices.set(d.id, { ...d, allowed: true, armed: false });

function save() {
  const allowed = [...devices.values()].filter((d) => d.allowed).map(({ id, name, token }) => ({ id, name, token }));
  writeFileSync(file, JSON.stringify(allowed, null, 2), { mode: 0o600 });
}
const send = (d: Device, msg: object) => d.socket?.send(JSON.stringify(msg));
const randomId = () => Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("hex");
const cleanName = (name: unknown) => String(name ?? "").replace(/\s+/g, " ").trim().slice(0, 40) || "이름 없는 기기";

export type DeviceInfo = { id: string; name: string; allowed: boolean; online: boolean; armed: boolean };
export const listDevices = (): DeviceInfo[] =>
  [...devices.values()].map(({ id, name, allowed, armed, socket }) => ({ id, name, allowed, online: !!socket, armed: !!socket && armed }));

export function allowDevice(id: string): boolean {
  const d = devices.get(id);
  if (!d) return false;
  d.allowed = true;
  save();
  send(d, { type: "ready", name: d.name, token: d.token });
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

export const deviceSocket: WebSocketHandler<{ id?: string }> = {
  message(ws, raw) {
    let msg: any;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (msg.type === "hello") {
      const token = typeof msg.token === "string" && /^[0-9a-f]{48}$/.test(msg.token) ? msg.token : randomId();
      let d = [...devices.values()].find((x) => x.token === token);
      if (d?.socket && d.socket !== ws) d.socket.close(); // the same device reconnected; drop the stale socket
      if (!d) { // new, or pending before a server restart: waits for approval again
        d = { id: randomId().slice(0, 12), name: cleanName(msg.name), token, allowed: false, armed: false };
        devices.set(d.id, d);
      }
      d.socket = ws;
      d.armed = !!msg.armed;
      ws.data.id = d.id;
      send(d, { type: d.allowed ? "ready" : "pending", name: d.name, token: d.token });
      return;
    }
    const d = ws.data.id ? devices.get(ws.data.id) : undefined;
    if (!d) return;
    if (msg.type === "state") d.armed = !!msg.armed;
    if ((msg.type === "done" || msg.type === "failed") && typeof msg.id === "string") {
      waiting.get(msg.id)?.(msg.type === "done" ? null : String(msg.error ?? "playback failed"));
    }
  },
  close(ws) {
    const d = ws.data.id ? devices.get(ws.data.id) : undefined;
    if (!d || d.socket !== ws) return;
    d.socket = undefined;
    if (!d.allowed) devices.delete(d.id); // a pending request lasts as long as its page is open
  },
};

// Find an allowed device by name ("거실", "거실 폰"), forgiving case and spaces, or by id.
function find(target: string): Device | undefined {
  const key = (s: string) => s.toLowerCase().replace(/\s+/g, "");
  const allowed = [...devices.values()].filter((d) => d.allowed);
  return allowed.find((d) => d.id === target) ?? allowed.find((d) => key(d.name) === key(target))
    ?? allowed.find((d) => key(d.name).includes(key(target)) || key(target).includes(key(d.name)));
}

export function describeDevices(): string {
  const allowed = listDevices().filter((d) => d.allowed);
  if (!allowed.length) return "No devices yet. The user can add one by opening /device on a spare phone or tablet and allowing it in Kkachi's settings.";
  return allowed.map((d) => `- ${d.name}: ${!d.online ? "offline" : d.armed ? "online, can speak" : "online, needs a tap on its screen before it can speak"}`).join("\n");
}

const waiting = new Map<string, (error: string | null) => void>();
const PLAY_TIMEOUT_MS = 60_000;

/** Speak text out loud on a device; resolves once the device has played it. */
export async function speakOn(target: string, text: string): Promise<string> {
  const d = find(target);
  if (!d) throw new Error(`No device named "${target}".\n${describeDevices()}`);
  if (!d.socket) throw new Error(`${d.name} is offline: its /device page is closed or the screen is off.`);
  if (!d.armed) throw new Error(`${d.name} needs a tap on its screen before it can play sound.`);
  const { audio, type } = await synthesize(text.slice(0, 1000));
  const id = crypto.randomUUID();
  const played = new Promise<string | null>((resolve) => {
    waiting.set(id, resolve);
    setTimeout(() => resolve("no answer from the device"), PLAY_TIMEOUT_MS);
  });
  send(d, { type: "speak", id, text, audio: Buffer.from(audio).toString("base64"), mime: type });
  const error = await played;
  waiting.delete(id);
  log("device_speak", { name: d.name, chars: text.length, error: error ?? undefined });
  if (error) throw new Error(`${d.name} could not play it: ${error}`);
  return `Said it on ${d.name}.`;
}
