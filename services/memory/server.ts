// kkachi-memory: the user's notes and their git history as one MCP service. Its own process, started
// by Kkachi core (kkachi.mcp.json); /mcp/memory is forwarded from core's address for agents on
// other computers. Its git_* tools answer only Kkachi core (internal token). It also runs on its own
// for any agent (README.md): this folder imports nothing from outside it.
import { handleMcp } from "./lib/mcp-server";
import { trusted } from "./lib/trust";
import { service } from "./tools";

const port = Number(process.env.KKACHI_MEMORY_PORT ?? 4302);

Bun.serve({
  port,
  hostname: "127.0.0.1",
  idleTimeout: 255,
  async fetch(req) {
    if (!trusted(req)) return new Response("forbidden", { status: 403 });
    const { pathname } = new URL(req.url);
    if (pathname === "/mcp" || pathname === "/mcp/memory") return handleMcp(service, req);
    return new Response("not found", { status: 404 });
  },
});

console.log(`kkachi-memory listening on http://127.0.0.1:${port} (${process.env.KKACHI_MEMORY_DIR})`);
