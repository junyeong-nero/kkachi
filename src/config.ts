import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { tts } from "../lib/tts";

const env = process.env;
const root = resolve(import.meta.dir, "..");

function required(name: string): string {
  const v = env[name];
  if (!v) throw new Error(`${name} is not set. Add it to .env (see README).`);
  return v;
}

const memoryDir = realpathSync(required("KKACHI_MEMORY_DIR"));
if (!existsSync(join(memoryDir, ".git"))) throw new Error(`KKACHI_MEMORY_DIR is not a git repo: ${memoryDir}`);

const dataDir = resolve(env.KKACHI_DATA_DIR ?? join(root, "data"));
mkdirSync(dataDir, { recursive: true });

export const config = {
  root,
  memoryDir,
  dataDir,
  // Kkachi's own Pi setup (accounts, MCP servers, packages), apart from the user's ~/.pi/agent. src/agent-dir.ts
  agentDir: resolve(env.KKACHI_AGENT_DIR ?? join(dataDir, "agent")),
  port: Number(env.KKACHI_PORT ?? 4300),
  // Ordered fallback list of Pi models (provider/model, comma-separated). See src/models.ts.
  // Default: the Pi subscription model first, free OpenRouter models if it is limited.
  models: (env.KKACHI_MODEL ?? [
    "openai/gpt-6.2-sol",
    "openrouter/particle-ai/particle-1:free",
    "openrouter/nvidia/nemotron-3.5-super-vl:free",
    "openrouter/recursive/flint-v1.0:free",
  ].join(","))
    .split(",").map((m) => m.trim()).filter(Boolean),
  piBin: env.KKACHI_PI_BIN ?? "pi",
  thinking: env.KKACHI_THINKING ?? "low", // Pi thinking level: off | minimal | low | medium | high
  timeZone: env.KKACHI_TIMEZONE ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  stt: {
    baseUrl: env.KKACHI_STT_BASE_URL ?? "https://api.groq.com/openai/v1",
    apiKey: env.KKACHI_STT_API_KEY ?? env.GROQ_API_KEY ?? "",
    model: env.KKACHI_STT_MODEL ?? "whisper-large-v3", // not turbo: it reports no_speech_prob, which filters noise
    language: env.KKACHI_STT_LANGUAGE ?? "ko",
    // OpenAI's chunking_strategy, sent when set ("auto"): a server with a voice detector then writes only
    // where someone speaks. For models that report no no_speech_prob and make words up for silence
    // (Qwen3-ASR on speech.cpp wrote "이미." for three silent seconds).
    chunking: env.KKACHI_STT_CHUNKING ?? "",
  },
  // Transcript cleanup before the agent (OpenAI-compatible chat API). Off unless KKACHI_POLISH_MODEL
  // is set (e.g. openai/gpt-oss-120b on Groq): it is one more outside call per dictation
  // (docs/philosophy.md). Off, filler sounds are still dropped and the transcript goes as heard.
  polish: {
    baseUrl: env.KKACHI_POLISH_BASE_URL ?? "https://api.groq.com/openai/v1",
    apiKey: env.KKACHI_POLISH_API_KEY ?? env.GROQ_API_KEY ?? "",
    model: env.KKACHI_POLISH_MODEL ?? "",
  },
  tts, // lib/tts.ts: shared with the devices service
};
