// Where Kkachi lives, for core and the services alike.
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

export const root = resolve(import.meta.dir, "..");
export const dataDir = resolve(process.env.KKACHI_DATA_DIR ?? join(root, "data")); // private state, outside git
mkdirSync(dataDir, { recursive: true });
