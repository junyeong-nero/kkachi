// Kkachi's devices as an MCP server at /mcp (Streamable HTTP, stateless, plain JSON responses), so
// any agent can use them: add {"url": "https://<computer>.<tailnet>.ts.net:8443/mcp"} to its MCP config.
import { DEVICE_TOOLS } from "./device-tools";
import { describeDevices, speakOn } from "./devices";

const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];

const handlers: Record<string, (args: any) => Promise<string> | string> = {
  list_devices: () => describeDevices(),
  device_speak: (a) => speakOn(String(a?.device ?? ""), String(a?.text ?? "")),
};

const reply = (id: unknown, body: object) => Response.json({ jsonrpc: "2.0", id, ...body });

// Requests from other websites are refused before they get here (see trusted() in src/server.ts).
export async function handleMcp(req: Request): Promise<Response> {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers: { Allow: "POST" } });
  const msg: any = await req.json().catch(() => null);
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return reply(null, { error: { code: -32600, message: "invalid request" } });
  if (msg.id === undefined) return new Response(null, { status: 202 }); // notifications need no answer
  switch (msg.method) {
    case "initialize":
      return reply(msg.id, { result: {
        protocolVersion: VERSIONS.includes(msg.params?.protocolVersion) ? msg.params.protocolVersion : VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: "kkachi-devices", version: "0.1.0" },
        instructions: "Spare phones and tablets around the user's home that can speak out loud. Call list_devices to see their names.",
      } });
    case "ping":
      return reply(msg.id, { result: {} });
    case "tools/list":
      return reply(msg.id, { result: { tools: DEVICE_TOOLS } });
    case "tools/call": {
      const run = handlers[msg.params?.name];
      if (!run) return reply(msg.id, { error: { code: -32602, message: `unknown tool: ${msg.params?.name}` } });
      try {
        return reply(msg.id, { result: { content: [{ type: "text", text: await run(msg.params?.arguments ?? {}) }] } });
      } catch (err) {
        return reply(msg.id, { result: { content: [{ type: "text", text: (err as Error).message }], isError: true } });
      }
    }
    default:
      return reply(msg.id, { error: { code: -32601, message: `method not found: ${msg.method}` } });
  }
}
