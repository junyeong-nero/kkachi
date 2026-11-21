// Model fallback. Free models hit usage or upstream rate limits; when one does, use the next one in
// KKACHI_MODEL (comma-separated) until its cooldown ends.
import { config } from "./config";

const exhaustedUntil = new Map<string, number>();

export function currentModel(): string {
  const now = Date.now();
  return config.models.find((m) => (exhaustedUntil.get(m) ?? 0) <= now) ?? config.models[0];
}

export const isLimitError = (message: string) => /\b429\b|rate.?limit|quota|free.?(usage|limit)|capacity/i.test(message);

/** Mark a model as limited. Returns true if another model is available to retry with. */
export function markLimited(model: string, message: string): boolean {
  // Daily limits ("free usage", "quota") last long; upstream rate limits clear quickly.
  const daily = /quota|free.?usage|per.?day|daily/i.test(message);
  exhaustedUntil.set(model, Date.now() + (daily ? 60 : 5) * 60_000);
  console.error(`model ${model} limited; cooling down ${daily ? 60 : 5} min`);
  return currentModel() !== model;
}
