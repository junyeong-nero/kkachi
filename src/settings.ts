// User settings changed from the app's settings sheet, stored in data/settings.json.
// They apply server-side: TTS voice and speed, the primary model, the thinking level, and how
// Kkachi handles what is said to a spare device (docs/bus.md).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "./config";

export interface Settings {
  voice: string;    // "device" (each device's own voice) or an Edge TTS voice
  rate: number;     // speech speed in percent, -50..+100 (0 = normal)
  model: string;    // primary Pi model; config.models stay as fallbacks
  thinking: string; // Pi thinking level
  deviceSession: "all" | "home" | "device"; // one session with the phone app, one for all devices, or one per device
  deviceReply: "source" | "phone" | "both";  // where the answer to a device goes
  devicePrivacy: "open" | "guarded" | "phone"; // private details: say them, keep them unsaid, or send them to the phone
  deviceTools: "full" | "limited";            // device sessions: the phone app's tools, or notes, speaking and the lamp
  deviceIdleMin: number;                       // device sessions start over after this many quiet minutes (0: never)
}

const file = join(config.dataDir, "settings.json");

const defaults: Settings = {
  voice: config.tts.voice,
  rate: 0,
  model: config.models[0],
  thinking: config.thinking,
  // A personal setup: privacy is assumed, so devices share the phone app's conversation and tools.
  deviceSession: "all",
  deviceReply: "source",
  devicePrivacy: "open",
  deviceTools: "full",
  deviceIdleMin: 10,
};

let current: Settings = { ...defaults, ...(existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {}) };

export const settings = () => current;

export function updateSettings(patch: Partial<Settings>): Settings {
  const next = { ...current };
  if (typeof patch.voice === "string" && VOICES.some((v) => v.id === patch.voice)) next.voice = patch.voice;
  if (typeof patch.rate === "number" && Number.isFinite(patch.rate)) next.rate = Math.max(-50, Math.min(100, Math.round(patch.rate)));
  if (typeof patch.model === "string" && patch.model.includes("/")) next.model = patch.model;
  if (typeof patch.thinking === "string" && THINKING.some((t) => t.id === patch.thinking)) next.thinking = patch.thinking;
  for (const [key, choices] of Object.entries(DEVICE_OPTIONS)) {
    const v = (patch as any)[key];
    if (choices.some((c) => c.id === v)) (next as any)[key] = v;
  }
  current = next;
  writeFileSync(file, JSON.stringify(current, null, 2));
  return current;
}

// The device's own voice first (made on the phone or spare device, nothing sent out), then Edge TTS
// voices that speak Korean (made online). Multilingual voices read English terms more naturally.
export const VOICES = [
  { id: "device", name: "기기 목소리", note: "폰과 공기계에 들어 있는 목소리. 까치 서버에서 만들지 않아요" },
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

// How Kkachi handles what is said to a spare device (docs/bus.md), as the settings sheet offers them.
export const DEVICE_OPTIONS: Record<string, { id: string | number; name: string }[]> = {
  deviceSession: [{ id: "all", name: "폰과 함께" }, { id: "home", name: "공기계끼리" }, { id: "device", name: "기기마다" }],
  deviceReply: [{ id: "source", name: "들은 기기" }, { id: "phone", name: "폰" }, { id: "both", name: "둘 다" }],
  devicePrivacy: [{ id: "open", name: "그대로" }, { id: "guarded", name: "말하지 않기" }, { id: "phone", name: "폰으로" }],
  deviceTools: [{ id: "full", name: "전체" }, { id: "limited", name: "제한" }],
  deviceIdleMin: [{ id: 5, name: "5분" }, { id: 10, name: "10분" }, { id: 30, name: "30분" }, { id: 0, name: "끄기" }],
};

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
