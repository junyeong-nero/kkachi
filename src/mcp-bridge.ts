// Core's MCP connections. kkachi.mcp.json lists the MCP servers (Kkachi's own services and any
// other) and which of their tools each agent gets:
//   "servers": { "<name>": { "url": "http://…/mcp",          ${ENV} in strings is expanded; an empty url
//                                                             (its variable unset) leaves the server out
//                            "command": ["bun", "…"],         optional: core starts it (src/services.ts)
//                            "routes": ["/device"] } }       optional: paths core forwards to it
//   "agents":  { "chat": { "tools": ["devices:*"], "meta": { "commit": "later" } },
//                "port": ["memory:*", "devices:device_speak"] }   a list is just the tools
//   meta goes with every call the agent makes (params._meta), e.g. telling the memory service that
//   core commits that agent's changes at the end of its turn.
// Before a Pi starts, its tools are listed from the servers and written to a file that
// pi/kkachi.ts registers as Pi tools; calls then go straight to the server.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { mcpPost } from "../lib/mcp-client";
import { INTERNAL_HEADER } from "../lib/trust";
import { config } from "./config";

export type Agent = "chat" | "port" | "librarian";
type ToolDef = { server: string; url: string; name: string; description?: string; inputSchema: object; meta: object };
type AgentConfig = { tools: string[]; meta: object };

const file = process.env.KKACHI_MCP_CONFIG ?? join(config.root, "kkachi.mcp.json");
const expand = (s: string) => s.replace(/\$\{(\w+)\}/g, (_, k) => (k === "KKACHI_PORT" ? String(config.port) : process.env[k] ?? ""));

export type Server = { url: string; command?: string[]; routes: string[] };
export function load(): { servers: Record<string, Server>; agents: Record<string, AgentConfig> } {
  if (!existsSync(file)) return { servers: {}, agents: {} };
  const raw = JSON.parse(readFileSync(file, "utf8"));
  const servers = Object.fromEntries(Object.entries<any>(raw.servers ?? {}).map(([name, s]): [string, Server] => [name, {
    url: expand(String(s.url)),
    command: Array.isArray(s.command) ? s.command.map((c: unknown) => expand(String(c))) : undefined,
    routes: Array.isArray(s.routes) ? s.routes.map(String) : [],
  }]).filter(([, s]) => s.url));
  const agents = Object.fromEntries(Object.entries<any>(raw.agents ?? {}).filter(([k]) => !k.startsWith("_"))
    .map(([k, a]) => [k, Array.isArray(a) ? { tools: a.map(String), meta: {} } : { tools: (a?.tools ?? []).map(String), meta: a?.meta ?? {} }]));
  return { servers, agents };
}

// "server:tool" with * as a wildcard in either part; a tool name of * matches the whole server.
const glob = (p: string, s: string) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(s);
const matches = (pattern: string, server: string, tool?: string) => {
  const [s, t = "*"] = pattern.split(":");
  return glob(s, server) && (tool === undefined || glob(t, tool));
};

/** Call a tool on one of the services as Kkachi core (with the internal token, so core-only tools
 * answer too). Returns the text result; throws on an error result. */
export async function callTool(server: string, name: string, args: object = {}): Promise<string> {
  const url = load().servers[server]?.url;
  if (!url) throw new Error(`no ${server} service in kkachi.mcp.json`);
  const { status, body } = await mcpPost(url, { id: 1, method: "tools/call", params: { name, arguments: args } }, { [INTERNAL_HEADER]: process.env.KKACHI_INTERNAL_TOKEN ?? "" });
  const { result, error } = body;
  const text = result?.content?.[0]?.text ?? error?.message ?? `HTTP ${status}`;
  if (!result || result.isError) throw new Error(`${server} ${name}: ${text}`);
  return text;
}

export async function rpc(url: string, method: string, params: object = {}) {
  const { status, body } = await mcpPost(url, { id: 1, method, params }, {}, 10_000);
  if (body.error) throw new Error(body.error.message);
  if (!body.result) throw new Error(`HTTP ${status}`);
  return body.result;
}

const INITIALIZE = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "kkachi-core", version: "0.1.0" } };

export type Connection = { name: string; source: "kkachi" | "pi"; ok?: boolean; tools?: number };
/** For Kkachi Home's list of MCP servers: each one in kkachi.mcp.json with whether it answers now and
 * how many of its tools the chat may use, then the ones in the user's own Pi setup (global config
 * files only). Pi connects to those itself when a tool is needed, so core knows only their names. */
export async function connections(): Promise<Connection[]> {
  const { servers, agents } = load();
  const patterns = agents.chat?.tools ?? [];
  const own = await Promise.all(Object.entries(servers).map(async ([name, { url }]): Promise<Connection> => {
    try {
      await rpc(url, "initialize", INITIALIZE);
      const tools = ((await rpc(url, "tools/list")).tools ?? []).filter((t: any) => patterns.some((p) => matches(p, name, t.name)));
      return { name, source: "kkachi", ok: true, tools: tools.length };
    } catch {
      return { name, source: "kkachi", ok: false };
    }
  }));
  const names = new Set<string>();
  for (const f of [join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "mcp.json"), join(homedir(), ".config", "mcp", "mcp.json")]) {
    try { for (const name of Object.keys(JSON.parse(readFileSync(f, "utf8")).mcpServers ?? {})) names.add(name); } catch {} // no such file, or not plain JSON
  }
  return [...own, ...[...names].map((name): Connection => ({ name, source: "pi" }))];
}

/** The tools this agent may use, from every server that answers. Written for pi/kkachi.ts. */
export async function toolsFor(agent: Agent): Promise<{ file: string; names: string[] }> {
  const { servers, agents } = load();
  const patterns = agents[agent]?.tools ?? [], meta = agents[agent]?.meta ?? {};
  const tools: ToolDef[] = [];
  for (const [server, { url }] of Object.entries(servers)) {
    if (!patterns.some((p) => matches(p, server))) continue; // nothing wanted from this server
    try {
      await rpc(url, "initialize", INITIALIZE);
      for (const t of (await rpc(url, "tools/list")).tools ?? []) {
        if (!patterns.some((p) => matches(p, server, t.name))) continue;
        if (tools.some((x) => x.name === t.name)) { console.error(`mcp: ${server} also has a tool named ${t.name}; skipped`); continue; }
        tools.push({ server, url, name: t.name, description: t.description, inputSchema: t.inputSchema ?? { type: "object", properties: {} }, meta });
      }
    } catch (err) {
      console.error(`mcp: ${server} (${url}) did not answer; its tools are missing for now:`, (err as Error).message);
    }
  }
  const out = join(config.dataDir, `mcp-tools-${agent}.json`);
  writeFileSync(out, JSON.stringify(tools, null, 2));
  return { file: out, names: tools.map((t) => t.name) };
}
