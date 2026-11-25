// Core's MCP connections. kkachi.mcp.json lists the MCP servers (Kkachi's own services and any
// other) and which of their tools each agent gets:
//   "servers": { "<name>": { "url": "http://…/mcp",          ${ENV} in strings is expanded
//                            "command": ["bun", "…"],         optional: core starts it (src/services.ts)
//                            "routes": ["/device"] } }       optional: paths core forwards to it
//   "agents":  { "chat": { "tools": ["devices:*"], "meta": { "commit": "later" } },
//                "port": ["memory:*", "devices:device_speak"] }   a list is just the tools
//   meta goes with every call the agent makes (params._meta), e.g. telling the memory service that
//   core commits that agent's changes at the end of its turn.
// Before a Pi starts, its tools are listed from the servers and written to a file that
// pi/kkachi.ts registers as Pi tools; calls then go straight to the server.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  const servers = Object.fromEntries(Object.entries<any>(raw.servers ?? {}).map(([name, s]) => [name, {
    url: expand(String(s.url)),
    command: Array.isArray(s.command) ? s.command.map((c: unknown) => expand(String(c))) : undefined,
    routes: Array.isArray(s.routes) ? s.routes.map(String) : [],
  }]));
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

export async function rpc(url: string, method: string, params: object = {}) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(10_000) });
  const body: any = await r.json();
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

/** The tools this agent may use, from every server that answers. Written for pi/kkachi.ts. */
export async function toolsFor(agent: Agent): Promise<{ file: string; names: string[] }> {
  const { servers, agents } = load();
  const patterns = agents[agent]?.tools ?? [], meta = agents[agent]?.meta ?? {};
  const tools: ToolDef[] = [];
  for (const [server, { url }] of Object.entries(servers)) {
    if (!patterns.some((p) => matches(p, server))) continue; // nothing wanted from this server
    try {
      await rpc(url, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "kkachi-core", version: "0.1.0" } });
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
