// Who may call a Kkachi process. Core runs commands for whoever reaches it, and services act on the
// home (cameras, notes), so only Kkachi's own pages and local programs may:
// - Host must be this computer (loopback) or its Tailscale name. Tailscale Serve keeps the Host
//   header. Blocks DNS rebinding, where an attacker's domain resolves to 127.0.0.1.
// - A browser's Origin must match Host. Blocks other websites posting to 127.0.0.1.
//   Clients without Origin (curl, Pi, other agents' MCP, core's proxy) are not browsers and pass.
export function trusted(req: Request): boolean {
  const host = req.headers.get("host") ?? "";
  const hostname = host.replace(/:\d+$/, "").toLowerCase();
  if (!["127.0.0.1", "localhost", "[::1]"].includes(hostname) && !hostname.endsWith(".ts.net")) return false;
  const origin = req.headers.get("origin");
  if (!origin) return true;
  try { return new URL(origin).host === host; } catch { return false; }
}

// Core and the services it starts share a secret (KKACHI_INTERNAL_TOKEN) for calls between them,
// e.g. the devices service handing core what someone said to a device.
export const INTERNAL_HEADER = "x-kkachi-internal";
export const internal = (req: Request) => !!process.env.KKACHI_INTERNAL_TOKEN && req.headers.get(INTERNAL_HEADER) === process.env.KKACHI_INTERNAL_TOKEN;
