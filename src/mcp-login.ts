// Signing in to an MCP server that uses OAuth (Notion, Google), from Kkachi Home on a phone. Pi does
// the sign-in (`pi mcp login`): it prints the authorization page and waits for the browser to come
// back to a callback on this computer's 127.0.0.1. A phone cannot reach that, so its browser lands on
// a page that does not load, with the whole answer in its address; the user pastes that address here,
// and Kkachi opens it on this computer, where Pi is waiting. (Pi also tries to open the page in this
// computer's own browser: nothing to do there.) One sign-in at a time.
import { config } from "./config";

export type McpLogin = { name: string; step: "starting" | "open" | "checking" | "done" | "error"; url?: string; error?: string };
let login: (McpLogin & { port?: number; proc?: ReturnType<typeof Bun.spawn> }) | null = null;
const view = (): McpLogin | null => (login ? { name: login.name, step: login.step, url: login.url, error: login.error } : null);
export const currentMcpLogin = view;

export function startMcpLogin(name: string, done: () => void) {
  cancelMcpLogin();
  const proc = Bun.spawn([config.piBin, "mcp", "login", name, "--timeout", "900"], {
    env: { ...process.env, PI_CODING_AGENT_DIR: config.agentDir }, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const l = login = { name, step: "starting" as McpLogin["step"], proc };
  let out = "";
  (async () => {
    const reader = (proc.stdout as ReadableStream<Uint8Array>).pipeThrough(new TextDecoderStream()).getReader();
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      out += value;
      const url = out.match(/https?:\/\/\S+/)?.[0];
      if (url && !l.url) {
        l.url = url; l.step = "open";
        const back = new URL(url).searchParams.get("redirect_uri") ?? "";
        l.port = Number(new URL(back || "http://x").port) || undefined;
      }
    }
  })().catch(() => {});
  proc.exited.then(async (code) => {
    if (login !== l) return;
    const err = (await new Response(proc.stderr as ReadableStream).text()).trim();
    if (code === 0) { l.step = "done"; done(); }
    else { l.step = "error"; l.error = (err.split("\n").pop() || "로그인하지 못했어요").slice(0, 200); }
  });
  return view();
}

/** The address the phone's browser was sent back to: opened here, where Pi is listening. */
export async function answerMcpLogin(pasted: string): Promise<McpLogin | null> {
  if (!login?.port || login.step !== "open") throw new Error("기다리는 로그인이 없어요");
  let back: URL;
  try { back = new URL(pasted.trim()); } catch { throw new Error("주소 전체를 붙여 넣어 주세요"); }
  if (!/^(127\.0\.0\.1|localhost|\[::1\])$/.test(back.hostname) || Number(back.port) !== login.port) throw new Error("로그인 뒤에 열린 주소가 아니에요");
  login.step = "checking";
  await fetch(`http://127.0.0.1:${login.port}${back.pathname}${back.search}`, { signal: AbortSignal.timeout(20_000) }).catch(() => {});
  const end = Date.now() + 30_000; // Pi exchanges the code and connects
  while (login?.step === "checking" && Date.now() < end) await Bun.sleep(300);
  return view();
}

export function cancelMcpLogin() {
  login?.proc?.kill();
  login = null;
}

/** Wait until there is a page to open, or it ended. */
export async function mcpLoginShown(ms = 15_000) {
  const end = Date.now() + ms;
  while (login?.step === "starting" && Date.now() < end) await Bun.sleep(100);
  return view();
}
