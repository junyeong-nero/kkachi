// Guided setup: bun run init
// Checks the tools, creates the memory repo, saves settings to .env.local, then optionally starts
// Kkachi at login and makes it reachable from your phone through Tailscale Serve.
// Safe to run again: it keeps what is already set up.
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const env = process.env;
const port = env.KKACHI_PORT ?? "4300";

function run(cmd: string[], cwd?: string) {
  const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  return { ok: p.exitCode === 0, out: (p.stdout.toString() + p.stderr.toString()).trim() };
}
function must(cmd: string[], cwd?: string) {
  const r = run(cmd, cwd);
  if (!r.ok) fail(`${cmd.join(" ")} failed:\n${r.out}`);
  return r.out;
}
function fail(message: string): never {
  console.error(`\n${message}`);
  process.exit(1);
}
const ask = (question: string, fallback = "") => ((fallback ? prompt(question, fallback) : prompt(question)) ?? fallback).trim();
const yes = (question: string) => !/^n/i.test(ask(`${question} [Y/n]`, "y"));

// .env.local is gitignored. Forward slashes keep Windows paths free of escapes.
function save(key: string, value: string) {
  const file = join(root, ".env.local");
  const line = `${key}=${/\s/.test(value) ? JSON.stringify(value) : value}`;
  const lines = (existsSync(file) ? readFileSync(file, "utf8") : "").split(/\r?\n/).filter(Boolean);
  const i = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (i >= 0) lines[i] = line; else lines.push(line);
  writeFileSync(file, lines.join("\n") + "\n");
  env[key] = value;
}

console.log("Kkachi setup\n");

// 1. Tools
const missing = [
  ["git", "https://git-scm.com/downloads"],
  ["pi", "https://pi.dev (then run `pi` once to sign in to a model provider)"],
].filter(([bin]) => !Bun.which(bin));
if (missing.length) fail(`Install these first, then run \`bun run init\` again:\n${missing.map(([b, how]) => `  ${b}: ${how}`).join("\n")}`);
const tailscale = Bun.which("tailscale");
if (!tailscale) console.log("Note: Tailscale is not installed. Your phone reaches Kkachi through it: https://tailscale.com/download");

// 2. Memory repo
let memory = env.KKACHI_MEMORY_DIR;
if (memory && existsSync(join(memory, ".git"))) {
  console.log(`Memory repo: ${memory}`);
} else {
  const answer = ask("Where should Kkachi keep your notes (a new or existing git repo)?", join(homedir(), "kkachi-memory"));
  memory = resolve(answer.replace(/^~(?=$|[\\/])/, homedir())).replace(/\\/g, "/");
  if (existsSync(join(memory, ".git"))) {
    console.log("Using the existing repo.");
  } else {
    if (existsSync(memory) && readdirSync(memory).length) fail(`${memory} is not empty and not a git repo. Choose an empty folder or a git repo.`);
    cpSync(join(root, "templates", "memory"), memory, { recursive: true });
    must(["git", "init", "-b", "main"], memory);
    if (!run(["git", "config", "user.email"], memory).out) { // Kkachi commits every turn
      must(["git", "config", "user.name", ask("Name for note commits:", "Kkachi")], memory);
      must(["git", "config", "user.email", ask("Email for note commits:", "kkachi@localhost")], memory);
    }
    must(["git", "add", "-A"], memory);
    must(["git", "commit", "-q", "-m", "kkachi: start memory repo"], memory);
    console.log(`Created ${memory}. It stays on this computer. To back it up, add a private remote (git -C "${memory}" remote add origin <url> && git -C "${memory}" push -u origin main), then push yourself or set KKACHI_MEMORY_SYNC=1 in .env.local to have Kkachi push after each change.`);
  }
  save("KKACHI_MEMORY_DIR", memory);
}

// 3. Model: one that your Pi can use. Not signed in to a provider yet: sign in here (a browser opens).
const pi = env.KKACHI_PI_BIN ?? "pi";
const interactive = { stdin: "inherit", stdout: "inherit", stderr: "inherit" } as const;
const listModels = () => must([pi, "--list-models"]).split("\n").slice(1)
  .map((line) => line.trim().split(/\s+/)).filter((cols) => cols.length >= 2).map(([provider, model]) => `${provider}/${model}`);
let available = listModels();
if (!available.length) {
  console.log("Pi is not signed in to a model provider yet.");
  const provider = ask("Sign in with which? anthropic (Claude Pro/Max), openai (ChatGPT Plus/Pro), or another Pi provider:", "anthropic");
  Bun.spawnSync([pi, "auth", "login", provider], interactive);
  available = listModels();
}
if (!available.length) fail("Pi has no usable model. Run `pi auth login <provider>`, then run `bun run init` again.");
if (env.KKACHI_MODEL) {
  const first = env.KKACHI_MODEL.split(",")[0].trim();
  if (!available.includes(first)) console.log(`Warning: KKACHI_MODEL starts with ${first}, which your Pi cannot use. Edit .env.local.`);
  else console.log(`Model: ${first}`);
} else {
  available.forEach((m, i) => console.log(`  ${i + 1}. ${m}`));
  const pick = ask("Which model should Kkachi use? Number or provider/model:", "1");
  const model = available[Number(pick) - 1] ?? pick;
  if (!available.includes(model)) fail(`${model} is not in the list. Run \`bun run init\` again.`);
  save("KKACHI_MODEL", model);
}

// 4. MCP servers you already set up for Claude Code, Codex, Cursor or VS Code: pi-mcp-adapter
// imports those configs into Pi, so Kkachi's conversation can use them too (docs/philosophy.md, 1).
const piDir = env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
const findAdapter = () => {
  const bin = join(piDir, "npm", "node_modules", ".bin", process.platform === "win32" ? "pi-mcp-adapter.cmd" : "pi-mcp-adapter");
  return existsSync(bin) ? bin : Bun.which("pi-mcp-adapter");
};
let adapter = findAdapter();
if (!adapter && yes("Install pi-mcp-adapter, so Kkachi can use the MCP servers you set up for Claude Code, Codex, Cursor or VS Code?")) {
  must([pi, "install", "npm:pi-mcp-adapter"]);
  adapter = findAdapter();
}
if (adapter) {
  // --dry-run writes nothing; it names the hosts it would import from.
  const hosts = /import into the MCP adapter: (.+)/.exec(run([adapter, "init", "--dry-run"]).out)?.[1]?.trim();
  if (hosts && yes(`Use the MCP servers from ${hosts} in Kkachi too?`)) must([adapter, "init"]);
}

// 5. Speech-to-text key (Groq free tier)
if (!env.GROQ_API_KEY && !env.KKACHI_STT_API_KEY) {
  const key = ask("Groq API key for dictation (free at https://console.groq.com/keys; Enter to skip):");
  if (key) save("GROQ_API_KEY", key);
  else console.log("Skipped: you can type, but not dictate. Add GROQ_API_KEY to .env.local later.");
}

// 6. Start at login
if (yes("Start Kkachi now and whenever you log in?")) {
  const p = Bun.spawnSync([process.execPath, join(root, "scripts", "service.ts"), "install"], { stdout: "inherit", stderr: "inherit" });
  if (p.exitCode) fail("Could not set up auto-start. You can still run `bun start` yourself.");
} else {
  console.log("Run `bun start` when you want to use Kkachi.");
}

// 7. Phone access: Tailscale Serve keeps Kkachi on your tailnet (never Funnel, which is public)
if (tailscale) {
  const tailnetName = () => String(JSON.parse(run(["tailscale", "status", "--json"]).out || "{}").Self?.DNSName ?? "").replace(/\.$/, "");
  let host = tailnetName();
  if (!host && yes("Tailscale is not signed in on this computer. Sign in now? (a browser opens)")) {
    Bun.spawnSync(process.platform === "linux" ? ["sudo", "tailscale", "up"] : ["tailscale", "up"], interactive);
    host = tailnetName();
  }
  if (!host) {
    console.log("Tailscale is not connected. Sign in, then run: tailscale serve --bg --https=443 http://127.0.0.1:" + port);
  } else if (run(["tailscale", "serve", "status"]).out.includes(`127.0.0.1:${port}`)) {
    console.log(`\nOpen https://${host} on your phone (signed in to the same tailnet), then add it to the home screen. Spare devices open https://${host}/device.`);
  } else if (yes(`Make Kkachi reachable at https://${host} from devices on your tailnet?`)) {
    must(["tailscale", "serve", "--bg", "--https=443", `http://127.0.0.1:${port}`]);
    console.log(`\nOpen https://${host} on your phone (signed in to the same tailnet), then add it to the home screen. Spare devices open https://${host}/device.`);
  }
}
console.log("\nSetup done.");
