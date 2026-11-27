import { join } from "node:path";
import { checkSetup } from "./check";
import { config } from "./config";
import { log } from "./log";
import { polish } from "./polish";
import { modelOrder } from "./models";
import { settings, THINKING, updateSettings, VOICES } from "./settings";
import { speechReady, synthesize, transcribe } from "./speech";
import { applyThinking, currentSession, reloadAgent, modelChoices, newConversation, openConversation, runTurn, startConversation } from "./turn";
import { conversations, fileOf, idOf, newestId, transcript } from "./conversations";
import { answerMcpLogin, cancelMcpLogin, currentMcpLogin, mcpLoginShown, startMcpLogin } from "./mcp-login";
import { addOwn, addSuggested, enableServer, forget, listServers, removeServer, suggestions } from "./mcp-servers";
import { accounts, answerLogin, cancelLogin, currentLogin, loginShown, saveKey, signOut, startLogin } from "./accounts";
import { findTurn, recordTurn, streamTurn } from "./replay";
import type { PiImage } from "./pi";
import { accept, parseInput } from "./bus";
import { feedStream, pushFeed } from "./feed";
import { routeFor, startServices } from "./services";
import { connections } from "./mcp-bridge";
import { internal, trusted } from "../lib/trust";
import { BUILT_IN } from "../lib/tts";
import type { ServerWebSocket } from "bun";

const web = join(import.meta.dir, "web");
const SESSIONS = join(config.dataDir, "pi-sessions"); // Kkachi Home's conversations, one file each (src/pi.ts)
const currentId = async () => { const f = await currentSession(); return f ? idOf(f) : newestId(SESSIONS); };

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
  // Why the page's side closed goes on to the service, for its log: 1000 as it is, anything else (1001 the
  // page left, 1006 the connection was lost) as 4000 and its last three digits, which a client may send.
  close(ws: ServerWebSocket<Relay>, code: number) { ws.data.up?.close(code === 1000 ? 1000 : 4000 + (code % 1000)); },
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
        if (pathname === "/api/speech") return Response.json(await speechReady()); // Settings, 음성: what is ready
        if (pathname === "/api/settings") {
          return Response.json({ settings: settings(), voices: VOICES, thinking: THINKING, models: await modelChoices(), fallbacks: modelOrder().slice(1) });
        }
        // Settings, 도구: Kkachi's own servers, the ones added (?fresh asks each again), and the suggestions
        if (pathname === "/api/mcp") {
          const [builtin, added] = await Promise.all([connections(), listServers(new URL(req.url).searchParams.has("fresh"))]);
          return Response.json({ builtin, added, suggested: suggestions(), login: currentMcpLogin() });
        }
        // Kkachi Home's conversations (Pi's session files): the menu lists them, and the app shows the
        // open one again when it is reopened. ?id= reads another.
        if (pathname === "/api/accounts") return Response.json({ accounts: accounts(), login: currentLogin() });
        if (pathname === "/api/conversations") return Response.json({ current: await currentId(), list: conversations(SESSIONS) });
        if (pathname === "/api/conversation") {
          const id = new URL(req.url).searchParams.get("id") ?? await currentId();
          return Response.json({ id, turns: transcript(SESSIONS, id) });
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
        if (pathname === "/api/bus/voice") return Response.json({ voice: settings().tts === "device" ? BUILT_IN : settings().voice, rate: settings().rate }); // how devices speak
        const input = pathname === "/api/bus/input" ? parseInput(body) : null;
        if (!input) return new Response("bad input", { status: 400 });
        return Response.json(accept(input), { status: 202 });
      }

      // What reaches Kkachi Home outside its own turns: device conversations and send_to_phone.
      if (req.method === "GET" && pathname === "/api/feed") return feedStream(req.headers.get("last-event-id") ?? new URL(req.url).searchParams.get("last"));
      if (req.method === "POST" && pathname === "/api/feed") {
        if (!internal(req)) return new Response("forbidden", { status: 403 });
        const { text } = await req.json();
        if (typeof text !== "string" || !text.trim()) return new Response("empty message", { status: 400 });
        pushFeed({ kind: "message", from: "까치", text: text.slice(0, 4000), speak: true });
        return new Response(null, { status: 204 });
      }

      // Accounts (Settings, 계정; src/accounts.ts): a subscription signed in to step by step, an API key, signing out.
      if (req.method === "POST" && pathname.startsWith("/api/accounts/")) {
        const body = await req.json().catch(() => ({}));
        const changed = () => { log("account", { id: body.id }); reloadAgent().catch((err) => console.error("reload after account change failed", err)); };
        const what = pathname.slice("/api/accounts/".length);
        if (what === "login") { startLogin(String(body.id), changed); return Response.json({ login: await loginShown() }); }
        if (what === "code") return answerLogin(String(body.code ?? "")) ? Response.json({ login: await loginShown(15000) }) : new Response("no sign-in waiting for a code", { status: 409 });
        if (what === "cancel") { cancelLogin(); return Response.json({}); }
        if (what === "key" && typeof body.key === "string" && body.key.trim()) { saveKey(String(body.id), body.key); changed(); return Response.json({ accounts: accounts() }); }
        if (what === "signout") { signOut(String(body.id)); changed(); return Response.json({ accounts: accounts() }); }
        return new Response("unknown", { status: 404 });
      }

      // MCP servers added in Kkachi Home (src/mcp-servers.ts). A change starts the conversation's Pi again.
      if (req.method === "POST" && pathname.startsWith("/api/mcp/")) {
        const body = await req.json().catch(() => ({}));
        const what = pathname.slice("/api/mcp/".length);
        const changed = () => { forget(); reloadAgent().catch((err) => console.error("reload after an MCP change failed", err)); };
        // Signing in to one (src/mcp-login.ts): start, then the address the phone's browser ended on
        if (what === "login") { startMcpLogin(String(body.name), () => { log("mcp_signed_in", { name: body.name }); changed(); }); return Response.json({ login: await mcpLoginShown() }); }
        if (what === "login/answer") {
          try { return Response.json({ login: await answerMcpLogin(String(body.url ?? "")), added: await listServers(true) }); }
          catch (err) { return Response.json({ error: (err as Error).message }, { status: 400 }); }
        }
        if (what === "login/cancel") { cancelMcpLogin(); return Response.json({}); }
        let names: string[] = [];
        try {
          if (what === "add") { if (body.suggested) names = addSuggested(String(body.suggested), body.values ?? {}); else addOwn(body); }
          else if (what === "remove") removeServer(String(body.name));
          else if (what === "enable") enableServer(String(body.name), !!body.on);
          else return new Response("unknown", { status: 404 });
        } catch (err) { return Response.json({ error: (err as Error).message }, { status: 400 }); }
        log("mcp_change", { what, name: body.name ?? body.suggested ?? null });
        changed();
        return Response.json({ added: await listServers(true), names });
      }

      if (req.method === "POST" && pathname === "/api/conversation/open") {
        const file = fileOf(SESSIONS, String((await req.json().catch(() => ({})))?.id ?? ""));
        if (!file) return new Response("no such conversation", { status: 404 });
        await openConversation(file);
        log("open_conversation", { id: idOf(file) });
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
        // The device voice is made on the phone itself; the app does not ask for it here.
        if (voice === BUILT_IN || (!voice && settings().tts === "device")) return new Response("the device voice is spoken on the device", { status: 409 });
        const t0 = performance.now();
        try {
          const engine = (["local", "edge"] as const).find((e) => VOICES[e].some((v) => v.id === voice)); // a preview in the settings
          const { audio, type } = engine
            ? await synthesize(String(text).slice(0, 200), voice, typeof rate === "number" ? rate : settings().rate, engine)
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
