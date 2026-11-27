// Dictation on this computer: fetch speech.cpp (https://github.com/nyosegawa/speech.cpp), which runs
// Qwen3-ASR, for this platform into data/speech, and check it against the release's SHA256SUMS.
//   bun scripts/speech-install.ts        prints the path of the speech binary
// The models come down on its first start (src/speech-servers.ts starts it). Pinned: a newer release is
// taken by changing VERSION once it has been tried.
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const VERSION = "0.11.2";
const root = resolve(import.meta.dir, "..");
const dir = join(resolve(process.env.KKACHI_DATA_DIR ?? join(root, "data")), "speech", VERSION);
const exe = join(dir, process.platform === "win32" ? "speech.exe" : "speech");

// The build for each platform: Vulkan on Windows (it is the only one), Metal on Apple silicon, the CPU
// build on Linux (Vulkan there wants drivers that may not be installed).
const BUILD: Record<string, string> = { "win32-x64": "windows-x64-vulkan", "darwin-arm64": "macos-arm64-metal", "linux-x64": "linux-x64-cpu" };

export async function installSpeech(): Promise<string> {
  if (existsSync(exe)) return exe;
  const build = BUILD[`${process.platform}-${process.arch}`];
  if (!build) throw new Error(`speech.cpp has no build for ${process.platform}-${process.arch}: use Groq for dictation, or build it yourself`);
  const name = `speech-${VERSION}-${build}.zip`, base = `https://github.com/nyosegawa/speech.cpp/releases/download/v${VERSION}`;
  const [sums, zip] = await Promise.all([fetch(`${base}/SHA256SUMS`).then((r) => r.text()), fetch(`${base}/${name}`).then((r) => {
    if (!r.ok) throw new Error(`download ${name}: HTTP ${r.status}`);
    return r.arrayBuffer();
  })]);
  const want = sums.split("\n").find((l) => l.trim().endsWith(name))?.split(/\s+/)[0];
  const got = createHash("sha256").update(new Uint8Array(zip)).digest("hex");
  if (!want || want !== got) throw new Error(`${name} does not match its SHA256SUMS`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  await Bun.write(file, zip);
  // A zip: Windows' and macOS's own tar read it; Linux has unzip, or Python.
  const unpack = process.platform === "win32" ? [join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"), "-xf", file, "-C", dir]
    : process.platform === "darwin" ? ["tar", "-xf", file, "-C", dir]
    : Bun.which("unzip") ? ["unzip", "-oq", file, "-d", dir] : ["python3", "-m", "zipfile", "-e", file, dir];
  const p = Bun.spawnSync(unpack, { stdout: "pipe", stderr: "pipe" });
  if (p.exitCode !== 0 || !existsSync(exe)) throw new Error(`could not unpack ${name}: ${p.stderr.toString().trim()}`);
  rmSync(file);
  if (process.platform !== "win32") chmodSync(exe, 0o755);
  return exe;
}

if (import.meta.main) console.log(await installSpeech());
