// Startup checks: say what is missing and how to fix it, instead of failing on the first request.
// Missing git or Pi stops the server; a missing voice part only disables that feature.
import { BUILT_IN } from "../lib/tts";
import { config } from "./config";
import { settings } from "./settings";

const local = (url: string) => /^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(url);

export function checkSetup() {
  const fatal: string[] = [], warn: string[] = [];
  if (!Bun.which("git")) fatal.push("git is not on PATH. Install Git.");
  if (!Bun.which(config.piBin)) fatal.push(`Pi (${config.piBin}) is not on PATH. Install Pi (https://pi.dev) or set KKACHI_PI_BIN.`);
  if (!config.stt.apiKey && !local(config.stt.baseUrl)) warn.push("No speech-to-text key (GROQ_API_KEY or KKACHI_STT_API_KEY): dictation will not work.");
  if (settings().voice !== BUILT_IN && config.tts.provider === "edge" && !Bun.which("edge-tts")) warn.push("edge-tts is not on PATH: the chosen server voice cannot speak. Install it with `uv tool install edge-tts`, or pick 기기 목소리 in Settings.");
  if (config.tts.provider === "openai" && !config.tts.apiKey && !local(config.tts.baseUrl)) warn.push("No text-to-speech key (KKACHI_TTS_API_KEY or OPENAI_API_KEY): replies cannot be read aloud.");
  if (/^(1|true|on|yes)$/i.test(process.env.KKACHI_MEMORY_SYNC ?? "") && Bun.spawnSync(["git", "-C", config.memoryDir, "rev-parse", "--abbrev-ref", "@{upstream}"]).exitCode !== 0)
    warn.push(`KKACHI_MEMORY_SYNC is on but the memory repo has no upstream: nothing is backed up. Add one with: git -C "${config.memoryDir}" push -u <remote> main`);
  for (const w of warn) console.warn(`warning: ${w}`);
  if (fatal.length) {
    for (const f of fatal) console.error(`error: ${f}`);
    process.exit(1);
  }
}
