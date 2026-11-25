// kkachi-devices and kkachi-memory must run from their own folders, as they will in their own repos:
// each is copied alone to a temp directory and started without core.
import { afterAll, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = join(import.meta.dir, "..");
const cleanup: (() => Promise<void> | void)[] = [];
afterAll(async () => { for (const f of cleanup.reverse()) await f(); });

/** Copy a service's folder alone (without its data) and start it with only the given settings. */
function startAlone(service: string, settings: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), `kk-${service}-`));
  cpSync(join(here, "services", service), dir, { recursive: true, filter: (p) => !/[\\/]data([\\/]|$)/.test(p.slice(dir.length)) });
  const env: Record<string, string> = { ...process.env as Record<string, string>, ...settings };
  for (const k of ["KKACHI_CORE_URL", "KKACHI_DATA_DIR", "KKACHI_INTERNAL_TOKEN", "KKACHI_MEMORY_SYNC"]) delete env[k];
  const proc = Bun.spawn([process.execPath, "server.ts"], { cwd: dir, env, stdout: "ignore", stderr: "inherit" });
  cleanup.push(async () => { proc.kill(); await proc.exited; rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });
  return dir;
}
const mcp = (base: string) => async (method: string, params: object = {}, headers: Record<string, string> = {}) =>
  (await (await fetch(`${base}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()) as any;
const up = async (url: string) => { for (let i = 0; i < 50; i++) { try { await fetch(url); return; } catch { await Bun.sleep(100); } } };
const port = () => 43000 + Math.floor(Math.random() * 2000);

test("each service's copies of lib/ are the same as Kkachi's", () => {
  for (const service of ["devices", "memory"]) {
    for (const f of ["mcp-server.ts", "trust.ts"]) {
      expect(readFileSync(join(here, "services", service, "lib", f), "utf8")).toBe(readFileSync(join(here, "lib", f), "utf8"));
    }
  }
});

// ---- kkachi-devices ----
const devicesPort = port();
const devicesBase = `http://127.0.0.1:${devicesPort}`;
const devicesDir = startAlone("devices", { KKACHI_DEVICES_PORT: String(devicesPort) });

test("devices, copied alone, runs as an MCP server with its page and icon", async () => {
  await up(`${devicesBase}/device`);
  const rpc = mcp(devicesBase);
  expect((await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } })).result.serverInfo.name).toBe("kkachi-devices");
  expect((await rpc("tools/list")).result.tools.map((t: any) => t.name)).toEqual(["list_devices", "device_speak", "device_snapshot", "device_sound_level", "device_sensors", "device_light"]);
  const page = await fetch(`${devicesBase}/device`);
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("/api/device/icon.png");
  const icon = await fetch(`${devicesBase}/api/device/icon.png`);
  expect([icon.status, icon.headers.get("content-type")]).toEqual([200, "image/png"]);
  expect(existsSync(join(devicesDir, "data"))).toBe(true); // its own state, next to it
});

test("devices on its own refuses something said to a device at once: nobody is there to hear it", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${devicesPort}/api/device/ws`);
  const inbox: any[] = [];
  ws.onmessage = (e) => inbox.push(JSON.parse(String(e.data)));
  await new Promise((r) => (ws.onopen = r));
  const next = async (type: string) => { for (let i = 0; i < 50; i++) { const m = inbox.find((x) => x.type === type); if (m) return m; await Bun.sleep(50); } throw new Error(`no ${type}`); };
  ws.send(JSON.stringify({ type: "hello", name: "테스트", armed: true, features: {}, version: "test" }));
  await next("pending");
  const { devices } = await (await fetch(`${devicesBase}/api/device/list`)).json() as any;
  await fetch(`${devicesBase}/api/device/${devices[0].id}/allow`, { method: "POST" });
  await next("ready");
  ws.send(JSON.stringify({ type: "input", id: "input-standalone-1", kind: "talk", age: 100, audio: "UklGRg==", mime: "audio/wav" }));
  expect(await next("ack")).toEqual({ type: "ack", id: "input-standalone-1", ok: false, error: "no agent" });
  ws.close();
});

// ---- kkachi-memory ----
const notes = mkdtempSync(join(tmpdir(), "kk-notes-"));
cleanup.push(() => rmSync(notes, { recursive: true, force: true, maxRetries: 5 }));
const git = (...args: string[]) => {
  const p = Bun.spawnSync(["git", "-C", notes, ...args]);
  if (p.exitCode) throw new Error(`git ${args.join(" ")}: ${p.stderr}`);
  return p.stdout.toString().trim();
};
git("init", "-q", "-b", "main"); git("config", "user.name", "t"); git("config", "user.email", "t@t");
writeFileSync(join(notes, "AGENTS.md"), "# rules\n");
git("add", "-A"); git("commit", "-qm", "seed");
const memoryPort = port();
const memoryBase = `http://127.0.0.1:${memoryPort}`;
startAlone("memory", { KKACHI_MEMORY_PORT: String(memoryPort), KKACHI_MEMORY_DIR: notes });

test("memory, copied alone, runs as an MCP server over a notes repo: each change a commit, undo reverts", async () => {
  await up(memoryBase);
  const rpc = mcp(memoryBase);
  const call = async (name: string, args: object = {}) => (await rpc("tools/call", { name, arguments: args })).result;
  expect((await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } })).result.serverInfo.name).toBe("kkachi-memory");
  expect((await rpc("tools/list")).result.tools.map((t: any) => t.name)).toEqual(
    ["memory_list", "memory_search", "memory_read", "memory_write", "memory_edit", "memory_move", "memory_delete", "memory_undo"]); // no git_* without core's token
  expect((await rpc("tools/call", { name: "git_head", arguments: {} })).error).toBeDefined();

  await call("memory_write", { path: "people/엄마.md", content: "# 엄마\n\n- 생신: 3월 14일\n", summary: "엄마 생신" });
  expect(git("log", "-1", "--format=%s")).toBe("kkachi: 엄마 생신");
  expect((await call("memory_search", { query: "생신" })).content[0].text).toContain("people/엄마.md");
  expect((await call("memory_list")).content[0].text).toContain("people/엄마.md — 엄마");

  await call("memory_undo");
  expect(git("log", "-1", "--format=%s")).toBe('kkachi: undo "엄마 생신"');
  expect(existsSync(join(notes, "people", "엄마.md"))).toBe(false);
  expect(git("status", "--porcelain")).toBe("");
});
