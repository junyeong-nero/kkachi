import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "./config";

const auth = (key: string): Record<string, string> => (key ? { Authorization: `Bearer ${key}` } : {});

// Whisper returns these for silence or noise (no_speech_prob stays 0, so it cannot filter them).
// Drop a transcript only when it is entirely one of them.
const HALLUCINATIONS = new Set(["감사합니다", "고맙습니다", "시청해주셔서감사합니다", "구독과좋아요부탁드립니다", "다음영상에서만나요", "mbc뉴스", "thankyou", "thanksforwatching"]);
const isHallucination = (text: string) => HALLUCINATIONS.has(text.toLowerCase().replace(/[\s.,!?~]/g, ""));

// Any OpenAI-compatible transcription API (Groq, OpenAI, local mlx-audio, ...).
export async function transcribe(audio: Blob): Promise<string> {
  const { baseUrl, apiKey, model, language } = config.stt;
  const form = new FormData();
  form.append("file", new File([audio], "speech.wav", { type: audio.type || "audio/wav" }));
  form.append("model", model);
  form.append("language", language);
  const r = await fetch(`${baseUrl}/audio/transcriptions`, { method: "POST", headers: auth(apiKey), body: form });
  const body: any = await r.json();
  if (!r.ok) throw new Error(`stt ${r.status}: ${body.error?.message ?? JSON.stringify(body)}`);
  const text = String(body.text ?? "").trim();
  return isHallucination(text) ? "" : text;
}

export async function synthesize(text: string): Promise<{ audio: ArrayBuffer; type: string }> {
  return config.tts.provider === "edge" ? edgeTts(text) : openaiTts(text);
}

// Edge TTS via the edge-tts CLI (`uv tool install edge-tts`). Free but unofficial.
async function edgeTts(text: string) {
  const out = join(tmpdir(), `kkachi-tts-${crypto.randomUUID()}.mp3`);
  const p = Bun.spawn(["edge-tts", "--voice", config.tts.voice, "--text", text, "--write-media", out], { stderr: "pipe" });
  if ((await p.exited) !== 0) throw new Error(`edge-tts: ${await new Response(p.stderr).text()}`);
  const file = Bun.file(out);
  const audio = await file.arrayBuffer();
  await file.delete();
  return { audio, type: "audio/mpeg" };
}

async function openaiTts(text: string) {
  const { baseUrl, apiKey, model, voice } = config.tts;
  const r = await fetch(`${baseUrl}/audio/speech`, {
    method: "POST",
    headers: { ...auth(apiKey), "Content-Type": "application/json" },
    body: JSON.stringify({ model, voice, input: text, response_format: "mp3" }),
  });
  if (!r.ok) throw new Error(`tts ${r.status}: ${await r.text()}`);
  return { audio: await r.arrayBuffer(), type: r.headers.get("Content-Type") ?? "audio/mpeg" };
}
