// kkachi-devices: spare phones and tablets as one MCP service. Its own process, started by Kkachi
// core (kkachi.mcp.json), which forwards /device and /api/device/* here from the phone's address.
//   /mcp, /mcp/devices       MCP (list_devices, device_speak, device_snapshot, ...); the second for
//                            agents on other computers, through core's address
//   /device                  the page a spare phone opens
//   /api/device/ws           that page's connection
//   /api/device/list         devices for the app's settings; /api/device/<id>/allow|forget
//   what someone says to a device comes in over its WebSocket and goes to core's bus (docs/bus.md)
import { handleMcp } from "../../lib/mcp-server";
import { trusted } from "../../lib/trust";
import { allowDevice, deviceSocket, forgetDevice, listDevices, page, pageVersion } from "./devices";
import { service } from "./tools";

const port = Number(process.env.KKACHI_DEVICES_PORT ?? 4301);
const noCache = { "Cache-Control": "no-cache" };

Bun.serve({
  port,
  hostname: "127.0.0.1",
  idleTimeout: 255,
  websocket: deviceSocket,
  async fetch(req, server) {
    if (!trusted(req)) return new Response("forbidden", { status: 403 });
    const { pathname } = new URL(req.url);
    try {
      if (pathname === "/mcp" || pathname === "/mcp/devices") return await handleMcp(service, req);
      if (pathname === "/api/device/ws") return server.upgrade(req, { data: {} }) ? undefined : new Response("expected a WebSocket", { status: 400 });
      if (req.method === "GET" && pathname === "/device") {
        const html = (await Bun.file(page).text()).replace("__PAGE_VERSION__", pageVersion());
        return new Response(html, { headers: { ...noCache, "Content-Type": "text/html; charset=utf-8" } });
      }
      if (req.method === "GET" && pathname === "/api/device/list") return Response.json({ devices: listDevices() });
      const action = req.method === "POST" && pathname.match(/^\/api\/device\/(\w+)\/(allow|forget)$/);
      if (action) {
        const ok = action[2] === "allow" ? allowDevice(action[1]) : forgetDevice(action[1]);
        return ok ? Response.json({ devices: listDevices() }) : new Response("no such device", { status: 404 });
      }
    } catch (err) {
      console.error(pathname, err);
      return Response.json({ error: String((err as Error).message ?? err) }, { status: 502 });
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`kkachi-devices listening on http://127.0.0.1:${port}`);
