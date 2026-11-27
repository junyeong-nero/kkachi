// The MCP servers added in Kkachi Home (Settings, 도구), kept in Kkachi's own mcp.json
// (src/agent-dir.ts) and connected by Pi's own MCP support, so they can be remote (a URL) or local (a
// command Pi starts). Kkachi's own services (devices, memory) are not here: they are kkachi.mcp.json's
// (src/mcp-bridge.ts) and always on. Some servers are suggested for a home, each asking only for what
// it needs; any other can be added by its address or its command.
import { config } from "./config";
import { readAgentJson, writeAgentJson } from "./agent-dir";

type Field = { key: string; label: string; placeholder?: string; secret?: boolean; value?: string };
type Suggested = { id: string; name: string; by: string; note: string; help: string; fields: Field[]; make: (v: Record<string, string>) => object };

export const SUGGESTED: Suggested[] = [
  {
    id: "home-assistant", name: "Home Assistant", by: "ha-mcp",
    note: "집의 조명, 스피커, 센서, 자동화. Hue, Tapo, IKEA, Tuya, Matter, SmartThings 기기도 Home Assistant 에 붙이면 함께 써요.",
    help: "https://github.com/homeassistant-ai/ha-mcp",
    fields: [{ key: "url", label: "ha-mcp 주소", placeholder: "http://192.168.0.50:9583/private_…", secret: true }],
    // 77 tools: the everyday ones are declared every turn, the rest found when needed (docs/ha.md)
    make: (v) => ({
      url: v.url, exposure: "deferred",
      toolExposure: { ha_get_overview: "direct", ha_search: "direct", ha_get_state: "direct", ha_call_service: "direct" },
      description: "Home Assistant: the home's lights, speakers, sensors and automations",
    }),
  },
  {
    id: "lg-thinq", name: "LG ThinQ", by: "LG 공식, 베타",
    note: "LG 가전의 상태를 보고 켜고 꺼요. 서버에 uv 가 깔려 있어야 해요.",
    help: "https://github.com/thinq-connect/pythinqconnect/blob/main/README.md#obtaining-and-using-a-personal-access-token",
    fields: [
      { key: "pat", label: "개인 액세스 토큰 (PAT)", secret: true },
      { key: "country", label: "국가 코드", placeholder: "KR", value: "KR" },
    ],
    make: (v) => ({
      // Pinned: the package pins an MCP library that breaks with newer pydantic, and aiohttp has no wheels
      // for the newest Python yet (checked with thinqconnect-mcp 0.0.5)
      command: "uvx", args: ["--python", "3.12", "--with", "pydantic<2.12", "thinqconnect-mcp"], env: { THINQ_PAT: v.pat, THINQ_COUNTRY: (v.country || "KR").toUpperCase() },
      exposure: "direct", description: "LG ThinQ: the state of LG appliances, and controlling them",
    }),
  },
];

const NAME = /^[A-Za-z0-9_-]{1,40}$/;
const servers = (): Record<string, any> => readAgentJson("mcp.json").mcpServers ?? {};
function save(next: Record<string, any>) { writeAgentJson("mcp.json", { ...readAgentJson("mcp.json"), mcpServers: next }); }

/** Add a suggested server with the values it asked for. */
export function addSuggested(id: string, values: Record<string, string>) {
  const s = SUGGESTED.find((x) => x.id === id);
  if (!s) throw new Error("no such server");
  for (const f of s.fields) if (!f.value && !values[f.key]?.trim()) throw new Error(`${f.label} 이(가) 필요해요`);
  save({ ...servers(), [s.id]: { ...s.make(Object.fromEntries(Object.entries(values).map(([k, v]) => [k, String(v).trim()]))), kkachi: s.id } });
}

/** Add any other server: an address (with a token, if it wants one) or a command with its environment. */
export function addOwn(a: { name: string; url?: string; token?: string; command?: string; env?: string }) {
  const name = a.name.trim();
  if (!NAME.test(name)) throw new Error("이름은 영문, 숫자, -, _ 로 써 주세요");
  let entry: object;
  if (a.url?.trim()) {
    if (!/^https?:\/\//.test(a.url.trim())) throw new Error("주소는 http 나 https 로 시작해요");
    entry = { url: a.url.trim(), ...(a.token?.trim() ? { headers: { Authorization: `Bearer ${a.token.trim()}` } } : {}) };
  } else if (a.command?.trim()) {
    const [command, ...args] = a.command.trim().split(/\s+/);
    const env = Object.fromEntries((a.env ?? "").split("\n").map((l) => l.trim()).filter((l) => l.includes("=")).map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]));
    entry = { command, args, ...(Object.keys(env).length ? { env } : {}) };
  } else throw new Error("주소나 명령이 필요해요");
  save({ ...servers(), [name]: entry });
}

export function removeServer(name: string) { const all = servers(); delete all[name]; save(all); }
export function enableServer(name: string, on: boolean) {
  const all = servers();
  if (!all[name]) return;
  if (on) delete all[name].enabled; else all[name].enabled = false;
  save(all);
}

// ---- how each one is doing: Pi connects to all of them once (`pi mcp list --json`), at most every 20 s
type State = { state: string; tools: number; error?: string };
let checked: { at: number; states: Record<string, State> } | null = null;
let checking: Promise<Record<string, State>> | null = null;
async function check(): Promise<Record<string, State>> {
  const p = Bun.spawn([config.piBin, "mcp", "list", "--json"], { env: { ...process.env, PI_CODING_AGENT_DIR: config.agentDir }, stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => p.kill(), 45_000); // a command server may first be downloaded
  const out = await new Response(p.stdout).text();
  clearTimeout(timer);
  const states: Record<string, State> = {};
  try {
    for (const s of JSON.parse(out).servers ?? []) states[s.name] = { state: s.state, tools: s.tools?.length ?? 0, ...(s.error ? { error: String(s.error).slice(0, 200) } : {}) };
  } catch {}
  return states;
}
export function forget() { checked = null; }

/** The added servers, as Kkachi Home lists them. */
export async function listServers(fresh = false) {
  if (fresh || !checked || Date.now() - checked.at > 20_000) {
    checking ??= check().finally(() => (checking = null));
    checked = { at: Date.now(), states: await checking };
  }
  return Object.entries(servers()).map(([name, s]) => {
    const suggested = SUGGESTED.find((x) => x.id === s.kkachi);
    return {
      name, title: suggested?.name ?? name, kind: s.url ? "url" : "command",
      enabled: s.enabled !== false, ...(checked!.states[name] ?? { state: s.enabled === false ? "disabled" : "unknown", tools: 0 }),
    };
  });
}

/** What Kkachi Home shows to add one: the suggestions, without how they are made. */
export const suggestions = () => SUGGESTED.map(({ make, ...s }) => ({ ...s, added: !!servers()[s.id] }));
