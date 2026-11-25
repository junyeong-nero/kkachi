// Core's calls to the memory service (services/memory): git around turns, tidying and the idle
// review. Core edits nothing through git itself. The agents' note tools reach the service as MCP
// tools, not through here.
import { callTool } from "./mcp-bridge";

const call = async <T>(name: string, args: object = {}): Promise<T> => JSON.parse(await callTool("memory", name, args));

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
