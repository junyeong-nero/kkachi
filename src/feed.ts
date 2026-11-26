// What reaches Kkachi Home outside its own turns (docs/bus.md): conversations on spare devices
// that the phone should see, and messages an agent sends with send_to_phone. The app listens while
// it is open (GET /api/feed, server-sent events) and picks up where it left off through the event
// id (Last-Event-ID), which carries this server run's epoch. Kept in memory, the last 100.
export type FeedItem = {
  id: number; at: string;
  kind: "turn" | "message";
  from: string;   // the device ("거실"), or "까치" for a message
  heard?: string; // what was said there (turns)
  text: string;   // the answer or the message
  speak: boolean; // read aloud on the phone when read-aloud is on
};

const KEEP = 100;
const EPOCH = Date.now().toString(36);
const items: FeedItem[] = [];
const listeners = new Set<(i: FeedItem) => void>();
let next = 1;

export function pushFeed(i: Omit<FeedItem, "id" | "at">): FeedItem {
  const item = { ...i, id: next++, at: new Date().toISOString() };
  items.push(item);
  if (items.length > KEEP) items.shift();
  for (const l of listeners) l(item);
  return item;
}

/** lastEventId: "<epoch>:<id>" the app saw last. Another epoch (the server restarted) means all kept items. */
export function feedStream(lastEventId: string | null): Response {
  const [epoch, seen] = (lastEventId ?? "").split(":");
  const after = !lastEventId ? next - 1 : epoch === EPOCH ? Number(seen) || 0 : 0;
  let off = () => {}, heartbeat: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      const send = (chunk: string) => { try { controller.enqueue(enc.encode(chunk)); } catch { off(); } };
      const emit = (i: FeedItem) => send(`id: ${EPOCH}:${i.id}\ndata: ${JSON.stringify(i)}\n\n`);
      send(`id: ${EPOCH}:${after}\ndata: {"kind":"hello"}\n\n`); // a first visit starts from now
      for (const i of items) if (i.id > after) emit(i);
      listeners.add(emit);
      heartbeat = setInterval(() => send(": ping\n\n"), 15_000);
      off = () => { listeners.delete(emit); clearInterval(heartbeat); };
    },
    cancel() { off(); },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
}
