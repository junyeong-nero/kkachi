// Kkachi's services as MCP servers (Streamable HTTP, stateless, plain JSON responses), so any agent
// can use them: add {"url": "https://<computer>.<tailnet>.ts.net:8443/mcp/<service>"} to its MCP config.
// /mcp/devices: spare phones and tablets (src/devices.ts). /mcp/memory: the notes (src/memory-mcp.ts).
// Requests from other websites are refused before they get here (see trusted() in src/server.ts).
import { DEVICE_TOOLS } from "./device-tools";
import { describeDevices, speakOn } from "./devices";
import { MEMORY_TOOLS } from "./memory-mcp";

export interface McpTool {
  name: string;
  description: string;
  inputSchema: object;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  run(args: any): Promise<string> | string;
}
interface McpService { name: string; instructions: string; tools: McpTool[] }

const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];

export const SERVICES: Record<string, McpService> = {
  devices: {
    name: "kkachi-devices",
    instructions: "Spare phones and tablets around the user's home that can speak out loud. Call list_devices to see their names.",
    tools: DEVICE_TOOLS.map((t) => ({
      ...t,
      annotations: t.name === "list_devices" ? { readOnlyHint: true } : { readOnlyHint: false, destructiveHint: false },
      run: t.name === "list_devices" ? () => describeDevices() : (a) => speakOn(String(a?.device ?? ""), String(a?.text ?? "")),
    })),
  },
  memory: {
    name: "kkachi-memory",
    instructions: "The user's personal memory: Markdown notes in a git repo (plans, decisions, preferences, facts about their life). Search or list before writing, and add to an existing note rather than creating a near-duplicate. Every change is one git commit; memory_undo reverts the last one.",
    tools: MEMORY_TOOLS,
  },
};

const reply = (id: unknown, body: object) => Response.json({ jsonrpc: "2.0", id, ...body });

export async function handleMcp(service: McpService, req: Request): Promise<Response> {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405, headers: { Allow: "POST" } });
  const msg: any = await req.json().catch(() => null);
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return reply(null, { error: { code: -32600, message: "invalid request" } });
  if (msg.id === undefined) return new Response(null, { status: 202 }); // notifications need no answer
  switch (msg.method) {
    case "initialize":
      return reply(msg.id, { result: {
        protocolVersion: VERSIONS.includes(msg.params?.protocolVersion) ? msg.params.protocolVersion : VERSIONS[0],
        capabilities: { tools: {} },
        serverInfo: { name: service.name, version: "0.1.0" },
        instructions: service.instructions,
      } });
    case "ping":
      return reply(msg.id, { result: {} });
    case "tools/list":
      return reply(msg.id, { result: { tools: service.tools.map(({ run, ...t }) => t) } });
    case "tools/call": {
      const tool = service.tools.find((t) => t.name === msg.params?.name);
      if (!tool) return reply(msg.id, { error: { code: -32602, message: `unknown tool: ${msg.params?.name}` } });
      try {
        return reply(msg.id, { result: { content: [{ type: "text", text: await tool.run(msg.params?.arguments ?? {}) }] } });
      } catch (err) {
        return reply(msg.id, { result: { content: [{ type: "text", text: (err as Error).message }], isError: true } });
      }
    }
    default:
      return reply(msg.id, { error: { code: -32601, message: `method not found: ${msg.method}` } });
  }
}
