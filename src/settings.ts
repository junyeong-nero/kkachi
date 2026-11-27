// User settings changed from the app's settings sheet, stored in data/settings.json.
// They apply server-side: where speech is made and heard (this computer or online), the voice and
// speed, the primary model and the thinking level.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";

export type Tts = "local" | "edge"; // Supertonic on this computer, or Edge TTS online
export type Lang = "ko" | "en";
export interface Settings {
  lang: Lang;              // Kkachi Home, the device pages, dictation and what devices say (src/web/i18n.js)
  tts: Tts;
  stt: "local" | "groq";   // dictation: a speech server on this computer, or Groq (src/speech.ts)
  polish: "off" | "groq";  // tidying a transcript before the agent (src/polish.ts)
  voice: string;    // one of VOICES[tts]
  voiceBy: Partial<Record<Tts, string>>; // the voice last chosen in each engine: switching back finds it
  rate: number;     // speech speed in percent, -50..+100 (0 = normal)
  model: string;    // primary Pi model; config.models stay as fallbacks
  thinking: string; // Pi thinking level
}

const file = join(config.dataDir, "settings.json");

export const local = (url: string) => /\/\/(127\.0\.0\.1|localhost|\[::1\])\b/.test(url);
// The defaults follow .env.local, as before these were settings.
// A new install starts in the computer's language (Korean, or else English); KKACHI_LANG says otherwise.
const systemLang: Lang = /^ko\b/i.test(Intl.DateTimeFormat().resolvedOptions().locale) ? "ko" : "en";
const defaults: Settings = {
  lang: process.env.KKACHI_LANG === "ko" || process.env.KKACHI_LANG === "en" ? process.env.KKACHI_LANG : systemLang,
  tts: config.tts.provider === "supertonic" ? "local" : "edge",
  stt: local(config.stt.baseUrl) ? "local" : "groq",
  polish: config.polish.model ? "groq" : "off",
  voice: config.tts.voice,
  voiceBy: {},
  rate: 0,
  model: config.models[0],
  thinking: config.thinking,
};

// Only known keys: older files also had the device options (docs/bus.md: they are fixed now).
const stored = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
let current: Settings = { ...defaults, ...Object.fromEntries(Object.entries(stored).filter(([k]) => k in defaults)) };
if (Object.keys(stored).length && !stored.lang) current.lang = "ko"; // an install from before English: it was Korean
// From before: no engine chosen, or the device's own voice (gone: it was silent on iPhones while their
// microphone was open), so this computer's when it was chosen before, else online.
if (!stored.tts || stored.tts === "device") current.tts = stored.voiceBy?.local || config.tts.provider === "supertonic" ? "local" : "edge";

export const settings = () => current;

export function updateSettings(patch: Partial<Settings>): Settings {
  const next = { ...current };
  if (typeof patch.tts === "string" && patch.tts in VOICES) next.tts = patch.tts;
  if (next.tts !== current.tts) next.voice = current.voiceBy[next.tts] ?? VOICES[next.tts][0].id; // another engine: its voice from last time
  if (typeof patch.voice === "string" && VOICES[next.tts].some((v) => v.id === patch.voice)) next.voice = patch.voice;
  if (!VOICES[next.tts].some((v) => v.id === next.voice)) next.voice = VOICES[next.tts][0].id;
  next.voiceBy = { ...current.voiceBy, [next.tts]: next.voice };
  if (patch.stt === "local" || patch.stt === "groq") next.stt = patch.stt;
  if (patch.lang === "ko" || patch.lang === "en") next.lang = patch.lang;
  if (patch.polish === "off" || patch.polish === "groq") next.polish = patch.polish;
  if (typeof patch.rate === "number" && Number.isFinite(patch.rate)) next.rate = Math.max(-50, Math.min(100, Math.round(patch.rate)));
  if (typeof patch.model === "string" && patch.model.includes("/")) next.model = patch.model;
  if (typeof patch.thinking === "string" && THINKING.some((t) => t.id === patch.thinking)) next.thinking = patch.thinking;
  current = next;
  writeFileSync(file, JSON.stringify(current, null, 2));
  return current;
}

// The voices of each engine: Supertonic 3's ten (made on this computer), and Edge TTS voices that speak Korean (made online; the
// multilingual ones read English terms more naturally).
const SUPERTONIC_VOICES = ["F", "M"].flatMap((g) => [1, 2, 3, 4, 5].map((n) => ({ id: `${g}${n}`, name: `${g === "F" ? "여성" : "남성"} ${n}`, note: "" })));
const EDGE_VOICES = [
  { id: "ko-KR-SunHiNeural", name: "선희", note: "여성, 차분한 한국어" },
  { id: "ko-KR-InJoonNeural", name: "인준", note: "남성, 또렷한 한국어" },
  { id: "ko-KR-HyunsuMultilingualNeural", name: "현수", note: "남성, 영어 섞인 말에 자연스러움" },
  { id: "en-US-AvaMultilingualNeural", name: "에바", note: "여성, 다국어" },
  { id: "en-US-EmmaMultilingualNeural", name: "엠마", note: "여성, 다국어, 밝은 목소리" },
  { id: "en-US-AndrewMultilingualNeural", name: "앤드루", note: "남성, 다국어, 따뜻한 목소리" },
];
export const VOICES: Record<Tts, { id: string; name: string; note: string }[]> = { local: SUPERTONIC_VOICES, edge: EDGE_VOICES };
if (!VOICES[current.tts].some((v) => v.id === current.voice)) current.voice = current.voiceBy[current.tts] ?? VOICES[current.tts][0].id;

export const THINKING = [
  { id: "minimal", name: "빠르게" },
  { id: "low", name: "보통" },
  { id: "medium", name: "꼼꼼하게" },
];

/** Providers the user's Pi has credentials for (names only; secrets are never read out). */
export function authedProviders(): Set<string> {
  const providers = new Set<string>();
  const auth = join(config.agentDir, "auth.json");
  try { for (const k of Object.keys(JSON.parse(readFileSync(auth, "utf8")))) providers.add(k); } catch {}
  if (process.env.OPENROUTER_API_KEY) providers.add("openrouter");
  if (process.env.OPENAI_API_KEY) providers.add("openai");
  if (process.env.ANTHROPIC_API_KEY) providers.add("anthropic");
  return providers;
}
