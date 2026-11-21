import { join } from "node:path";
import { config } from "./config";
import { log } from "./log";
import { polish } from "./polish";
import { synthesize, transcribe } from "./speech";
import { runTurn, startConversation, type TurnEvent } from "./turn";

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
        if (pathname === "/") return new Response(Bun.file(join(web, "index.html")));
        if (pathname === "/manifest.webmanifest") return new Response(Bun.file(join(web, "manifest.webmanifest")), { headers: { "Content-Type": "application/manifest+json" } });
        if (pathname === "/app.js") return new Response(Bun.file(join(web, "app.js")), { headers: { "Content-Type": "text/javascript" } });
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
        const { text } = await req.json();
        const t0 = performance.now();
        try {
          const { audio, type } = await synthesize(String(text).slice(0, 1000));
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
        const stream = new ReadableStream({
          async start(controller) {
            const enc = new TextEncoder();
            const emit = (e: TurnEvent) => controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
            try {
              await runTurn(String(text), emit, typeof raw === "string" ? raw : undefined);
            } catch (err) {
              console.error("turn error", err);
              emit({ type: "error", message: "문제가 생겼어요. 다시 말해 주세요." });
            }
            controller.close();
          },
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

console.log(`Kkachi listening on http://127.0.0.1:${config.port} (memory: ${config.memoryDir}, models: ${config.models.join(", ")})`);
