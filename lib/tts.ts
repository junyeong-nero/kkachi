// Text to speech, for core (replies) and the devices service (device_speak).
// Edge TTS by default (free, unofficial), or any OpenAI-compatible speech API. Set with KKACHI_TTS_*.
// The voice and speed chosen in the app's settings live in data/settings.json; services read them.
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dataDir } from "./paths";

const env = process.env;
export const tts = {
  provider: (env.KKACHI_TTS_PROVIDER ?? "edge") as "edge" | "openai",
  voice: env.KKACHI_TTS_VOICE ?? "ko-KR-SunHiNeural",
  baseUrl: env.KKACHI_TTS_BASE_URL ?? "https://api.openai.com/v1",
  apiKey: env.KKACHI_TTS_API_KEY ?? env.OPENAI_API_KEY ?? "",
  model: env.KKACHI_TTS_MODEL ?? "gpt-4o-mini-tts",
};

/** The voice and speed saved in the app's settings, else the defaults. */
export function savedVoice(): { voice: string; rate: number } {
  const file = join(dataDir, "settings.json");
  const s = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  return { voice: typeof s.voice === "string" ? s.voice : tts.voice, rate: typeof s.rate === "number" ? s.rate : 0 };
}

export async function synthesize(text: string, voice: string, rate: number): Promise<{ audio: ArrayBuffer; type: string }> {
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
