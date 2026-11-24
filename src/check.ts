// Startup checks: say what is missing and how to fix it, instead of failing on the first request.
// Missing git or Pi stops the server; a missing voice part only disables that feature.
import { config } from "./config";

const local = (url: string) => /^https?:\/\/(localhost|127\.0\.0\.1)[:/]/.test(url);

export function checkSetup() {
  const fatal: string[] = [], warn: string[] = [];
  if (!Bun.which("git")) fatal.push("git is not on PATH. Install Git.");
  if (!Bun.which(config.piBin)) fatal.push(`Pi (${config.piBin}) is not on PATH. Install Pi (https://pi.dev) or set KKACHI_PI_BIN.`);
  if (!config.stt.apiKey && !local(config.stt.baseUrl)) warn.push("No speech-to-text key (GROQ_API_KEY or KKACHI_STT_API_KEY): dictation will not work.");
  if (config.tts.provider === "edge" && !Bun.which("edge-tts")) warn.push("edge-tts is not on PATH: replies cannot be read aloud. Install it with `uv tool install edge-tts`.");
  if (config.tts.provider === "openai" && !config.tts.apiKey && !local(config.tts.baseUrl)) warn.push("No text-to-speech key (KKACHI_TTS_API_KEY or OPENAI_API_KEY): replies cannot be read aloud.");
  for (const w of warn) console.warn(`warning: ${w}`);
  if (fatal.length) {
    for (const f of fatal) console.error(`error: ${f}`);
    process.exit(1);
  }
}
