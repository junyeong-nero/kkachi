// Calls to Kkachi core, when core started this service (KKACHI_CORE_URL, and the shared
// KKACHI_INTERNAL_TOKEN). The devices service hands core what someone said to a device,
// and asks it how to speak. On its own there is no core: talk is refused and devices speak with
// their own voice. The contract is in PROTOCOL.md.
import { INTERNAL_HEADER } from "./lib/trust";

const url = () => process.env.KKACHI_CORE_URL;
const headers = () => ({ "Content-Type": "application/json", [INTERNAL_HEADER]: process.env.KKACHI_INTERNAL_TOKEN ?? "" });

export async function core(path: string, body: object, timeoutMs = 10_000): Promise<any> {
  if (!url()) throw new Error("not started by Kkachi core (no KKACHI_CORE_URL)");
  const r = await fetch(url() + path, { method: "POST", headers: headers(), body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  if (!r.ok) throw new Error(`core ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}

/** How to say text on a device: the rate, and audio unless the device says it with its own voice
 * (the "device" voice in core's settings, or no core at all). */
export async function speech(text: string, waitMs = 60_000): Promise<{ rate: number; audio?: string; mime?: string }> {
  if (!url()) return { rate: 0 };
  const { voice, rate } = await core("/api/bus/voice", {}, 3000).catch(() => ({ voice: "device", rate: 0 }));
  if (voice === "device") return { rate };
  const r = await fetch(url() + "/api/tts", { method: "POST", headers: headers(), body: JSON.stringify({ text: text.slice(0, 1000) }), signal: AbortSignal.timeout(waitMs) });
  if (!r.ok) throw new Error(`core /api/tts: ${r.status} ${await r.text()}`);
  return { rate, audio: Buffer.from(await r.arrayBuffer()).toString("base64"), mime: r.headers.get("Content-Type") ?? "audio/mpeg" };
}
