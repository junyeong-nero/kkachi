import { synthesize as tts } from "../lib/tts";
import { readAgentJson } from "./agent-dir";
import { config } from "./config";
import { local, settings } from "./settings";

const auth = (key: string): Record<string, string> => (key ? { Authorization: `Bearer ${key}` } : {});

// Whisper invents these for silence or noise. Drop a transcript only when it is entirely one of them.
const HALLUCINATIONS = [
  /^(감사합니다|고맙습니다|시청해주셔서감사합니다|구독과좋아요부탁드립니다|다음영상에서만나요|thankyou|thanksforwatching)$/,
  /^mbc뉴스(.{2,4}입니다)?$/,  // "MBC 뉴스 정상우입니다"
  /^k+$/,                          // "KK."
];
const isHallucination = (text: string) => {
  const t = text.toLowerCase().replace(/[\s.,!?~]/g, "");
  return HALLUCINATIONS.some((re) => re.test(t));
};

// Above this, Whisper itself judges a segment to contain no speech (real speech scores about 0.00,
// silence and noise 0.5+ on whisper-large-v3; the turbo model always reports 0).
const NO_SPEECH = 0.4;

// Groq's key: entered in Settings, 계정 (src/accounts.ts), else GROQ_API_KEY.
export const groqKey = (): string => readAgentJson("keys.json").groq ?? process.env.GROQ_API_KEY ?? "";

// Where dictation is heard, as chosen in Settings, 음성: a speech server on this computer
// (KKACHI_STT_LOCAL_URL, or KKACHI_STT_BASE_URL when it is local; speech.cpp with Qwen3-ASR by default),
// or Groq's Whisper (KKACHI_STT_BASE_URL when it is not local).
const GROQ = "https://api.groq.com/openai/v1";
export function localStt() {
  const { baseUrl, model } = config.stt, here = local(baseUrl);
  return { baseUrl: process.env.KKACHI_STT_LOCAL_URL ?? (here ? baseUrl : "http://127.0.0.1:8091/v1"), model: process.env.KKACHI_STT_LOCAL_MODEL ?? (here ? model : "qwen3-asr-0.6b") };
}
export function sttConfig() {
  const { baseUrl, model } = config.stt, here = local(baseUrl), language = config.stt.language || settings().lang;
  if (settings().stt === "local") return { ...localStt(), apiKey: "", language, chunking: "auto" };
  return { baseUrl: here ? GROQ : baseUrl, apiKey: groqKey() || (here ? "" : config.stt.apiKey), model: here ? "whisper-large-v3" : model, language, chunking: "" };
}

// Any OpenAI-compatible transcription API (Groq, OpenAI, local mlx-audio, ...).
// No Whisper `prompt`: a vocabulary hint gets transcribed back verbatim on silence ("K-EXAONE 2.5
// 무료 API" from note titles) and garbles real speech. Terms are fixed in the polish step instead.
export async function transcribe(audio: Blob): Promise<string> {
  const { baseUrl, apiKey, model, language, chunking } = sttConfig();
  const verbose = /whisper/i.test(model); // segment scores; gpt-4o-transcribe models do not support verbose_json
  const form = new FormData();
  form.append("file", new File([audio], "speech.wav", { type: audio.type || "audio/wav" }));
  form.append("model", model);
  if (language) form.append("language", language);
  if (verbose) form.append("response_format", "verbose_json");
  if (chunking) form.append("chunking_strategy", chunking);
  const r = await fetch(`${baseUrl}/audio/transcriptions`, { method: "POST", headers: auth(apiKey), body: form });
  const body: any = await r.json();
  if (!r.ok) throw new Error(`stt ${r.status}: ${body.error?.message ?? JSON.stringify(body)}`);
  const segments: any[] = body.segments ?? [];
  if (segments.length && segments.every((s) => (s.no_speech_prob ?? 0) > NO_SPEECH)) return "";
  const text = String(body.text ?? "").trim();
  return isHallucination(text) ? "" : text;
}

/** voice/rate/engine override the saved settings (used for previews in the settings sheet). */
export const synthesize = (text: string, voice = settings().voice, rate = settings().rate, engine = settings().tts) =>
  tts(text, voice, rate, engine, settings().lang);

/** Whether each way is ready: the servers on this computer answer, Groq has a key, edge-tts is installed. */
export async function speechReady() {
  const up = (url: string) => fetch(url, { signal: AbortSignal.timeout(1500) }).then(() => true, () => false);
  const stt = localStt().baseUrl;
  const [sttLocal, ttsLocal] = await Promise.all([up(`${stt}/models`), up(config.tts.localUrl.replace(/\/v1$/, "") + "/health")]);
  return { sttLocal, ttsLocal, groq: !!groqKey(), edge: !!Bun.which("edge-tts") };
}
