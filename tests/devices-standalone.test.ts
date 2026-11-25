// kkachi-devices must run from its own folder, as it will in its own repo: copied alone to a temp
// directory and started without core, it serves its page, icon and MCP tools, and refuses talk.
import { afterAll, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = join(import.meta.dir, "..");

test("the devices service's copies of lib/ are the same as Kkachi's", () => {
  for (const f of ["mcp-server.ts", "trust.ts"]) {
    expect(readFileSync(join(here, "services/devices/lib", f), "utf8")).toBe(readFileSync(join(here, "lib", f), "utf8"));
  }
});

const dir = mkdtempSync(join(tmpdir(), "kk-devices-"));
cpSync(join(here, "services/devices"), dir, { recursive: true, filter: (p) => !/[\\/]data([\\/]|$)/.test(p.slice(dir.length)) });
const port = 43000 + Math.floor(Math.random() * 1000);
const env: Record<string, string> = { ...process.env as Record<string, string>, KKACHI_DEVICES_PORT: String(port) };
for (const k of ["KKACHI_CORE_URL", "KKACHI_DATA_DIR", "KKACHI_INTERNAL_TOKEN"]) delete env[k];
const service = Bun.spawn([process.execPath, "server.ts"], { cwd: dir, env, stdout: "ignore", stderr: "inherit" });
afterAll(async () => { service.kill(); await service.exited; rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });

const base = `http://127.0.0.1:${port}`;
const rpc = async (method: string, params: object = {}) =>
  (await (await fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json() as any).result;

test("copied alone, it runs as an MCP server with its page and icon", async () => {
  for (let i = 0; i < 50; i++) { try { await fetch(`${base}/device`); break; } catch { await Bun.sleep(100); } }
  expect((await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } })).serverInfo.name).toBe("kkachi-devices");
  expect((await rpc("tools/list")).tools.map((t: any) => t.name)).toEqual(["list_devices", "device_speak", "device_snapshot", "device_sound_level", "device_sensors", "device_light"]);
  const page = await fetch(`${base}/device`);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("/api/device/icon.png");
  const icon = await fetch(`${base}/api/device/icon.png`);
  expect([icon.status, icon.headers.get("content-type")]).toEqual([200, "image/png"]);
  expect(existsSync(join(dir, "data"))).toBe(true); // its own state, next to it
});

test("on its own, something said to a device is refused at once: nobody is there to hear it", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/device/ws`);
  const inbox: any[] = [];
  ws.onmessage = (e) => inbox.push(JSON.parse(String(e.data)));
  await new Promise((r) => (ws.onopen = r));
  const next = async (type: string) => { for (let i = 0; i < 50; i++) { const m = inbox.find((x) => x.type === type); if (m) return m; await Bun.sleep(50); } throw new Error(`no ${type}`); };
  ws.send(JSON.stringify({ type: "hello", name: "테스트", armed: true, features: {}, version: "test" }));
  await next("pending");
  const { devices } = await (await fetch(`${base}/api/device/list`)).json() as any;
  await fetch(`${base}/api/device/${devices[0].id}/allow`, { method: "POST" });
  await next("ready");
  ws.send(JSON.stringify({ type: "input", id: "input-standalone-1", kind: "talk", age: 100, audio: "UklGRg==", mime: "audio/wav" }));
  expect(await next("ack")).toEqual({ type: "ack", id: "input-standalone-1", ok: false, error: "no agent" });
  ws.close();
});
