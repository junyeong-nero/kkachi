// What is going through the connections right now, for the phone app's 연결 screen (GET /api/flow,
// server-sent events): one event each time something leaves an input for where it is joined to. The key
// is the link's id, or "agent:<device id>" for a voice that went to the agent. A screen that opens later
// first gets the latest of each key (marked old: it happened before, nothing is moving), so every row
// can say when it was last used. Kept in memory only.
export type Flow = { key: string; at: string; value?: number; error?: boolean; old?: boolean };

const latest = new Map<string, Flow>();
const listeners = new Set<(f: Flow) => void>();

export function emitFlow(key: string, value?: number, error?: boolean) {
  const flow: Flow = { key, at: new Date().toISOString(), ...(value !== undefined && { value }), ...(error && { error }) };
  latest.set(key, flow);
  for (const l of listeners) l(flow);
}

export function flowStream(): Response {
  let off = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      const send = (chunk: string) => { try { controller.enqueue(enc.encode(chunk)); } catch { off(); } };
      const emit = (f: Flow) => send(`data: ${JSON.stringify(f)}\n\n`);
      for (const f of latest.values()) emit({ ...f, old: true });
      listeners.add(emit);
      const heartbeat = setInterval(() => send(": ping\n\n"), 15_000);
      off = () => { listeners.delete(emit); clearInterval(heartbeat); };
    },
    cancel() { off(); },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
}
