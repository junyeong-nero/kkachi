// User settings changed from the app's settings sheet, stored in data/settings.json.
// They apply server-side: TTS voice and speed, the primary model, and the thinking level.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "./config";

export interface Settings {
  voice: string;    // Edge TTS voice
  rate: number;     // speech speed in percent, -50..+100 (0 = normal)
  model: string;    // primary Pi model; config.models stay as fallbacks
  thinking: string; // Pi thinking level
}

const file = join(config.dataDir, "settings.json");

const defaults: Settings = {
  voice: config.tts.voice,
  rate: 0,
  model: config.models[0],
  thinking: config.thinking,
};

let current: Settings = { ...defaults, ...(existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {}) };

export const settings = () => current;

export function updateSettings(patch: Partial<Settings>): Settings {
  const next = { ...current };
  if (typeof patch.voice === "string" && VOICES.some((v) => v.id === patch.voice)) next.voice = patch.voice;
  if (typeof patch.rate === "number" && Number.isFinite(patch.rate)) next.rate = Math.max(-50, Math.min(100, Math.round(patch.rate)));
  if (typeof patch.model === "string" && patch.model.includes("/")) next.model = patch.model;
  if (typeof patch.thinking === "string" && THINKING.some((t) => t.id === patch.thinking)) next.thinking = patch.thinking;
  current = next;
  writeFileSync(file, JSON.stringify(current, null, 2));
  return current;
}

// Edge TTS voices that speak Korean. Multilingual voices read English terms more naturally.
export const VOICES = [
  { id: "ko-KR-SunHiNeural", name: "선희", note: "여성, 차분한 한국어" },
  { id: "ko-KR-InJoonNeural", name: "인준", note: "남성, 또렷한 한국어" },
  { id: "ko-KR-HyunsuMultilingualNeural", name: "현수", note: "남성, 영어 섞인 말에 자연스러움" },
  { id: "en-US-AvaMultilingualNeural", name: "에바", note: "여성, 다국어" },
  { id: "en-US-EmmaMultilingualNeural", name: "엠마", note: "여성, 다국어, 밝은 목소리" },
  { id: "en-US-AndrewMultilingualNeural", name: "앤드루", note: "남성, 다국어, 따뜻한 목소리" },
];

export const THINKING = [
  { id: "minimal", name: "빠르게" },
  { id: "low", name: "보통" },
  { id: "medium", name: "꼼꼼하게" },
];

/** Providers the user's Pi has credentials for (names only; secrets are never read out). */
export function authedProviders(): Set<string> {
  const providers = new Set<string>();
  const auth = join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "auth.json");
  try { for (const k of Object.keys(JSON.parse(readFileSync(auth, "utf8")))) providers.add(k); } catch {}
  if (process.env.OPENROUTER_API_KEY) providers.add("openrouter");
  if (process.env.OPENAI_API_KEY) providers.add("openai");
  if (process.env.ANTHROPIC_API_KEY) providers.add("anthropic");
  return providers;
}
