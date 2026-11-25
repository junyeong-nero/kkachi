// Calls to Kkachi core, which started this service and gave it KKACHI_CORE_URL and the shared
// KKACHI_INTERNAL_TOKEN. The devices service hands core what someone said to a device (a "port");
// core runs the agent and answers.
import { INTERNAL_HEADER } from "../../lib/trust";

export async function core(path: string, body: object, timeoutMs = 10_000): Promise<any> {
  const url = process.env.KKACHI_CORE_URL;
  if (!url) throw new Error("not started by Kkachi core (no KKACHI_CORE_URL)");
  const r = await fetch(url + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", [INTERNAL_HEADER]: process.env.KKACHI_INTERNAL_TOKEN ?? "" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`core ${path}: ${r.status} ${await r.text()}`);
  return r.json();
}
