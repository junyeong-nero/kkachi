// Kkachi's Pi extension. Loaded only in the Pi processes Kkachi starts (`pi -e pi/kkachi.ts`),
// never in the user's own Pi sessions. Conversation-control tools are signals: the Kkachi web app
// watches tool_execution_start events for them. Everything else (notes, devices) comes from the MCP
// services core lists for this agent.
import { readFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { mcpPost } from "../lib/mcp-client";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }], details: {} });
const noArgs = Type.Object({});

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "end_conversation",
    label: "End conversation",
    description: "Stop listening because the user is done talking (thanks, bye, that's all, 됐어, 고마워, 잘 자). Say a short goodbye in the same reply.",
    parameters: noArgs,
    async execute() { return text("The microphone will turn off after your reply."); },
  });

  pi.registerTool({
    name: "handoff",
    label: "Hand off",
    description: "Stop listening because the user wants to take over or move elsewhere: they will continue themselves, on the computer, in another app, or need to talk to someone else (내가 직접 할게, 컴퓨터로 이어서 할게, 잠깐 딴 사람이랑 얘기 좀). Acknowledge briefly; mention where things stand if useful.",
    parameters: Type.Object({ reason: Type.Optional(Type.String({ description: "Why the user is taking over" })) }),
    async execute() { return text("The microphone will turn off after your reply."); },
  });

  pi.registerTool({
    name: "tidy_notes",
    label: "Tidy notes",
    description: "Ask the librarian to reorganize the memory repo and refresh its README catalog in the background after this turn.",
    parameters: noArgs,
    async execute() { return text("The librarian will tidy the notes in the background after this turn."); },
  });

  // The phone app as an output (docs/bus.md): it shows the message, and reads it aloud if set to.
  pi.registerTool({
    name: "send_to_phone",
    label: "Send to phone",
    description: "Show a message in the user's Kkachi phone app: details you should not say aloud on a device, or anything the user asks to send to their phone. Markdown is fine.",
    parameters: Type.Object({ text: Type.String() }),
    async execute(_id, params) {
      try {
        const r = await fetch(`${process.env.KKACHI_URL}/api/feed`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-kkachi-internal": process.env.KKACHI_INTERNAL_TOKEN ?? "" },
          body: JSON.stringify({ text: params.text }),
        });
        return text(r.ok ? "Sent to the phone app." : `Error: the phone app did not take it (HTTP ${r.status})`);
      } catch (err) {
        return text(`Error: Kkachi is unreachable (${(err as Error).message})`);
      }
    },
  });

  // MCP tools Kkachi core chose for this agent from kkachi.mcp.json (src/mcp-bridge.ts), each
  // called on its own server. Nothing here knows what they are: add a server, get its tools.
  const file = process.env.KKACHI_MCP_TOOLS;
  const tools: { server: string; url: string; name: string; description?: string; inputSchema: any; meta?: object }[] = file ? JSON.parse(readFileSync(file, "utf8")) : [];
  for (const tool of tools) {
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description ?? tool.name,
      parameters: Type.Unsafe(tool.inputSchema),
      async execute(_id, params) { return { content: await callMcp(tool.server, tool.url, tool.name, params, tool.meta), details: {} }; },
    });
  }
}

// Text and images (a device photo) pass through; an error comes back as text starting with "Error:".
type Block = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };
async function callMcp(server: string, url: string, name: string, args: unknown, meta: object = {}): Promise<Block[]> {
  try {
    const { status, body } = await mcpPost(url, { id: 1, method: "tools/call", params: { name, arguments: args, _meta: meta } });
    const { result, error } = body;
    if (result && !result.isError && Array.isArray(result.content)) return result.content;
    const out = result?.content?.map((c: any) => c.text).join("\n") ?? error?.message ?? `HTTP ${status}`;
    return [{ type: "text", text: `Error: ${out}` }];
  } catch (err) {
    return [{ type: "text", text: `Error: the ${server} service is unreachable (${(err as Error).message})` }];
  }
}
