// Model fallback. Free models hit per-model usage limits; when one does, use the next one in
// KKACHI_MODEL (comma-separated) until its limit resets.
import { config } from "./config";

const exhaustedUntil = new Map<string, number>();

export function currentModel(): string {
  const now = Date.now();
  return config.models.find((m) => (exhaustedUntil.get(m) ?? 0) <= now) ?? config.models[0];
}

/** Returns true if the failure was a usage/rate limit and another model is available. */
export function markLimited(model: string, error: any): boolean {
  const type = String(error?.type ?? "");
  if (!/free-limit|rate-limit|quota/.test(type) && error?.status !== 429) return false;
  // Daily free limits come with retryAfterMs; upstream rate limits (shared free pools) clear quickly.
  const retryMs = Number(error?.retryAfterMs) || (/rate-limit/.test(type) ? 5 * 60_000 : 60 * 60_000);
  exhaustedUntil.set(model, Date.now() + retryMs);
  console.error(`model ${model} limited (${type}); retry after ${Math.round(retryMs / 60_000)} min`);
  return currentModel() !== model;
}
