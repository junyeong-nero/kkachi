// Kkachi's services run as their own processes. Core starts the servers in kkachi.mcp.json that
// have a "command", restarts one that stops, and forwards its "routes" (its own pages and sockets)
// from core's address, so the phone still reaches everything at one place. Services get
// KKACHI_CORE_URL and a shared KKACHI_INTERNAL_TOKEN to call core back (see lib/trust.ts), and core's
// data directory, so their state sits with core's.
import { config } from "./config";
import { load, rpc, type Server } from "./mcp-bridge";

process.env.KKACHI_INTERNAL_TOKEN ??= Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("hex");
const children = new Set<ReturnType<typeof Bun.spawn>>();
let stopping = false;

function run(name: string, s: Server) {
  const [bin, ...args] = s.command!;
  const p = Bun.spawn([bin === "bun" ? process.execPath : bin, ...args], {
    cwd: config.root,
    env: { ...process.env, KKACHI_CORE_URL: `http://127.0.0.1:${config.port}`, KKACHI_DATA_DIR: config.dataDir },
    stdout: "inherit", stderr: "inherit",
  });
  children.add(p);
  p.exited.then((code) => {
    children.delete(p);
    if (stopping) return;
    console.error(`service ${name} stopped (${code}); starting it again in 3 s`);
    setTimeout(() => run(name, s), 3000);
  });
}

/** Start the services and wait until each answers (or 30 s), so agents find their tools. */
export async function startServices() {
  const servers = Object.entries(load().servers).filter(([, s]) => s.command?.length);
  for (const [name, s] of servers) run(name, s);
  await Promise.all(servers.map(async ([name, s]) => {
    for (let i = 0; i < 60; i++) {
      try { await rpc(s.url, "ping"); return; } catch { await Bun.sleep(500); }
    }
    console.error(`service ${name} did not answer at ${s.url}`);
  }));
}

for (const signal of ["exit", "SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopping = true;
    for (const p of children) p.kill();
    if (signal !== "exit") process.exit(0);
  });
}

/** The service URL for a path one of them serves ("/device", "/api/device/ws"), or null. */
let routed: Server[] | null = null; // kkachi.mcp.json is read once; restart core to change it
export function routeFor(pathname: string): string | null {
  routed ??= Object.values(load().servers).filter((s) => s.routes.length);
  for (const s of routed) {
    if (s.routes.some((r) => (r.endsWith("/") ? pathname.startsWith(r) : pathname === r))) return new URL(s.url).origin + pathname;
  }
  return null;
}
