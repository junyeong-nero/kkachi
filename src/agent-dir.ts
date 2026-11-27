// Kkachi's own Pi setup, in config.agentDir (data/agent unless KKACHI_AGENT_DIR says otherwise): what
// Pi keeps in ~/.pi/agent for the user's own sessions, Kkachi keeps here, so nothing of the user's
// Pi (other accounts, MCP servers brought in from Claude Code or Codex, extensions, AGENTS.md) comes
// into it. Kkachi Home sets it up: accounts (src/accounts.ts) and MCP servers (src/mcp-servers.ts).
//   auth.json      the accounts signed in to, written by src/accounts.ts
//   mcp.json       the MCP servers added in Kkachi Home (Pi's own MCP support connects them)
//   settings.json  the one package Kkachi uses (web search), written once
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { config } from "./config";

export const agentFile = (name: string) => join(config.agentDir, name);

export function ensureAgentDir() {
  const file = agentFile("settings.json");
  if (existsSync(file)) return;
  mkdirSync(config.agentDir, { recursive: true });
  const own: Record<string, unknown> = { packages: ["npm:pi-web-access"] }; // Pi installs it on first start
  // On Windows Pi runs its shell tool with Git Bash; the one the user's Pi found works here too.
  try {
    const shellPath = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "settings.json"), "utf8")).shellPath;
    if (shellPath) own.shellPath = shellPath;
  } catch {}
  writeFileSync(file, JSON.stringify(own, null, 2));
}

/** Read one of the JSON files, or {} when it is not there yet. */
export function readAgentJson(name: string): any {
  try { return JSON.parse(readFileSync(agentFile(name), "utf8")); } catch { return {}; }
}

export function writeAgentJson(name: string, value: unknown) {
  mkdirSync(config.agentDir, { recursive: true });
  writeFileSync(agentFile(name), JSON.stringify(value, null, 2));
}
