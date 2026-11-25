import { join } from "node:path";
import { checkSetup } from "./check";
import { config } from "./config";
import { log } from "./log";
import { polish } from "./polish";
import { modelOrder } from "./models";
import { DEVICE_OPTIONS, settings, THINKING, updateSettings, VOICES } from "./settings";
import { synthesize, transcribe } from "./speech";
import { applyThinking, modelChoices, newConversation, runTurn, startConversation } from "./turn";
import { findTurn, recordTurn, streamTurn } from "./replay";
import type { PiImage } from "./pi";
import { accept, parseInput, warm } from "./bus";
import { feedStream, pushFeed } from "./feed";
import { routeFor, startServices } from "./services";
import { internal, trusted } from "../lib/trust";
import type { ServerWebSocket } from "bun";

const web = join(import.meta.dir, "web");

// A service's own socket (the devices page's), forwarded both ways from core's address.
type Relay = { target: string; up?: WebSocket; queue: (string | Buffer)[] };
const relay = {
  open(ws: ServerWebSocket<Relay>) {
    const up = new WebSocket(ws.data.target);
    ws.data.up = up;
    up.onopen = () => { for (const m of ws.data.queue.splice(0)) up.send(m); };
    up.onmessage = (e) => ws.send(e.data as string);
    up.onclose = () => ws.close();
    up.onerror = () => ws.close();
  },
  message(ws: ServerWebSocket<Relay>, m: string | Buffer) {
    if (ws.data.up?.readyState === WebSocket.OPEN) ws.data.up.send(m); else ws.data.queue.push(m);
  },
  close(ws: ServerWebSocket<Relay>) { ws.data.up?.close(); },
};

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

Bun.serve({
  port: config.port,
  hostname: "127.0.0.1", // reach it through Tailscale Serve only
  idleTimeout: 255,
  websocket: relay,
  async fetch(req, server) {
    if (!trusted(req)) return new Response("forbidden", { status: 403 });
    const { pathname, search } = new URL(req.url);
    try {
      // A service's own pages and sockets ("routes" in kkachi.mcp.json), e.g. /device. Checked above.
      const target = routeFor(pathname);
      if (target) {
        if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
          return server.upgrade(req, { data: { target: target.replace(/^http/, "ws") + search, queue: [] } }) ? undefined : new Response("expected a WebSocket", { status: 400 });
        }
        const headers = new Headers(req.headers);
        headers.delete("host"); headers.delete("origin"); // core has checked them; the service sees a local call
        const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
        return await fetch(target + search, { method: req.method, headers, body, redirect: "manual" });
      }
      if (req.method === "GET") {
        // no-cache: a home-screen web app otherwise keeps serving an old version after updates
        const noCache = { "Cache-Control": "no-cache" };
        if (pathname === "/") return new Response(Bun.file(join(web, "index.html")), { headers: { ...noCache, "Content-Type": "text/html; charset=utf-8" } });
        if (pathname === "/manifest.webmanifest") return new Response(Bun.file(join(web, "manifest.webmanifest")), { headers: { ...noCache, "Content-Type": "application/manifest+json" } });
        if (pathname === "/app.js") return new Response(Bun.file(join(web, "app.js")), { headers: { ...noCache, "Content-Type": "text/javascript" } });
        // Markdown rendering for replies: marked (MIT) and DOMPurify (Apache-2.0/MPL-2.0), vendored unmodified
        if (["/vendor/marked.min.js", "/vendor/purify.min.js"].includes(pathname)) {
          return new Response(Bun.file(join(web, pathname.slice(1))), { headers: { "Content-Type": "text/javascript", "Cache-Control": "max-age=86400" } });
        }
        // App icon generated with Codex image generation (assets/icon/, see DESIGN.md)
        if (["/icon.png", "/apple-touch-icon.png", "/favicon.png"].includes(pathname)) {
          return new Response(Bun.file(join(web, pathname.slice(1))), { headers: { "Content-Type": "image/png" } });
        }
        if (pathname === "/api/settings") {
          return Response.json({ settings: settings(), voices: VOICES, thinking: THINKING, models: await modelChoices(), fallbacks: modelOrder().slice(1), deviceOptions: DEVICE_OPTIONS });
        }
      }

      if (req.method === "POST" && pathname === "/api/settings") {
        const next = updateSettings(await req.json());
        await applyThinking(); // model changes apply on the next turn
        log("settings", { ...next });
        return Response.json({ settings: next });
      }

      // The input bus (docs/bus.md): what spare devices say, handed over by the devices service with
      // the internal token. Accepting is quick; the answer goes out later, where the settings say.
      if (req.method === "POST" && pathname.startsWith("/api/bus/")) {
        if (!internal(req)) return new Response("forbidden", { status: 403 });
        const body = await req.json();
        if (pathname === "/api/bus/warm" && typeof body?.source?.id === "string") { warm(body.source); return Response.json({}); }
        const input = pathname === "/api/bus/input" ? parseInput(body) : null;
        if (!input) return new Response("bad input", { status: 400 });
        return Response.json(accept(input), { status: 202 });
      }

      // What reaches the phone app outside its own turns: device conversations and send_to_phone.
      if (req.method === "GET" && pathname === "/api/feed") return feedStream(req.headers.get("last-event-id") ?? new URL(req.url).searchParams.get("last"));
      if (req.method === "POST" && pathname === "/api/feed") {
        if (!internal(req)) return new Response("forbidden", { status: 403 });
        const { text } = await req.json();
        if (typeof text !== "string" || !text.trim()) return new Response("empty message", { status: 400 });
        pushFeed({ kind: "message", from: "까치", text: text.slice(0, 4000), speak: true });
        return new Response(null, { status: 204 });
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
// After listening: the conversation Pi lists its MCP tools from the services, which must be up.
await startServices();
await startConversation();
