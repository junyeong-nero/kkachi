import { join } from "node:path";
import { config } from "./config";
import { log } from "./log";
import { polish } from "./polish";
import { modelOrder } from "./models";
import { settings, THINKING, updateSettings, VOICES } from "./settings";
import { synthesize, transcribe } from "./speech";
import { applyThinking, modelChoices, newConversation, runTurn, startConversation, type TurnEvent } from "./turn";

const web = join(import.meta.dir, "web");

await startConversation();

Bun.serve({
  port: config.port,
  hostname: "127.0.0.1", // reach it through Tailscale Serve only
  idleTimeout: 255,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    try {
      if (req.method === "GET") {
        // no-cache: a home-screen web app otherwise keeps serving an old version after updates
        const noCache = { "Cache-Control": "no-cache" };
        if (pathname === "/") return new Response(Bun.file(join(web, "index.html")), { headers: { ...noCache, "Content-Type": "text/html; charset=utf-8" } });
        if (pathname === "/manifest.webmanifest") return new Response(Bun.file(join(web, "manifest.webmanifest")), { headers: { ...noCache, "Content-Type": "application/manifest+json" } });
        if (pathname === "/app.js") return new Response(Bun.file(join(web, "app.js")), { headers: { ...noCache, "Content-Type": "text/javascript" } });
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

      // Server-sent events of TurnEvent, one JSON object per `data:` line.
      if (req.method === "POST" && pathname === "/api/turn") {
        const { text, raw } = await req.json();
        // The phone may drop the connection mid-turn (app backgrounded). The turn still finishes and
        // commits; writes to a closed stream are skipped instead of throwing (which killed the server).
        let open = true, heartbeat: ReturnType<typeof setInterval> | undefined;
        const stream = new ReadableStream({
          async start(controller) {
            const enc = new TextEncoder();
            const send = (chunk: string) => {
              if (!open) return;
              try { controller.enqueue(enc.encode(chunk)); } catch { open = false; }
            };
            const emit = (e: TurnEvent) => send(`data: ${JSON.stringify(e)}\n\n`);
            heartbeat = setInterval(() => send(": ping\n\n"), 15_000); // lets the client detect a dead stream
            try {
              await runTurn(String(text), emit, typeof raw === "string" ? raw : undefined);
            } catch (err) {
              console.error("turn error", err);
              emit({ type: "error", message: "문제가 생겼어요. 다시 말해 주세요." });
            }
            clearInterval(heartbeat);
            if (open) { open = false; try { controller.close(); } catch {} }
          },
          cancel() { open = false; clearInterval(heartbeat); },
        });
        return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
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
