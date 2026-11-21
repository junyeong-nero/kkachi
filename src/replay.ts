// A turn outlives its HTTP stream: iOS cuts a backgrounded app's connections while the turn keeps
// running here. Each turn's events are kept under an id the app makes up, so the app can pick up
// where it left off (POST /api/turn again with the same id and the number of events it has) even
// when the first response never reached it.
import type { TurnEvent } from "./turn";

const KEEP = 20; // recent turns kept in memory

export class TurnRecord {
  readonly events: TurnEvent[] = [];
  done = false;
  private waiting = new Set<() => void>();

  push(e: TurnEvent) { this.events.push(e); this.wake(); }
  finish() { this.done = true; this.wake(); }
  /** Resolves on the next event or when the turn finishes. */
  changed() { return new Promise<void>((r) => this.waiting.add(r)); }
  private wake() { for (const r of this.waiting) r(); this.waiting.clear(); }
}

const turns = new Map<string, TurnRecord>();

export function recordTurn(id: string): TurnRecord {
  const record = new TurnRecord();
  turns.set(id, record);
  for (const old of turns.keys()) { if (turns.size <= KEEP) break; turns.delete(old); } // oldest first
  return record;
}

export const findTurn = (id: string) => turns.get(id);

/** Server-sent events of a turn from event `from` on, following it live until it finishes. */
export function streamTurn(record: TurnRecord, from: number): Response {
  let open = true, heartbeat: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      // Writes to a stream the phone dropped are skipped instead of throwing (that killed the server).
      const send = (chunk: string) => {
        if (!open) return;
        try { controller.enqueue(enc.encode(chunk)); } catch { open = false; }
      };
      heartbeat = setInterval(() => send(": ping\n\n"), 15_000); // lets the client detect a dead stream
      for (let i = Math.max(0, from); open; ) {
        while (i < record.events.length) send(`data: ${JSON.stringify(record.events[i++])}\n\n`);
        if (record.done) break;
        await record.changed();
      }
      clearInterval(heartbeat);
      if (open) { open = false; try { controller.close(); } catch {} }
    },
    cancel() { open = false; clearInterval(heartbeat); },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
}
