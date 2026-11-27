import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// One server that answers with three tools, and one address nobody listens on.
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const msg: any = await req.json();
    const result = msg.method === "tools/list" ? { tools: [{ name: "a_one" }, { name: "a_two" }, { name: "b_one" }] } : {};
    return Response.json({ jsonrpc: "2.0", id: msg.id, result });
  },
});
const dir = mkdtempSync(join(tmpdir(), "kkachi-connections-"));
writeFileSync(join(dir, "kkachi.mcp.json"), JSON.stringify({
  servers: { up: { url: `http://127.0.0.1:${server.port}/mcp` }, down: { url: "http://127.0.0.1:1/mcp" } },
  agents: { chat: ["up:a_*", "down:*"] },
}));
mkdirSync(join(dir, ".git")); // src/config.ts wants a notes repo
afterAll(() => { server.stop(true); rmSync(dir, { recursive: true, force: true }); });

test("servers that answer, and servers that do not", async () => {
  // In its own process: src/mcp-bridge.ts reads its settings once, and the other test files share this one.
  const p = Bun.spawn([process.execPath, "-e", `console.log(JSON.stringify(await (await import("./src/mcp-bridge")).connections()))`], {
    cwd: join(import.meta.dir, ".."), stdout: "pipe", stderr: "inherit",
    env: { ...process.env, KKACHI_MCP_CONFIG: join(dir, "kkachi.mcp.json"), KKACHI_MEMORY_DIR: dir, KKACHI_DATA_DIR: dir },
  });
  const list = JSON.parse(await new Response(p.stdout).text());
  expect(list).toContainEqual({ name: "up", ok: true, tools: 2 }); // only the tools the chat may use
  expect(list).toContainEqual({ name: "down", ok: false });
});
