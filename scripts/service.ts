// Start Kkachi when you log in and restart it if it stops: bun run service install | uninstall | status
// macOS: launchd agent. Linux: systemd user service. Windows: Startup folder entry (no admin rights needed).
// macOS and Linux services get this shell's PATH, so they find the same pi, git and edge-tts.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const logFile = join(root, "data", "service.log");
const bun = process.execPath;
const PATH = process.env.PATH ?? "";

function run(cmd: string[]) {
  const p = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
  return { ok: p.exitCode === 0, out: (p.stdout.toString() + p.stderr.toString()).trim() };
}
function must(cmd: string[]) {
  const r = run(cmd);
  if (!r.ok) throw new Error(`${cmd.join(" ")} failed: ${r.out}`);
  return r.out;
}

interface Service { install(): void; uninstall(): void; status(): string }

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const LABEL = "dev.kkachi";
const plist = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const domain = `gui/${process.getuid?.()}`;
const mac: Service = {
  install() {
    mkdirSync(join(homedir(), "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${xml(bun)}</string><string>src/server.ts</string></array>
  <key>WorkingDirectory</key><string>${xml(root)}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(PATH)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${xml(logFile)}</string>
  <key>StandardErrorPath</key><string>${xml(logFile)}</string>
</dict></plist>
`);
    run(["launchctl", "bootout", domain, plist]); // replace a running copy
    must(["launchctl", "bootstrap", domain, plist]);
  },
  uninstall() {
    run(["launchctl", "bootout", domain, plist]);
    rmSync(plist, { force: true });
  },
  status: () => run(["launchctl", "print", `${domain}/${LABEL}`]).ok ? "installed (launchd agent dev.kkachi)" : "not installed",
};

const unit = join(homedir(), ".config", "systemd", "user", "kkachi.service");
const linux: Service = {
  install() {
    mkdirSync(join(homedir(), ".config", "systemd", "user"), { recursive: true });
    writeFileSync(unit, `[Unit]
Description=Kkachi
After=network-online.target

[Service]
WorkingDirectory=${root}
ExecStart="${bun}" src/server.ts
Environment="PATH=${PATH}"
Restart=on-failure
RestartSec=5
StandardOutput=append:${logFile}
StandardError=append:${logFile}

[Install]
WantedBy=default.target
`);
    must(["systemctl", "--user", "daemon-reload"]);
    must(["systemctl", "--user", "enable", "kkachi"]);
    must(["systemctl", "--user", "restart", "kkachi"]);
    console.log("To keep Kkachi running while you are logged out (and start it at boot): sudo loginctl enable-linger $USER");
  },
  uninstall() {
    run(["systemctl", "--user", "disable", "--now", "kkachi"]);
    rmSync(unit, { force: true });
    run(["systemctl", "--user", "daemon-reload"]);
  },
  status: () => existsSync(unit) ? `installed (systemd user service kkachi: ${run(["systemctl", "--user", "is-active", "kkachi"]).out})` : "not installed",
};

// A logon task in Task Scheduler needs admin rights; the Startup folder does not. A hidden window
// runs a cmd loop that restarts the server 5 seconds after it stops.
const launcher = join(root, "data", "kkachi-service.cmd");
const startup = join(process.env.APPDATA ?? "", "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "Kkachi.vbs");
const q = (s: string) => `'${s.replace(/'/g, "''")}'`; // PowerShell single-quoted string
function stopWindows() { // the loop and everything under it (server, Pi)
  run(["powershell", "-NoProfile", "-NonInteractive", "-Command",
    `Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains(${q(launcher)}) } | ForEach-Object { taskkill /pid $_.ProcessId /t /f | Out-Null }`]);
}
const windows: Service = {
  install() {
    // Through cmd so the log captures both streams. The logon PATH already has Git for Windows (with
    // its credential manager); add only where pi and edge-tts live (~/.local/bin is often missing).
    const dirs = [...new Set(["pi", "edge-tts"].map((b) => Bun.which(b)).filter(Boolean).map((p) => dirname(p!)))];
    writeFileSync(launcher, [
      "@echo off",
      'cd /d "%~dp0.." || exit /b 2',
      `set "PATH=${[...dirs, "%PATH%"].join(";")}"`,
      'set "GCM_INTERACTIVE=Never"', // git push must never wait for a login window
      'set "GIT_TERMINAL_PROMPT=0"',
      'set "PYTHONUTF8=1"', // edge-tts prints Korean text
      ":run",
      `"${bun}" src\\server.ts >>data\\service.log 2>&1`,
      "ping -n 6 127.0.0.1 >nul", // 5 seconds; `timeout` fails without a console
      "goto run",
      "",
    ].join("\r\n"));
    // "" is a quote inside a VBScript string; 0 = hidden window. UTF-16 so any user name works.
    const vbs = `CreateObject("WScript.Shell").Run """${launcher}""", 0, False\r\n`;
    writeFileSync(startup, Buffer.from("\ufeff" + vbs, "utf16le"));
    stopWindows();
    must(["wscript.exe", startup]);
  },
  uninstall() {
    rmSync(startup, { force: true });
    stopWindows();
    rmSync(launcher, { force: true });
  },
  status: () => existsSync(startup) ? `installed (Startup folder: ${startup})` : "not installed",
};

const service = { darwin: mac, linux, win32: windows }[process.platform as string] as Service | undefined;
if (!service) throw new Error(`Auto-start is not supported on ${process.platform}. Run \`bun start\` yourself.`);

const action = process.argv[2];
if (action === "install") {
  for (const b of ["pi", "git"]) if (!Bun.which(b)) throw new Error(`${b} is not on PATH. Install it first.`);
  if (!Bun.which("edge-tts")) console.warn("warning: edge-tts is not on PATH, so the service cannot read replies aloud.");
  mkdirSync(join(root, "data"), { recursive: true });
  service.install();
  console.log(`Kkachi starts at login and is running now. Log: ${logFile}`);
} else if (action === "uninstall") {
  service.uninstall();
  console.log("Kkachi no longer starts at login.");
} else if (action === "status") {
  console.log(service.status());
} else {
  console.error("usage: bun run service install | uninstall | status");
  process.exit(2);
}
