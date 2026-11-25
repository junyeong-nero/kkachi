// An MCP server over Streamable HTTP (stateless, plain JSON responses): enough for Kkachi's services
// and for any MCP client. A service is a name, instructions and tools. A tool marked `internal` is
// for Kkachi core only: listed and callable only with the internal token (lib/trust.ts).
import { internal } from "./trust";

export type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

export interface McpTool {
  name: string;
  description: string;
  inputSchema: object;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
  internal?: boolean;
  // text, or content blocks such as a photo. meta: the caller's params._meta (set per agent in core's kkachi.mcp.json)
  run(args: any, meta: Record<string, unknown>): Promise<string | Content[]> | string | Content[];
}
export interface McpService { name: string; instructions: string; tools: McpTool[] }

const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
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
      return reply(msg.id, { result: { tools: service.tools.filter((t) => !t.internal || internal(req)).map(({ run, internal: _, ...t }) => t) } });
    case "tools/call": {
      const tool = service.tools.find((t) => t.name === msg.params?.name && (!t.internal || internal(req)));
      if (!tool) return reply(msg.id, { error: { code: -32602, message: `unknown tool: ${msg.params?.name}` } });
      try {
        const meta = msg.params?._meta && typeof msg.params._meta === "object" ? msg.params._meta : {};
        const out = await tool.run(msg.params?.arguments ?? {}, meta);
        return reply(msg.id, { result: { content: typeof out === "string" ? [{ type: "text", text: out }] : out } });
      } catch (err) {
        return reply(msg.id, { result: { content: [{ type: "text", text: (err as Error).message }], isError: true } });
      }
    }
    default:
      return reply(msg.id, { error: { code: -32601, message: `method not found: ${msg.method}` } });
  }
}
