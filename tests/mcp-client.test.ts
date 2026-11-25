import { afterAll, expect, test } from "bun:test";
import { mcpPost } from "../lib/mcp-client";

// A server that answers like Kkachi's services (JSON) on /json, and like ha-mcp (an SSE stream) on /sse.
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const msg: any = await req.json();
    const reply = { jsonrpc: "2.0", id: msg.id, result: { echo: msg.method, accept: req.headers.get("accept") } };
    if (new URL(req.url).pathname === "/json") return Response.json(reply);
    const sse = `: keep-alive\n\nevent: message\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{}}\n\nevent: message\ndata: ${JSON.stringify(reply)}\n\n`;
    return new Response(sse, { headers: { "content-type": "text/event-stream" } });
  },
});
afterAll(() => server.stop(true));

test("a JSON answer and an SSE answer read the same", async () => {
  for (const path of ["/json", "/sse"]) {
    const { status, body } = await mcpPost(`http://127.0.0.1:${server.port}${path}`, { id: 7, method: "tools/list" });
    expect(status).toBe(200);
    expect(body).toEqual({ jsonrpc: "2.0", id: 7, result: { echo: "tools/list", accept: "application/json, text/event-stream" } });
  }
});
