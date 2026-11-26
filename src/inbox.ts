// Accepting inputs from devices (docs/bus.md): each id once, and only while fresh.
export type Input = { id: string; source: { id: string; name: string }; kind: "talk"; age: number; audio: string; mime: string; agent?: boolean }; // agent: this device's voice is open to Kkachi (false: only to what it is joined to)
export type Accepted = { accepted: boolean; duplicate?: boolean; reason?: string };

export const INPUT_TTL_MS = 60_000; // older than this when it arrives: dropped, a late "불 꺼줘" must not run
const SEEN_MS = 10 * 60_000;       // a resend comes within seconds; ids are kept well past that

/** Accept each input id once and only while fresh; hand accepted ones to `handle`. */
export function makeInbox(handle: (e: Input) => void, ttlMs = INPUT_TTL_MS, clock = Date.now) {
  const seen = new Map<string, number>();
  return (e: Input): Accepted => {
    const t = clock();
    for (const [id, at] of seen) if (t - at > SEEN_MS) seen.delete(id);
    if (seen.has(e.id)) return { accepted: true, duplicate: true };
    if (!(e.age >= 0) || e.age > ttlMs) return { accepted: false, reason: "expired" };
    seen.set(e.id, t);
    handle(e);
    return { accepted: true };
  };
}
