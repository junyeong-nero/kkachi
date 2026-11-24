// Kkachi's Pi extension. Loaded only in the Pi processes Kkachi starts (`pi -e pi/kkachi.ts`),
// never in the user's own Pi sessions. Conversation-control tools are signals: the Kkachi web app
// watches tool_execution_start events for them. Note tools run src/tools-cli.ts with Bun.
import { execFile } from "node:child_process";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { DEVICE_TOOLS } from "../src/device-tools";

const root = process.env.KKACHI_ROOT!;

function runCli(name: string, args: unknown): Promise<string> {
  return new Promise((resolve) => {
    execFile("bun", [join(root, "src", "tools-cli.ts"), name, JSON.stringify(args ?? {})], { cwd: root, timeout: 60_000 }, (err, stdout, stderr) => {
      resolve(err ? `Error: ${(stderr || err.message).trim()}` : stdout.trim());
    });
  });
}

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
    name: "undo_last_change",
    label: "Undo last change",
    description: "Revert the most recent change Kkachi saved to the memory repo (the previous turn), when the user asks to forget or cancel what they just said. Not for corrections; edit the note instead.",
    parameters: noArgs,
    async execute() { return text(await runCli("undo_last_change", {})); },
  });

  pi.registerTool({
    name: "tidy_notes",
    label: "Tidy notes",
    description: "Ask the librarian to reorganize the memory repo and refresh its README catalog in the background after this turn.",
    parameters: noArgs,
    async execute() { return text("The librarian will tidy the notes in the background after this turn."); },
  });

  pi.registerTool({
    name: "move_note",
    label: "Move note",
    description: "Move or rename a note file or a whole folder inside the memory repo (git mv) and repair every link to and from it. Paths are repo-relative, e.g. inbox/idea.md -> projects/trip/index.md.",
    parameters: Type.Object({ from: Type.String(), to: Type.String() }),
    async execute(_id, params) { return text(await runCli("move_note", params)); },
  });

  pi.registerTool({
    name: "delete_note",
    label: "Delete note",
    description: "Delete a note in the memory repo (git rm), only after merging its content into another note. Never AGENTS.md or README.md.",
    parameters: Type.Object({ path: Type.String() }),
    async execute(_id, params) { return text(await runCli("delete_note", params)); },
  });

  // Devices (spare phones and tablets): the same tools Kkachi serves over MCP, called through it.
  for (const tool of DEVICE_TOOLS) {
    pi.registerTool({
      name: tool.name,
      label: tool.name,
      description: tool.description,
      parameters: Type.Unsafe(tool.inputSchema),
      async execute(_id, params) { return text(await callDevices(tool.name, params)); },
    });
  }
}

async function callDevices(name: string, args: unknown): Promise<string> {
  try {
    const r = await fetch(`${process.env.KKACHI_URL}/mcp/devices`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    const { result, error } = await r.json();
    const out = result?.content?.map((c: any) => c.text).join("\n") ?? error?.message ?? `HTTP ${r.status}`;
    return result && !result.isError ? out : `Error: ${out}`;
  } catch (err) {
    return `Error: Kkachi's device service is unreachable (${(err as Error).message})`;
  }
}
