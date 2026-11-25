// Core's calls to the memory service (services/memory): git around turns, tidying and the idle
// review. Core edits nothing through git itself. The agents' note tools reach the service as MCP
// tools, not through here.
import { INTERNAL_HEADER } from "../lib/trust";
import { load } from "./mcp-bridge";

async function call<T>(name: string, args: object = {}): Promise<T> {
  const url = load().servers.memory?.url;
  if (!url) throw new Error("no memory service in kkachi.mcp.json");
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", [INTERNAL_HEADER]: process.env.KKACHI_INTERNAL_TOKEN ?? "" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const { result, error } = (await r.json()) as any;
  const text = result?.content?.[0]?.text ?? error?.message ?? `HTTP ${r.status}`;
  if (!result || result.isError) throw new Error(`memory ${name}: ${text}`);
  return JSON.parse(text);
}

export type Kind = "change" | "tidy" | "review";
export const memory = {
  sync: () => call<{}>("git_sync"),
  setAside: () => call<{ stashed: boolean }>("git_set_aside"),
  checkpoint: (kind: Kind, summary: string) => call<{ commit: string | null; files: string[] }>("git_checkpoint", { kind, summary }),
  head: () => call<{ head: string }>("git_head").then((r) => r.head),
  changes: (since?: string) => call<{ files: string[] }>("git_changes", since ? { since } : {}).then((r) => r.files),
  staged: () => call<{ code: string; path: string }[]>("git_staged"),
  discard: () => call<{}>("git_discard"),
  draftOpen: () => call<{ path: string; base: string }>("git_draft_open"),
  draftPublish: (path: string, kind: Kind, summary: string) => call<{ commit: string | null; notes: number }>("git_draft_publish", { path, kind, summary }),
  draftClose: (path: string) => call<{}>("git_draft_close", { path }),
};
