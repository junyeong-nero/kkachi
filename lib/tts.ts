// Text to speech, for core: replies, and speech the devices service asks for (/api/tts).
// By default nothing is made here: the voice "device" means each phone and spare device speaks with
// its own built-in voice (Web Speech API), so no words leave the house. Any other voice is made on
// the server: Edge TTS (free, unofficial, online), Supertonic 3 on this computer (nothing leaves the
// house either; scripts/supertonic-server.py), or an OpenAI-compatible speech API (KKACHI_TTS_*).
// The voice and speed chosen in the app's settings live in data/settings.json (src/settings.ts).
import { tmpdir } from "node:os";
import { join } from "node:path";

const env = process.env;
export const tts = {
  provider: (env.KKACHI_TTS_PROVIDER ?? "edge") as "edge" | "supertonic" | "openai",
  voice: env.KKACHI_TTS_VOICE ?? "device",
  baseUrl: env.KKACHI_TTS_BASE_URL ?? (env.KKACHI_TTS_PROVIDER === "supertonic" ? "http://127.0.0.1:8093/v1" : "https://api.openai.com/v1"),
  apiKey: env.KKACHI_TTS_API_KEY ?? env.OPENAI_API_KEY ?? "",
  model: env.KKACHI_TTS_MODEL ?? "gpt-4o-mini-tts",
};

/** The voice that is no server voice: each device speaks with its own. */
export const BUILT_IN = "device";

export async function synthesize(text: string, voice: string, rate: number): Promise<{ audio: ArrayBuffer; type: string }> {
  if (tts.provider === "supertonic") return supertonicTts(text, voice, rate);
  if (tts.provider !== "edge") return openaiTts(text);
  // The Edge service sometimes answers with no audio (NoAudioReceived); a second try usually works.
  return edgeTts(text, voice, rate).catch(() => edgeTts(text, voice, rate));
}

// Edge TTS via the edge-tts CLI (`uv tool install edge-tts`).
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

// Supertonic 3 behind scripts/supertonic-server.py: the voice chosen in the settings (F1 to F5, M1 to M5;
// any other, such as an Edge voice chosen before, is its first), the speed as OpenAI's, a WAVE back.
async function supertonicTts(text: string, voice: string, rate: number) {
  const r = await fetch(`${tts.baseUrl}/audio/speech`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: text, voice, speed: 1 + rate / 100, response_format: "wav" }),
  });
  if (!r.ok) throw new Error(`supertonic ${r.status}: ${await r.text()}`);
  return { audio: await r.arrayBuffer(), type: r.headers.get("Content-Type") ?? "audio/wav" };
}

async function openaiTts(text: string) {
  const { baseUrl, apiKey, model, voice } = tts;
  const r = await fetch(`${baseUrl}/audio/speech`, {
    method: "POST",
    headers: { ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), "Content-Type": "application/json" },
    body: JSON.stringify({ model, voice, input: text, response_format: "mp3" }),
  });
  if (!r.ok) throw new Error(`tts ${r.status}: ${await r.text()}`);
  return { audio: await r.arrayBuffer(), type: r.headers.get("Content-Type") ?? "audio/mpeg" };
}
