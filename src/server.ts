import { join } from "node:path";
import { config } from "./config";
import { startOpencode } from "./opencode";
import { polish } from "./polish";
import { synthesize, transcribe } from "./speech";
import { runTurn, type TurnEvent } from "./turn";

const web = join(import.meta.dir, "web");

await startOpencode();

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
        const raw = await transcribe(await req.blob());
        const t1 = performance.now();
        const text = await polish(raw);
        if (text !== raw) console.log(`polish: ${raw} → ${text}`);
        return Response.json({ text, raw, sttMs: Math.round(t1 - t0), polishMs: Math.round(performance.now() - t1) });
      }

      if (req.method === "POST" && pathname === "/api/tts") {
        const { text } = await req.json();
        const { audio, type } = await synthesize(String(text).slice(0, 1000));
        return new Response(audio, { headers: { "Content-Type": type } });
      }

      // Server-sent events of TurnEvent, one JSON object per `data:` line.
      if (req.method === "POST" && pathname === "/api/turn") {
        const { text } = await req.json();
        const stream = new ReadableStream({
          async start(controller) {
            const enc = new TextEncoder();
            const emit = (e: TurnEvent) => controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
            try {
              await runTurn(String(text), emit);
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
        console.log("client", JSON.stringify(await req.json()));
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
