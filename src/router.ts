// Connections (docs/bus.md): an input of one device joined straight to an output of another, with
// no agent in between. A dial sets the brightness of a lamp, a button switches it on and off, and
// what is said is played on a speaker as it was recorded, like a walkie-talkie. One input can be
// joined to several outputs, and whether the agent also gets it is not decided here (that is which
// inputs are open to Kkachi, kept by the devices service). The links are data (data/routes.json), so
// they are made and removed while Kkachi runs.
// - Of a dial only the newest value matters: while one is on its way to an output, later ones replace
//   each other behind it.
// - Every press of a button and everything said counts: they go out one after another.
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const OUTPUT = { dial: "light", click: "light", talk: "speak" } as const; // what each kind of input can be joined to
type Kind = keyof typeof OUTPUT;
export type Source = { id: string; name: string };
export type Link = { id: string; from: { device: string; kind: Kind }; to: { device: string; output: "light" | "speak" }; on?: boolean }; // on unless switched off
export type Last = { at: string; value: number; error?: string }; // the latest value sent, and why it failed if it did
type Send = (link: Link, value: number, source: Source, payload?: unknown) => Promise<unknown>; // payload: what was said, for talk

const deviceId = (v: unknown): v is string => typeof v === "string" && /^[\w-]{1,64}$/.test(v);

/** flowed: told each time something leaves for an output, and again if it could not be delivered. */
export function makeRouter(file: string, send: Send, flowed: (linkId: string, value: number, error?: boolean) => void = () => {}) {
  let links: Link[] = (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as Link[] : []).filter((l) => deviceId(l?.to?.device)); // links to the agent, from before, are gone
  const last = new Map<string, Last>();
  const waiting = new Map<string, { next?: number }>(); // per link with a value on its way
  const queue = new Map<string, Promise<void>>();       // per link, the presses and recordings going out in order
  const save = () => writeFileSync(file, JSON.stringify(links, null, 2));

  const sendOne = async (link: Link, v: number, source: Source, payload?: unknown) => {
    flowed(link.id, v);
    try { await send(link, v, source, payload); last.set(link.id, { at: new Date().toISOString(), value: v }); }
    catch (err) { last.set(link.id, { at: new Date().toISOString(), value: v, error: String((err as Error).message ?? err).slice(0, 200) }); flowed(link.id, v, true); }
  };
  async function deliver(link: Link, value: number, source: Source, payload?: unknown) {
    if (link.from.kind !== "dial") {
      const sent = (queue.get(link.id) ?? Promise.resolve()).then(() => sendOne(link, value, source, payload));
      queue.set(link.id, sent);
      return sent;
    }
    const behind = waiting.get(link.id);
    if (behind) { behind.next = value; return; }
    const state: { next?: number } = {};
    waiting.set(link.id, state);
    for (let v: number | undefined = value; v !== undefined; v = state.next) {
      state.next = undefined;
      await sendOne(link, v, source);
    }
    waiting.delete(link.id);
  }

  return {
    list: () => links.map((l) => ({ ...l, last: last.get(l.id) })),
    /** Which inputs of each device are joined to something now: {<device id>: [kinds]}. */
    joined(): Record<string, string[]> {
      const by: Record<string, string[]> = {};
      for (const l of links) if (l.on !== false && !(by[l.from.device] ??= []).includes(l.from.kind)) by[l.from.device].push(l.from.kind);
      return by;
    },
    /** Join an input to an output of another kind of thing: a dial or a button to a lamp, a voice to
     * another device's speaker. The same pair twice is one link. Null: not something that can be joined. */
    add(body: any): Link | null {
      const from = body?.from, to = body?.to;
      if (!deviceId(from?.device) || !(from.kind in OUTPUT) || !deviceId(to?.device) || to.output !== OUTPUT[from.kind as Kind]) return null;
      if (from.kind === "talk" && to.device === from.device) return null; // not to its own speaker
      const had = links.find((l) => l.from.device === from.device && l.from.kind === from.kind && l.to.device === to.device);
      if (had) return had;
      const link: Link = { id: crypto.randomUUID().slice(0, 8), from: { device: from.device, kind: from.kind }, to: { device: to.device, output: to.output } };
      links.push(link);
      save();
      return link;
    },
    /** Switch a link off (kept, but its values go nowhere) or back on. */
    set(id: string, on: boolean): boolean {
      const link = links.find((l) => l.id === id);
      if (!link) return false;
      link.on = on;
      save();
      return true;
    },
    remove(id: string): boolean {
      if (!links.some((l) => l.id === id)) return false;
      links = links.filter((l) => l.id !== id);
      last.delete(id);
      save();
      return true;
    },
    /** A value from an input: sent to every output joined to it. Resolves, with how many and how many
     * of those failed, once the sends have settled. */
    async dispatch(source: Source, kind: string, value: number, payload?: unknown): Promise<{ sent: number; failed: number }> {
      const to = links.filter((l) => l.on !== false && l.from.device === source.id && l.from.kind === kind);
      if (!Number.isFinite(value)) return { sent: 0, failed: 0 };
      await Promise.all(to.map((l) => deliver(l, Math.min(100, Math.max(0, Math.round(value))), source, payload)));
      return { sent: to.length, failed: to.filter((l) => last.get(l.id)?.error).length };
    },
  };
}
