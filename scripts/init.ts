// Guided setup: bun run init (install.sh and install.ps1 run it after installing the tools)
// Checks the tools, installs Kkachi's packages, creates the memory repo, sets up the voice and
// dictation (on this computer or online), saves settings to .env.local, then optionally starts Kkachi
// at login and makes it reachable from your phone through Tailscale Serve. Accounts and tools are
// connected afterwards, in Kkachi Home's settings.
// Safe to run again: it keeps what is already set up.
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { installSpeech } from "./speech-install";
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
const yes = (question: string, byDefault = true) => (byDefault ? !/^n/i.test(ask(`${question} [Y/n]`, "y")) : /^y/i.test(ask(`${question} [y/N]`, "n")));

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
  ["pi", "https://pi.dev"],
].filter(([bin]) => !Bun.which(bin));
if (missing.length) fail(`Install these first, then run \`bun run init\` again:\n${missing.map(([b, how]) => `  ${b}: ${how}`).join("\n")}`);
const tailscale = Bun.which("tailscale");
if (!tailscale) console.log("Note: Tailscale is not installed. Your phone reaches Kkachi through it: https://tailscale.com/download");
must([process.execPath, "install", "--frozen-lockfile"], root); // Kkachi's own packages (sign-in flows)

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

// 3. The voice and dictation: on this computer (nothing leaves the house) or online. Each can be
// changed later in Kkachi Home, 설정, 음성; these are where they start.
const interactive = { stdin: "inherit", stdout: "inherit", stderr: "inherit" } as const;
const uv = Bun.which("uv");
if (!uv) console.log("Note: uv is not installed (https://docs.astral.sh/uv/). The voice made on this computer and the online voice need it; until then each phone speaks with its own voice.");
else {
  if (!Bun.which("edge-tts") && !run([uv, "tool", "install", "edge-tts"]).ok) console.log("Could not install edge-tts (the online voice). Try: uv tool install edge-tts");
  if (!env.KKACHI_TTS_PROVIDER && yes("Make Kkachi's voice on this computer (Supertonic: about 400 MB once, runs on the CPU, no words leave the house)?")) {
    save("KKACHI_TTS_PROVIDER", "supertonic");
    save("KKACHI_TTS_VOICE", "F1");
  }
}
const appleSilicon = process.platform === "darwin" && process.arch === "arm64";
if (!env.KKACHI_STT_BASE_URL && yes(`Dictation on this computer too (Qwen3-ASR, about 1 GB once; ${appleSilicon ? "fast on this Mac" : "1 to 2 s a sentence with a small GPU, 3 to 10 s without"})?`, appleSilicon)) {
  try {
    console.log("Getting speech.cpp…");
    console.log(`speech.cpp is in ${await installSpeech()}. Kkachi starts it, and it fetches its models the first time.`);
    save("KKACHI_STT_BASE_URL", "http://127.0.0.1:8091/v1");
    save("KKACHI_STT_MODEL", "qwen3-asr-0.6b");
    save("KKACHI_STT_CHUNKING", "auto");
  } catch (err) { console.log(`${(err as Error).message}. Dictation goes to Groq instead.`); }
}
if (!env.KKACHI_STT_BASE_URL && !env.GROQ_API_KEY) {
  const key = ask("Groq API key for dictation (free at https://console.groq.com/keys; Enter to skip, or add it later in Kkachi Home, 설정, 계정):");
  if (key) save("GROQ_API_KEY", key);
  else console.log("Skipped: you can type, and add a Groq key later to dictate.");
}

// 4. Start at login
if (yes("Start Kkachi now and whenever you log in?")) {
  const p = Bun.spawnSync([process.execPath, join(root, "scripts", "service.ts"), "install"], { stdout: "inherit", stderr: "inherit" });
  if (p.exitCode) fail("Could not set up auto-start. You can still run `bun start` yourself.");
} else {
  console.log("Run `bun start` when you want to use Kkachi.");
}

// 5. Phone access: Tailscale Serve keeps Kkachi on your tailnet (never Funnel, which is public)
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
    console.log(`\nOpen https://${host} on your phone (signed in to the same tailnet), then add it to the home screen. In its menu, 설정, 계정, sign in to Claude or ChatGPT. Spare devices open https://${host}/device.`);
  } else if (yes(`Make Kkachi reachable at https://${host} from devices on your tailnet?`)) {
    must(["tailscale", "serve", "--bg", "--https=443", `http://127.0.0.1:${port}`]);
    console.log(`\nOpen https://${host} on your phone (signed in to the same tailnet), then add it to the home screen. In its menu, 설정, 계정, sign in to Claude or ChatGPT. Spare devices open https://${host}/device.`);
  }
}
console.log("\nSetup done.");
