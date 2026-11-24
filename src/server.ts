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

const web = join(import.meta.dir, "web");

checkSetup();
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
        const { text, from, id = crypto.randomUUID() } = await req.json(); // no id: an app page loaded before ids
        if (typeof id !== "string" || !/^[\w-]{8,64}$/.test(id)) return new Response("bad turn id", { status: 400 });
        const known = findTurn(id);
        if (known) return streamTurn(known, Number(from) || 0);
        // A continuation of a turn this server does not have (restarted mid-turn, or too old): do
        // not run it again under the app's half-shown reply.
        if (Number(from) > 0) return new Response("unknown turn", { status: 410 });
        const record = recordTurn(id);
        runTurn(String(text), (e) => record.push(e))
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
