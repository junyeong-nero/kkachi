// Runs opencode serve as an isolated child process and wraps the few API calls Kkachi needs.
// opencode v2 API is experimental: keep every endpoint Kkachi touches in this file.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";

const PORT = config.port + 1;
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = crypto.randomUUID();
const AUTH = "Basic " + btoa(`opencode:${PASSWORD}`);
const BUILTIN_AGENTS = ["build", "plan", "general", "explore"];

let child: ReturnType<typeof Bun.spawn> | undefined;

export async function startOpencode() {
  const xdgConfig = join(config.dataDir, "xdg-config"); // empty: hides the user's global opencode config
  mkdirSync(xdgConfig, { recursive: true });
  child = Bun.spawn([config.opencodeBin, "serve", "--hostname", "127.0.0.1", "--port", String(PORT)], {
    cwd: config.memoryDir,
    env: {
      ...process.env,
      XDG_CONFIG_HOME: xdgConfig,
      OPENCODE_CONFIG: join(config.root, "opencode", "opencode.jsonc"),
      OPENCODE_DB: join(config.dataDir, "opencode.db"),
      OPENCODE_DISABLE_PROJECT_CONFIG: "1", // the memory repo cannot override permissions
      OPENCODE_DISABLE_CLAUDE_CODE: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      OPENCODE_SERVER_PASSWORD: PASSWORD,
      KKACHI_ROOT: config.root, // used by opencode.jsonc to start src/mcp.ts
      KKACHI_MEMORY_DIR: config.memoryDir,
    },
    stdout: "ignore",
    stderr: "inherit",
  });
  for (const sig of ["SIGINT", "SIGTERM", "exit"] as const) process.on(sig, () => { child?.kill(); if (sig !== "exit") process.exit(0); });

  // Right after start, opencode briefly reports its default agents. Wait until only kkachi is runnable.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const ids: string[] = (await api("GET", "/api/agent")).data.filter((a: any) => !a.hidden).map((a: any) => a.id);
      if (ids.includes("kkachi") && !ids.some((id) => BUILTIN_AGENTS.includes(id))) return;
    } catch {}
    await Bun.sleep(300);
  }
  throw new Error("opencode did not become ready with only the kkachi agent");
}

async function api(method: string, path: string, body?: unknown) {
  const r = await fetch(BASE + path, {
    method,
    headers: { Authorization: AUTH, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`opencode ${method} ${path}: ${r.status} ${await r.text()}`);
  const text = await r.text();
  return text ? JSON.parse(text) : null;
}

export async function createSession(): Promise<string> {
  const [providerID, ...rest] = config.model.split("/");
  const s = await api("POST", "/api/session", {
    agent: "kkachi",
    location: { directory: config.memoryDir },
    model: { providerID, id: rest.join("/") },
  });
  return s.id ?? s.data.id;
}

export async function sessionExists(id: string) {
  try { await api("GET", `/api/session/${id}`); return true; } catch { return false; }
}

export async function prompt(sessionId: string, text: string) {
  await api("POST", `/api/session/${sessionId}/prompt`, { text });
}

export type OcEvent = { type: string; data: any };

// Subscribe to the event stream. Resolves once the stream is connected so the caller can prompt
// without missing events. Call the returned close() when done.
export async function subscribe(onEvent: (e: OcEvent) => void): Promise<() => void> {
  const ctrl = new AbortController();
  const r = await fetch(BASE + "/api/event", { headers: { Authorization: AUTH }, signal: ctrl.signal });
  if (!r.ok || !r.body) throw new Error(`opencode event stream: ${r.status}`);
  const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
  let connected!: () => void;
  const ready = new Promise<void>((res) => (connected = res));
  (async () => {
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += value;
        let i;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = chunk.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          const e = JSON.parse(line.slice(6));
          if (e.type === "server.connected") connected();
          else onEvent(e);
        }
      }
    } catch (err) {
      if (!ctrl.signal.aborted) console.error("event stream error", err);
    }
  })();
  await ready;
  return () => ctrl.abort();
}
