// Minimal MCP stdio server giving the agents safe actions on the memory repo. opencode starts it
// (see opencode/opencode.jsonc). The web app also watches for some of these calls in the event stream.
import { realpathSync } from "node:fs";
import { undoLast } from "./git";
import { deleteNote, moveNote } from "./notes";

const memoryDir = realpathSync(process.env.KKACHI_MEMORY_DIR!);

const TOOLS = [
  {
    name: "end_conversation",
    description: "Call when the user signals the conversation is over (thanks, bye, that's all, 됐어, 고마워). Say a short goodbye first. Kkachi then stops listening until the user taps again.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "undo_last_change",
    description: "Revert the most recent note change Kkachi committed (the previous turn's edits), when the user asks to cancel or undo what was just recorded. Do not use it to fix a detail; edit the note instead.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "tidy_notes",
    description: "Schedule the librarian to reorganize the notes and refresh the README catalog after this turn. Call when the user asks to organize or clean up the notes.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "move_note",
    description: "Move or rename a note file or a whole folder inside the memory repo (git mv). Links to and from moved notes are repaired automatically. Paths are repo-relative, e.g. inbox/idea.md -> projects/trip-2027/index.md, or projects/trip-2027 -> archive/projects/trip-2027.",
    inputSchema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"] },
  },
  {
    name: "delete_note",
    description: "Delete a note file (git rm). Only after its content has been merged into another note. Never for AGENTS.md or README.md.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
];

async function callTool(name: string, args: any = {}) {
  if (name === "tidy_notes") return "The librarian will tidy the notes in the background after this turn. Tell the user briefly.";
  if (name === "move_note") return moveNote(memoryDir, String(args.from ?? ""), String(args.to ?? ""));
  if (name === "delete_note") return deleteNote(memoryDir, String(args.path ?? ""));
  if (name === "end_conversation") return "Conversation will end after your reply.";
  if (name === "undo_last_change") {
    const subject = await undoLast(memoryDir);
    return subject ? `Reverted the last recorded change (request: "${subject}").` : "Nothing to undo: the last change was not made by Kkachi or was already undone.";
  }
  throw new Error(`unknown tool ${name}`);
}

function send(msg: unknown) { process.stdout.write(JSON.stringify(msg) + "\n"); }

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk: string) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const req = JSON.parse(line);
    if (req.id === undefined) continue; // notification
    try {
      if (req.method === "initialize") {
        send({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: req.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "kkachi", version: "0.1.0" } } });
      } else if (req.method === "tools/list") {
        send({ jsonrpc: "2.0", id: req.id, result: { tools: TOOLS } });
      } else if (req.method === "tools/call") {
        const text = await callTool(req.params.name, req.params.arguments);
        send({ jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text }] } });
      } else if (req.method === "ping") {
        send({ jsonrpc: "2.0", id: req.id, result: {} });
      } else {
        send({ jsonrpc: "2.0", id: req.id, error: { code: -32601, message: `method not found: ${req.method}` } });
      }
    } catch (err) {
      send({ jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: String((err as Error).message) }], isError: true } });
    }
  }
});
