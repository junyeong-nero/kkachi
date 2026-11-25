// Where the devices service keeps its state (devices.json) and its log. Kkachi core passes its own
// data directory (KKACHI_DATA_DIR), so both sit together; on its own the service uses ./data here.
import { appendFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

export const dataDir = resolve(process.env.KKACHI_DATA_DIR ?? join(import.meta.dir, "data"));
mkdirSync(dataDir, { recursive: true });

// Append-only JSONL, the same file and format as core's (kkachi.log), for latency and error analysis.
export function log(event: string, data: Record<string, unknown> = {}) {
  const line = JSON.stringify({ t: new Date().toISOString(), event, ...data });
  appendFileSync(join(dataDir, "kkachi.log"), line + "\n");
  console.log(line);
}
