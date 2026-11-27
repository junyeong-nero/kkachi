// The accounts Kkachi's agent uses, signed in to from Kkachi Home (Settings, 계정) and kept in its own
// auth.json (src/agent-dir.ts). Two subscriptions, signed in with OAuth the way Pi does it, and API
// keys. Kkachi runs on a home server and is used from a phone, so no sign-in can come back to the
// server's own localhost: Claude gives a code to paste back, ChatGPT a code to type on OpenAI's page.
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { readAgentJson, writeAgentJson } from "./agent-dir";

type Way = "subscription" | "key";
// id is Pi's provider id: one credential each, so Claude's API key replaces its subscription.
export const ACCOUNTS: { id: string; name: string; ways: Way[]; env?: string; note: string }[] = [
  { id: "anthropic", name: "Claude", ways: ["subscription", "key"], env: "ANTHROPIC_API_KEY", note: "Claude Pro 나 Max 구독, 또는 Anthropic API 키" },
  { id: "openai-codex", name: "ChatGPT", ways: ["subscription"], note: "ChatGPT Plus 나 Pro 구독" },
  { id: "openai", name: "OpenAI API", ways: ["key"], env: "OPENAI_API_KEY", note: "OpenAI API 키" },
  { id: "openrouter", name: "OpenRouter", ways: ["key"], env: "OPENROUTER_API_KEY", note: "OpenRouter API 키. 무료 모델도 있어요" },
];
const OAUTH: Record<string, () => any> = { anthropic: () => anthropicProvider().auth.oauth, "openai-codex": () => openaiCodexProvider().auth.oauth };

export function accounts() {
  const stored = readAgentJson("auth.json");
  return ACCOUNTS.map((a) => {
    const c = stored[a.id];
    const connected = c?.type === "oauth" ? "subscription" : c?.type === "api_key" ? "key" : a.env && process.env[a.env] ? "env" : null;
    return { ...a, connected };
  });
}

function store(id: string, credential: unknown | null) {
  const auth = readAgentJson("auth.json");
  if (credential) auth[id] = credential; else delete auth[id];
  writeAgentJson("auth.json", auth);
}

export function saveKey(id: string, key: string) {
  if (!ACCOUNTS.some((a) => a.id === id && a.ways.includes("key"))) throw new Error("no such account");
  store(id, { type: "api_key", key: key.trim() });
}
export function signOut(id: string) { store(id, null); }

// ---- signing in with a subscription: one at a time. The app reads where it is (GET) until it is done.
export type Login = {
  id: string;
  step: "starting" | "open" | "code" | "device" | "done" | "error";
  url?: string;              // the sign-in page
  userCode?: string;         // ChatGPT: the code to type on its page
  error?: string;
};
let login: (Login & { answer?: (code: string) => void; abort: AbortController }) | null = null;
const view = (): Login | null => (login ? { id: login.id, step: login.step, url: login.url, userCode: login.userCode, error: login.error } : null);
export const currentLogin = view;

export function startLogin(id: string, done: () => void): Login | null {
  const oauth = OAUTH[id]?.();
  if (!oauth) throw new Error("no subscription sign-in for " + id);
  login?.abort.abort();
  const l = login = { id, step: "starting" as Login["step"], abort: new AbortController() } as NonNullable<typeof login>;
  const interaction = {
    signal: l.abort.signal,
    // The ways that work from another device: Claude's code to copy, ChatGPT's device code.
    prompt: async (p: any): Promise<string> => {
      if (p.type === "select") return (p.options.find((o: any) => /copy_code|device_code/.test(o.id)) ?? p.options[0]).id;
      if (p.type === "manual_code") {
        l.step = "code";
        return new Promise((resolve, reject) => {
          l.answer = resolve;
          const stop = () => reject(new Error("cancelled"));
          p.signal?.addEventListener("abort", stop); l.abort.signal.addEventListener("abort", stop);
        });
      }
      throw new Error(`sign-in asked for ${p.type}`);
    },
    notify: (e: any) => {
      if (e.type === "auth_url") { l.url = e.url; if (l.step === "starting") l.step = "open"; }
      if (e.type === "device_code") { l.step = "device"; l.userCode = e.userCode; l.url = e.verificationUri; }
    },
  };
  oauth.login(interaction)
    .then((credential: unknown) => { if (login !== l) return; store(id, credential); l.step = "done"; done(); })
    .catch((err: unknown) => { if (login === l && l.step !== "done") { l.step = "error"; l.error = String((err as Error)?.message ?? err).slice(0, 200); } });
  return view();
}

export function answerLogin(code: string): boolean {
  if (!login?.answer || login.step !== "code") return false;
  login.answer(code.trim());
  login.answer = undefined;
  login.step = "starting"; // exchanging the code
  return true;
}

export function cancelLogin() { login?.abort.abort(); login = null; }

/** Wait until the sign-in has something to show (a page, a code) or has ended, at most a few seconds. */
export async function loginShown(ms = 8000): Promise<Login | null> {
  const end = Date.now() + ms;
  while (login && login.step === "starting" && Date.now() < end) await Bun.sleep(100);
  return view();
}
