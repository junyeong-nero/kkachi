// Clean up a speech-recognition transcript with a small, fast LLM before the agent sees it:
// fix misheard words, spacing, numbers, and drop noise. Returns "" for noise (the client then
// just keeps listening). Falls back to the raw transcript if the LLM fails.
import { config } from "./config";

const TIMEOUT_MS = 2500;
const NOISE = "<noise>";

// Cheap pre-filter: only filler syllables ("아 아 아", "음...", "어어"), no LLM call needed.
// Not 응/네/예: those are real answers ("KE123 맞죠?" → "응").
const FILLER_ONLY = /^[아어오우으음엄흠허하호에\s.,!?~…·-]*$/;

const SYSTEM = `You fix speech-recognition transcripts of Korean (sometimes mixed with English) spoken to a voice assistant.
Return only the corrected transcript, nothing else.
- Return exactly ${NOISE} only when the transcript contains no real word at all: just filler sounds or repeated syllables ("아 아 아 아", "음 음", "어어어"), or a video outro ("구독과 좋아요 부탁드립니다", "시청해주셔서 감사합니다"). Any real word is speech, even a single word, a name, a title, or a word in another language ("림보", "limbo", "응", "아니")
- Fix misrecognized words when context makes the intended word clear (place names, people, common phrases), spacing, and punctuation
- Write times and dates naturally (일곱 시 → 7시, 삼월 십사일 → 3월 14일)
- Keep the meaning, tone, and wording otherwise. Do not add, remove, summarize, or answer anything
- If the input is a question or a request, it stays a question or a request
- If unsure, keep the original word`;

export async function polish(raw: string): Promise<string> {
  const { baseUrl, apiKey, model } = config.polish;
  if (!raw || FILLER_ONLY.test(raw)) return "";
  if (!model) return raw;
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
    if (out.includes(NOISE)) return "";
    // Guard against the model answering instead of correcting.
    return out && out.length <= raw.length * 2 + 20 ? out : raw;
  } catch (err) {
    console.error("polish failed, using raw transcript:", (err as Error).message);
    return raw;
  }
}
