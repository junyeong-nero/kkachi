// The speech servers on this computer, started by core when Settings, 음성 chooses this computer:
// Supertonic for the voice (`uv run scripts/supertonic-server.py`) and speech.cpp for dictation (put in
// data/speech by scripts/speech-install.ts, or KKACHI_SPEECH_BIN). One already answering at its
// address is left alone (started some other way), and one that stops is started again.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";
import { log } from "./log";
import { local, settings } from "./settings";
import { localStt } from "./speech";

type Helper = { name: string; wanted: () => boolean; url: () => string; probe: (url: string) => string; command: (port: string) => string[] | null; env?: (port: string) => Record<string, string> };

const speechBin = (): string | null => {
  if (process.env.KKACHI_SPEECH_BIN) return process.env.KKACHI_SPEECH_BIN;
  const dir = join(config.dataDir, "speech"), name = process.platform === "win32" ? "speech.exe" : "speech";
  try {
    for (const v of readdirSync(dir).sort().reverse()) if (existsSync(join(dir, v, name))) return join(dir, v, name);
  } catch {}
  return null;
};

const HELPERS: Helper[] = [
  {
    name: "supertonic", wanted: () => settings().tts === "local", url: () => config.tts.localUrl,
    probe: (url) => url.replace(/\/v1\/?$/, "") + "/health",
    command: () => { const uv = Bun.which("uv"); return uv ? [uv, "run", join(config.root, "scripts", "supertonic-server.py")] : null; },
    env: (port) => ({ SUPERTONIC_PORT: port }),
  },
  {
    name: "speech.cpp", wanted: () => settings().stt === "local", url: () => localStt().baseUrl,
    probe: (url) => `${url}/models`,
    // speech.cpp's own name for the model (the one sent with each request can be written otherwise)
    command: (port) => { const bin = speechBin(); return bin ? [bin, "serve", process.env.KKACHI_SPEECH_MODEL ?? "qwen3-asr-0.6b", "silero-vad", "--port", port] : null; },
  },
];

const running = new Map<string, ReturnType<typeof Bun.spawn>>();
const failures = new Map<string, number[]>();
const answers = (url: string) => fetch(url, { signal: AbortSignal.timeout(1500) }).then(() => true, () => false);

async function ensure(h: Helper) {
  if (!h.wanted() || running.has(h.name)) return;
  const url = h.url();
  if (!local(url) || (await answers(h.probe(url)))) return; // elsewhere, or already up
  const port = new URL(url).port || "80";
  const cmd = h.command(port);
  if (!cmd) { log("speech_server_missing", { name: h.name }); return; } // not installed: Settings says it is off
  const p = Bun.spawn(cmd, { cwd: config.root, env: { ...process.env, PYTHONUTF8: "1", ...h.env?.(port) }, stdout: "inherit", stderr: "inherit" });
  running.set(h.name, p);
  log("speech_server_start", { name: h.name, port });
  p.exited.then((code) => {
    running.delete(h.name);
    if (stopping) return;
    // Five stops within ten minutes: something is wrong with it, so stop trying until asked again.
    const recent = [...(failures.get(h.name) ?? []), Date.now()].filter((t) => t > Date.now() - 600_000);
    failures.set(h.name, recent);
    log("speech_server_stopped", { name: h.name, code });
    if (recent.length < 5) setTimeout(() => ensure(h), 5000);
  });
}

let stopping = false;
/** Start what Settings chooses and is not running yet. Called at start and when Settings change. */
export function ensureSpeechServers() {
  for (const h of HELPERS) { failures.delete(h.name); ensure(h).catch((err) => console.error(`speech server ${h.name}:`, err)); }
}
for (const signal of ["exit", "SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => { stopping = true; for (const p of running.values()) p.kill(); }); // src/services.ts exits after
}
