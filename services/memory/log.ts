// The memory service's log: JSONL lines like core's. Started by Kkachi core they also go into core's
// kkachi.log (KKACHI_DATA_DIR); on its own, only to the console. The service keeps no other state:
// everything it knows is in the notes repo.
import { appendFileSync } from "node:fs";
import { join } from "node:path";

export function log(event: string, data: Record<string, unknown> = {}) {
  const line = JSON.stringify({ t: new Date().toISOString(), event, ...data });
  if (process.env.KKACHI_DATA_DIR) appendFileSync(join(process.env.KKACHI_DATA_DIR, "kkachi.log"), line + "\n");
  console.log(line);
}
