// The MCP servers added in Kkachi Home (Settings, 도구), kept in Kkachi's own mcp.json
// (src/agent-dir.ts) and connected by Pi's own MCP support, so they can be remote (a URL) or local (a
// command Pi starts). Kkachi's own services (devices, memory) are not here: they are kkachi.mcp.json's
// (src/mcp-bridge.ts) and always on. Some servers are suggested for a home, each asking only for what
// it needs; any other can be added by its address or its command.
import { config } from "./config";
import { readAgentJson, writeAgentJson } from "./agent-dir";

type Field = { key: string; label: string; placeholder?: string; secret?: boolean; value?: string };
type Choice = { key: string; label: string; on?: boolean };
// group: "home" is offered in 도구, "service" (an account of the user's) in 계정. signIn: OAuth, through
// src/mcp-login.ts after it is added. make: the servers it adds, by name (Google adds one per product).
type Suggested = {
  id: string; name: string; by: string; note: string; help: string; group: "home" | "service";
  fields: Field[]; choices?: Choice[]; signIn?: boolean; make: (v: Record<string, string>) => Record<string, object>;
};

export const SUGGESTED: Suggested[] = [
  {
    id: "home-assistant", name: "Home Assistant", by: "ha-mcp", group: "home",
    note: "집의 조명, 스피커, 센서, 자동화. Hue, Tapo, IKEA, Tuya, Matter, SmartThings 기기도 Home Assistant 에 붙이면 함께 써요.",
    help: "https://github.com/homeassistant-ai/ha-mcp",
    fields: [{ key: "url", label: "ha-mcp 주소", placeholder: "http://192.168.0.50:9583/private_…", secret: true }],
    // 77 tools: the everyday ones are declared every turn, the rest found when needed (docs/ha.md)
    make: (v) => ({ "home-assistant": {
      url: v.url, exposure: "deferred",
      toolExposure: { ha_get_overview: "direct", ha_search: "direct", ha_get_state: "direct", ha_call_service: "direct" },
      description: "Home Assistant: the home's lights, speakers, sensors and automations",
    } }),
  },
  {
    id: "lg-thinq", name: "LG ThinQ", by: "LG 공식, 베타", group: "home",
    note: "LG 가전의 상태를 보고 켜고 꺼요. 서버에 uv 가 깔려 있어야 해요.",
    help: "https://github.com/thinq-connect/pythinqconnect/blob/main/README.md#obtaining-and-using-a-personal-access-token",
    fields: [
      { key: "pat", label: "개인 액세스 토큰 (PAT)", secret: true },
      { key: "country", label: "국가 코드", placeholder: "KR", value: "KR" },
    ],
    make: (v) => ({ "lg-thinq": {
      // Pinned: the package pins an MCP library that breaks with newer pydantic, and aiohttp has no wheels
      // for the newest Python yet (checked with thinqconnect-mcp 0.0.5)
      command: "uvx", args: ["--python", "3.12", "--with", "pydantic<2.12", "thinqconnect-mcp"], env: { THINQ_PAT: v.pat, THINQ_COUNTRY: (v.country || "KR").toUpperCase() },
      exposure: "direct", description: "LG ThinQ: the state of LG appliances, and controlling them",
    } }),
  },
  {
    id: "google", name: "Google", by: "Google 공식, 미리보기", group: "service",
    note: "캘린더 일정, Gmail, 드라이브. Google Cloud 에서 만든 OAuth 클라이언트(데스크톱 앱)의 ID 와 비밀값이 필요해요.",
    help: "https://developers.google.com/workspace/guides/configure-mcp-servers",
    fields: [{ key: "clientId", label: "클라이언트 ID", placeholder: "….apps.googleusercontent.com" }, { key: "clientSecret", label: "클라이언트 보안 비밀", secret: true }],
    choices: [{ key: "calendar", label: "캘린더", on: true }, { key: "gmail", label: "Gmail", on: true }, { key: "drive", label: "드라이브" }],
    signIn: true,
    // One server per product, each signed in to on its own. A desktop-app client takes Pi's callback on
    // any 127.0.0.1 port.
    make: (v) => {
      const oauth = { clientId: v.clientId, clientSecret: v.clientSecret };
      const all: Record<string, object> = {
        "google-calendar": { url: "https://calendarmcp.googleapis.com/mcp/v1", oauth, exposure: "deferred", description: "Google Calendar: the user's calendars and events" },
        gmail: { url: "https://gmailmcp.googleapis.com/mcp/v1", oauth, exposure: "deferred", description: "Gmail: the user's mail" },
        "google-drive": { url: "https://drivemcp.googleapis.com/mcp/v1", oauth, exposure: "deferred", description: "Google Drive: the user's files" },
      };
      return Object.fromEntries(Object.entries(all).filter(([n]) => v[{ "google-calendar": "calendar", gmail: "gmail", "google-drive": "drive" }[n]!] === "on"));
    },
  },
  {
    id: "notion", name: "Notion", by: "Notion 공식", group: "service",
    note: "노션 페이지와 데이터베이스를 찾고 고쳐요. 추가한 뒤 노션에 로그인해서 쓸 페이지를 골라요.",
    help: "https://developers.notion.com/guides/mcp/get-started-with-mcp",
    fields: [], signIn: true,
    make: () => ({ notion: { url: "https://mcp.notion.com/mcp", exposure: "deferred", description: "Notion: the user's pages and databases" } }),
  },
  {
    id: "github", name: "GitHub", by: "GitHub 공식", group: "service",
    note: "저장소, 이슈, 풀 리퀘스트. GitHub 개인 액세스 토큰(fine-grained)이 필요해요.",
    help: "https://github.com/settings/personal-access-tokens/new",
    fields: [{ key: "token", label: "개인 액세스 토큰", placeholder: "github_pat_…", secret: true }],
    make: (v) => ({ github: { url: "https://api.githubcopilot.com/mcp/", headers: { Authorization: `Bearer ${v.token}` }, exposure: "deferred", description: "GitHub: the user's repositories, issues and pull requests" } }),
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
  const made = s.make(Object.fromEntries(Object.entries(values).map(([k, v]) => [k, String(v).trim()])));
  if (!Object.keys(made).length) throw new Error("하나 이상 골라 주세요");
  save({ ...servers(), ...Object.fromEntries(Object.entries(made).map(([name, entry]) => [name, { ...entry, kkachi: s.id }])) });
  return Object.keys(made);
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

/** Remove a server, or every server a suggestion added (a service signed out of), and its sign-in. */
export function removeServer(name: string) {
  const all = servers();
  const gone = all[name] ? [name] : Object.keys(all).filter((n) => all[n].kkachi === name);
  for (const n of gone) {
    delete all[n];
    Bun.spawn([config.piBin, "mcp", "logout", n], { env: { ...process.env, PI_CODING_AGENT_DIR: config.agentDir }, stdout: "ignore", stderr: "ignore" }); // with its tokens
  }
  save(all);
}
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
      name, title: suggested && Object.keys(suggested.make(ALL)).length > 1 ? `${suggested.name} ${{ "google-calendar": "캘린더", gmail: "Gmail", "google-drive": "드라이브" }[name] ?? name}` : suggested?.name ?? name,
      suggested: s.kkachi ?? null, signIn: !!suggested?.signIn, kind: s.url ? "url" : "command",
      enabled: s.enabled !== false, ...(checked!.states[name] ?? { state: s.enabled === false ? "disabled" : "unknown", tools: 0 }),
    };
  });
}

/** What Kkachi Home shows to add one: the suggestions, without how they are made. */
export const suggestions = () => SUGGESTED.map(({ make, ...s }) => ({ ...s, added: Object.values(servers()).some((x: any) => x.kkachi === s.id) }));
const ALL = new Proxy({}, { get: () => "on" }) as Record<string, string>; // every choice: how many servers a suggestion can add
