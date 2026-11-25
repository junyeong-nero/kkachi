// The memory tools, defined once. Served over MCP at /mcp/memory (src/memory-mcp.ts adds what they
// do), and registered as Pi tools by pi/kkachi.ts for device ports. Plain data: Pi loads this file too.
const summary = { type: "string", description: "One line about the change, in the user's language; becomes the commit message" };

export const MEMORY_TOOL_DEFS = [
  {
    name: "memory_list",
    description: "List notes (path and title), optionally only under a folder such as projects or areas/health. The repo's README.md is a catalog of the notes.",
    inputSchema: { type: "object", properties: { folder: { type: "string" } } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "memory_search",
    description: "Find notes containing words (case-insensitive substrings; Korean words match inside longer words). Returns the best notes with matching lines.",
    inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "memory_read",
    description: "Read a note by its path, e.g. projects/trip/index.md.",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
    annotations: { readOnlyHint: true },
  },
  {
    name: "memory_write",
    description: "Create a new note. Fails if the path exists: use memory_edit for existing notes. Follow the folder and naming rules in the repo's AGENTS.md (memory_read AGENTS.md).",
    inputSchema: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, summary }, required: ["path", "content"] },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "memory_edit",
    description: "Change a note by replacing old_text, which must appear exactly once, with new_text. To add, include nearby text in old_text and repeat it in new_text.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" }, summary }, required: ["path", "old_text", "new_text"] },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
  {
    name: "memory_move",
    description: "Move or rename a note or folder and fix every link to and from it.",
    inputSchema: { type: "object", properties: { from: { type: "string" }, to: { type: "string" }, summary }, required: ["from", "to"] },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  {
    name: "memory_undo",
    description: "Revert the most recent change to the notes made by Kkachi or through these tools (not the librarian's tidying).",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: false, destructiveHint: true },
  },
];
