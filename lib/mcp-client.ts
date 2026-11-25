// One JSON-RPC request to an MCP server over Streamable HTTP. Kkachi's own services answer with
// JSON; others (ha-mcp and other FastMCP servers) answer with a short SSE stream whose message event
// carries the reply. Stateless servers only: no Mcp-Session-Id is kept.
export async function mcpPost(url: string, msg: { id: number; [k: string]: unknown }, headers: Record<string, string> = {}, timeoutMs?: number): Promise<{ status: number; body: any }> {
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", ...msg }),
    ...(timeoutMs && { signal: AbortSignal.timeout(timeoutMs) }),
  });
  const text = await r.text();
  if (!(r.headers.get("content-type") ?? "").includes("text/event-stream")) {
    try { return { status: r.status, body: JSON.parse(text) }; } catch { return { status: r.status, body: {} }; }
  }
  // Events are separated by a blank line; an event's data lines join with newlines.
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
    try {
      const m = JSON.parse(data);
      if (m?.id === msg.id && ("result" in m || "error" in m)) return { status: r.status, body: m };
    } catch {} // not JSON: a comment or keep-alive
  }
  return { status: r.status, body: {} };
}
