// MCP services still inside core: /mcp/memory (src/memory-mcp.ts). It moves to its own process in
// M9 step 3, like kkachi-devices (services/devices). Requests from other websites are refused before
// they get here (lib/trust.ts).
import type { McpService } from "../lib/mcp-server";
import { MEMORY_TOOLS } from "./memory-mcp";

export { handleMcp } from "../lib/mcp-server";

export const SERVICES: Record<string, McpService> = {
  memory: {
    name: "kkachi-memory",
    instructions: "The user's personal memory: Markdown notes in a git repo (plans, decisions, preferences, facts about their life). Search or list before writing, and add to an existing note rather than creating a near-duplicate. Every change is one git commit; memory_undo reverts the last one.",
    tools: MEMORY_TOOLS,
  },
};
