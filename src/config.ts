import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

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
  port: Number(env.KKACHI_PORT ?? 4300),
  model: env.KKACHI_MODEL ?? "opencode/deepseek-v4.1-flash-free",
  opencodeBin: env.KKACHI_OPENCODE_BIN ?? "opencode",
  stt: {
    baseUrl: env.KKACHI_STT_BASE_URL ?? "https://api.groq.com/openai/v1",
    apiKey: env.KKACHI_STT_API_KEY ?? env.GROQ_API_KEY ?? "",
    model: env.KKACHI_STT_MODEL ?? "whisper-large-v3-turbo",
    language: env.KKACHI_STT_LANGUAGE ?? "ko",
  },
  tts: {
    provider: (env.KKACHI_TTS_PROVIDER ?? "edge") as "edge" | "openai",
    voice: env.KKACHI_TTS_VOICE ?? "ko-KR-SunHiNeural",
    baseUrl: env.KKACHI_TTS_BASE_URL ?? "https://api.openai.com/v1",
    apiKey: env.KKACHI_TTS_API_KEY ?? env.OPENAI_API_KEY ?? "",
    model: env.KKACHI_TTS_MODEL ?? "gpt-4o-mini-tts",
  },
};
