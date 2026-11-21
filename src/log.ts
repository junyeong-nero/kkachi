// Append-only JSONL log in data/kkachi.log (survives restarts) for latency and error analysis.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";

const file = join(config.dataDir, "kkachi.log");

export function log(event: string, data: Record<string, unknown> = {}) {
  const line = JSON.stringify({ t: new Date().toISOString(), event, ...data });
  appendFileSync(file, line + "\n");
  console.log(line);
}
