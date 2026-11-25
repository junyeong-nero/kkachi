import { join } from "node:path";
import { checkSetup } from "./check";
import { config } from "./config";
import { log } from "./log";
import { polish } from "./polish";
import { modelOrder } from "./models";
import { settings, THINKING, updateSettings, VOICES } from "./settings";
import { synthesize, transcribe } from "./speech";
import { applyThinking, modelChoices, newConversation, runTurn, startConversation } from "./turn";
import { findTurn, recordTurn, streamTurn } from "./replay";
import type { PiImage } from "./pi";
import { allowDevice, deviceByToken, deviceSocket, forgetDevice, listDevices } from "./devices";
import { talk } from "./port";
import { handleMcp, SERVICES } from "./mcp";

const web = join(import.meta.dir, "web");

// Kkachi runs commands for whoever reaches it, so only its own pages may call it:
// - Host must be this computer (loopback) or its Tailscale name. Tailscale Serve keeps the Host
//   header. Blocks DNS rebinding, where an attacker's domain resolves to 127.0.0.1.
// - A browser's Origin must match Host. Blocks other websites posting to 127.0.0.1:4300.
//   Clients without Origin (curl, Pi, other agents' MCP) are not browsers and pass.
function trusted(req: Request): boolean {
  const host = req.headers.get("host") ?? "";
  const hostname = host.replace(/:\d+$/, "").toLowerCase();
  if (!["127.0.0.1", "localhost", "[::1]"].includes(hostname) && !hostname.endsWith(".ts.net")) return false;
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try { return new URL(origin).host === host; } catch { return false; }
}

// Photos attached to a message (the app sends JPEGs it has already scaled down).
const MAX_IMAGES = 4, MAX_IMAGE_CHARS = 8_000_000; // base64, about 6 MB
function parseImages(value: unknown): PiImage[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_IMAGES) return null;
  const ok = value.every((i) => typeof i?.data === "string" && i.data.length <= MAX_IMAGE_CHARS && /^[A-Za-z0-9+/]+=*$/.test(i.data)
    && ["image/jpeg", "image/png", "image/webp", "image/gif"].includes(i.mimeType));
  return ok ? value.map((i) => ({ data: i.data, mimeType: i.mimeType })) : null;
}

checkSetup();
await startConversation();

Bun.serve({
  port: config.port,
  hostname: "127.0.0.1", // reach it through Tailscale Serve only
  idleTimeout: 255,
  websocket: deviceSocket,
  async fetch(req, server) {
    if (!trusted(req)) return new Response("forbidden", { status: 403 });
    const { pathname } = new URL(req.url);
    try {
      const mcp = pathname.match(/^\/mcp\/(\w+)$/);
      if (mcp && SERVICES[mcp[1]]) return await handleMcp(SERVICES[mcp[1]], req);
      if (pathname === "/api/device/ws") {
        return server.upgrade(req, { data: {} }) ? undefined : new Response("expected a WebSocket", { status: 400 });
      }
      if (req.method === "GET") {
        // no-cache: a home-screen web app otherwise keeps serving an old version after updates
        const noCache = { "Cache-Control": "no-cache" };
        if (pathname === "/") return new Response(Bun.file(join(web, "index.html")), { headers: { ...noCache, "Content-Type": "text/html; charset=utf-8" } });
        if (pathname === "/manifest.webmanifest") return new Response(Bun.file(join(web, "manifest.webmanifest")), { headers: { ...noCache, "Content-Type": "application/manifest+json" } });
        if (pathname === "/app.js") return new Response(Bun.file(join(web, "app.js")), { headers: { ...noCache, "Content-Type": "text/javascript" } });
        // A spare phone or tablet joins as a device here (see src/devices.ts)
        if (pathname === "/device") return new Response(Bun.file(join(web, "device.html")), { headers: { ...noCache, "Content-Type": "text/html; charset=utf-8" } });
        if (pathname === "/api/devices") return Response.json({ devices: listDevices() });
        // Markdown rendering for replies: marked (MIT) and DOMPurify (Apache-2.0/MPL-2.0), vendored unmodified
        if (["/vendor/marked.min.js", "/vendor/purify.min.js"].includes(pathname)) {
          return new Response(Bun.file(join(web, pathname.slice(1))), { headers: { "Content-Type": "text/javascript", "Cache-Control": "max-age=86400" } });
        }
        // App icon generated with Codex image generation (assets/icon/, see DESIGN.md)
        if (["/icon.png", "/apple-touch-icon.png", "/favicon.png"].includes(pathname)) {
          return new Response(Bun.file(join(web, pathname.slice(1))), { headers: { "Content-Type": "image/png" } });
        }
        if (pathname === "/api/settings") {
          return Response.json({ settings: settings(), voices: VOICES, thinking: THINKING, models: await modelChoices(), fallbacks: modelOrder().slice(1) });
        }
      }

      if (req.method === "POST" && pathname === "/api/settings") {
        const next = updateSettings(await req.json());
        await applyThinking(); // model changes apply on the next turn
        log("settings", { ...next });
        return Response.json({ settings: next });
      }

      // Hold to talk on a device: its recording in, the reply (text and speech) out. See src/port.ts.
      if (req.method === "POST" && pathname === "/api/device/talk") {
        const device = deviceByToken(req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "");
        if (!device) return new Response("unknown device", { status: 401 });
        const t0 = performance.now();
        const raw = await transcribe(await req.blob());
        const t1 = performance.now();
        const heard = await polish(raw);
        const t2 = performance.now();
        if (!heard) return Response.json({ heard: "" });
        const reply = await talk(device, heard);
        const t3 = performance.now();
        let speech: { audio: ArrayBuffer; type: string } | null = null;
        try { speech = await synthesize(reply.slice(0, 1000)); } catch (err) { console.error("device reply tts failed", err); } // the device shows the words instead
        const ms = (a: number, b: number) => Math.round(b - a);
        log("device_talk", { device: device.name, sttMs: ms(t0, t1), polishMs: ms(t1, t2), turnMs: ms(t2, t3), ttsMs: ms(t3, performance.now()), tts: !!speech });
        return Response.json({ heard, reply, ...(speech && { audio: Buffer.from(speech.audio).toString("base64"), mime: speech.type }) });
      }

      const deviceAction = req.method === "POST" && pathname.match(/^\/api\/devices\/(\w+)\/(allow|forget)$/);
      if (deviceAction) {
        const ok = deviceAction[2] === "allow" ? allowDevice(deviceAction[1]) : forgetDevice(deviceAction[1]);
        return ok ? Response.json({ devices: listDevices() }) : new Response("no such device", { status: 404 });
      }

      if (req.method === "POST" && pathname === "/api/new-conversation") {
        await newConversation();
        log("new_conversation");
        return new Response(null, { status: 204 });
      }

      if (req.method === "POST" && pathname === "/api/stt") {
        const t0 = performance.now();
        const audio = await req.blob();
        const raw = await transcribe(audio);
        const t1 = performance.now();
        const text = await polish(raw);
        const sttMs = Math.round(t1 - t0), polishMs = Math.round(performance.now() - t1);
        // 16 kHz mono 16-bit WAV: 32000 bytes per second after the 44-byte header.
        log("stt", { audioSec: +((audio.size - 44) / 32000).toFixed(1), sttMs, polishMs, raw, text, dropped: !!raw && !text });
        return Response.json({ text, raw, sttMs, polishMs });
      }

      if (req.method === "POST" && pathname === "/api/tts") {
        const { text, voice, rate } = await req.json();
        const t0 = performance.now();
        try {
          const preview = typeof voice === "string" && VOICES.some((v) => v.id === voice);
          const { audio, type } = preview
            ? await synthesize(String(text).slice(0, 200), voice, typeof rate === "number" ? rate : settings().rate)
            : await synthesize(String(text).slice(0, 1000));
          log("tts", { ms: Math.round(performance.now() - t0), chars: String(text).length, bytes: audio.byteLength });
          return new Response(audio, { headers: { "Content-Type": type } });
        } catch (err) {
          log("tts_error", { ms: Math.round(performance.now() - t0), chars: String(text).length, error: String((err as Error).message).slice(0, 300) });
          throw err;
        }
      }

      // Server-sent events of TurnEvent, one JSON object per `data:` line. The turn runs to the end
      // (and commits) even if the phone drops the stream. The app names the turn (id) and posts again
      // with the same id to continue from the events it already has (see src/replay.ts).
      if (req.method === "POST" && pathname === "/api/turn") {
        const { text = "", images: rawImages, from, id = crypto.randomUUID() } = await req.json(); // no id: an app page loaded before ids
        if (typeof id !== "string" || !/^[\w-]{8,64}$/.test(id)) return new Response("bad turn id", { status: 400 });
        const known = findTurn(id);
        if (known) return streamTurn(known, Number(from) || 0);
        // A continuation of a turn this server does not have (restarted mid-turn, or too old): do
        // not run it again under the app's half-shown reply.
        if (Number(from) > 0) return new Response("unknown turn", { status: 410 });
        const images = parseImages(rawImages);
        if (!images) return new Response("bad images", { status: 400 });
        if (!String(text).trim() && !images.length) return new Response("empty message", { status: 400 });
        const record = recordTurn(id);
        runTurn(String(text), (e) => record.push(e), images)
          .catch((err) => {
            console.error("turn error", err);
            record.push({ type: "error", message: "문제가 생겼어요. 다시 말해 주세요." });
          })
          .finally(() => record.finish());
        return streamTurn(record, 0);
      }

      if (req.method === "POST" && pathname === "/api/log") {
        log("client", await req.json());
        return new Response(null, { status: 204 });
      }
    } catch (err) {
      console.error(pathname, err);
      return Response.json({ error: String((err as Error).message ?? err) }, { status: 502 });
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`Kkachi listening on http://127.0.0.1:${config.port} (memory: ${config.memoryDir}, models: ${modelOrder().join(", ")})`);
