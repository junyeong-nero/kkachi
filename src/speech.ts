import { tmpdir } from "node:os";
import { join } from "node:path";
import { config } from "./config";
import { settings } from "./settings";

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

// Any OpenAI-compatible transcription API (Groq, OpenAI, local mlx-audio, ...).
// No Whisper `prompt`: a vocabulary hint gets transcribed back verbatim on silence ("K-EXAONE 2.5
// 무료 API" from note titles) and garbles real speech. Terms are fixed in the polish step instead.
export async function transcribe(audio: Blob): Promise<string> {
  const { baseUrl, apiKey, model, language } = config.stt;
  const verbose = /whisper/i.test(model); // segment scores; gpt-4o-transcribe models do not support verbose_json
  const form = new FormData();
  form.append("file", new File([audio], "speech.wav", { type: audio.type || "audio/wav" }));
  form.append("model", model);
  if (language) form.append("language", language);
  if (verbose) form.append("response_format", "verbose_json");
  const r = await fetch(`${baseUrl}/audio/transcriptions`, { method: "POST", headers: auth(apiKey), body: form });
  const body: any = await r.json();
  if (!r.ok) throw new Error(`stt ${r.status}: ${body.error?.message ?? JSON.stringify(body)}`);
  const segments: any[] = body.segments ?? [];
  if (segments.length && segments.every((s) => (s.no_speech_prob ?? 0) > NO_SPEECH)) return "";
  const text = String(body.text ?? "").trim();
  return isHallucination(text) ? "" : text;
}

/** voice/rate override the saved settings (used for previews in the settings sheet). */
export async function synthesize(text: string, voice = settings().voice, rate = settings().rate): Promise<{ audio: ArrayBuffer; type: string }> {
  if (config.tts.provider !== "edge") return openaiTts(text);
  // The Edge service sometimes answers with no audio (NoAudioReceived); a second try usually works.
  return edgeTts(text, voice, rate).catch(() => edgeTts(text, voice, rate));
}

// Edge TTS via the edge-tts CLI (`uv tool install edge-tts`). Free but unofficial.
async function edgeTts(text: string, voice: string, rate: number) {
  const out = join(tmpdir(), `kkachi-tts-${crypto.randomUUID()}.mp3`);
  const rateArg = `--rate=${rate >= 0 ? "+" : ""}${rate}%`; // "=" form: argparse rejects a bare "-10%"
  const p = Bun.spawn(["edge-tts", "--voice", voice, rateArg, "--text", text, "--write-media", out], { stderr: "pipe" });
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
