// Clean up a speech-recognition transcript with a small, fast LLM before the agent sees it:
// fix misheard words, spacing, numbers. Falls back to the raw transcript on any failure.
import { config } from "./config";

const TIMEOUT_MS = 2500;
const SYSTEM = `You fix speech-recognition transcripts of Korean (sometimes mixed with English) spoken to a voice assistant.
Return only the corrected transcript, nothing else.
- Fix misrecognized words when context makes the intended word clear (place names, people, common phrases), spacing, and punctuation
- Write times and dates naturally (일곱 시 → 7시, 삼월 십사일 → 3월 14일)
- Keep the meaning, tone, and wording otherwise. Do not add, remove, summarize, or answer anything
- If the input is a question or a request, it stays a question or a request
- If unsure, keep the original word`;

export async function polish(raw: string): Promise<string> {
  const { baseUrl, apiKey, model } = config.polish;
  if (!raw || !model) return raw;
  try {
    const body: Record<string, unknown> = {
      model,
      temperature: 0,
      messages: [{ role: "system", content: SYSTEM }, { role: "user", content: raw }],
    };
    if (model.includes("gpt-oss")) body.reasoning_effort = "low";
    const r = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}), "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`polish ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const out = String(((await r.json()) as any).choices?.[0]?.message?.content ?? "").trim();
    // Guard against the model answering instead of correcting.
    return out && out.length <= raw.length * 2 + 20 ? out : raw;
  } catch (err) {
    console.error("polish failed, using raw transcript:", (err as Error).message);
    return raw;
  }
}
