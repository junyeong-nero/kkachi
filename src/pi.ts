// Pi (https://github.com/earendil-works/pi) as Kkachi's agent runtime, over RPC mode (JSONL on
// stdin/stdout). Kkachi shares the user's Pi setup (extensions, skills, MCP, auth) and adds its
// own extension (pi/kkachi.ts) and system prompt. Every Pi command Kkachi uses lives in this file.
import { join } from "node:path";
import { config } from "./config";

export type PiEvent = { type: string; [k: string]: any };

export interface PiOptions {
  prompt: string; // file in prompts/ that replaces Pi's default (coding) system prompt
  session: "continue" | "none";
}

// Dialog requests block Pi until answered. A voice UI cannot show them, so they are cancelled.
const DIALOGS = new Set(["select", "confirm", "input", "editor"]);

export class Pi {
  private proc!: ReturnType<typeof Bun.spawn>;
  private nextId = 0;
  private pending = new Map<string, (r: any) => void>();
  private listeners = new Set<(e: PiEvent) => void>();
  exited!: Promise<number>;

  constructor(private opts: PiOptions) {}

  async start(model: string) {
    // Voice mode replaces Pi's coding prompt and the user's global AGENTS.md (its progress-update
    // and formatting rules fight a spoken reply). Extensions, skills, MCP and auth stay shared.
    // The memory repo's AGENTS.md is attached explicitly.
    const args = [
      config.piBin, "--mode", "rpc",
      "--model", model,
      "--system-prompt", await Bun.file(join(config.root, "prompts", this.opts.prompt)).text(),
      "--no-context-files",
      "--append-system-prompt", join(config.memoryDir, "AGENTS.md"),
      "-e", join(config.root, "pi", "kkachi.ts"),
      ...(this.opts.session === "continue" ? ["--session-dir", join(config.dataDir, "pi-sessions"), "--continue"] : ["--no-session"]),
    ];
    this.proc = Bun.spawn(args, {
      cwd: config.memoryDir,
      env: { ...process.env, KKACHI_ROOT: config.root, KKACHI_MEMORY_DIR: config.memoryDir },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    this.exited = this.proc.exited;
    this.readStdout();
    this.readStderr();
    await this.command({ type: "set_auto_retry", enabled: false }); // Kkachi falls back to another model instead
  }

  private async readStdout() {
    const reader = (this.proc.stdout as ReadableStream<Uint8Array>).pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, "");
        buf = buf.slice(i + 1);
        if (line.trim()) this.onRecord(JSON.parse(line));
      }
    }
  }

  private async readStderr() {
    const reader = (this.proc.stderr as ReadableStream<Uint8Array>).pipeThrough(new TextDecoderStream()).getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (process.env.KKACHI_DEBUG) process.stderr.write(`[pi] ${value}`);
    }
  }

  private onRecord(r: any) {
    if (r.type === "response" && r.id && this.pending.has(r.id)) {
      this.pending.get(r.id)!(r);
      this.pending.delete(r.id);
      return;
    }
    if (r.type === "extension_ui_request") {
      if (DIALOGS.has(r.method)) this.write({ type: "extension_ui_response", id: r.id, cancelled: true });
      return;
    }
    for (const l of this.listeners) l(r);
  }

  private write(o: unknown) {
    const stdin = this.proc.stdin as import("bun").FileSink;
    stdin.write(JSON.stringify(o) + "\n");
    stdin.flush();
  }

  command(cmd: Record<string, unknown>): Promise<any> {
    const id = `k${++this.nextId}`;
    return new Promise((resolve, reject) => {
      this.pending.set(id, (r) => (r.success ? resolve(r.data) : reject(new Error(`pi ${cmd.type}: ${r.error}`))));
      this.write({ ...cmd, id });
    });
  }

  on(listener: (e: PiEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  setModel(model: string) {
    const [provider, ...rest] = model.split("/");
    return this.command({ type: "set_model", provider, modelId: rest.join("/") });
  }

  /** Send a prompt and resolve when Pi settles (no more automatic work). */
  async run(message: string, onEvent: (e: PiEvent) => void): Promise<void> {
    let settle!: () => void;
    const settled = new Promise<void>((res) => (settle = res));
    const off = this.on((e) => { onEvent(e); if (e.type === "agent_settled") settle(); });
    try {
      const res = await this.command({ type: "prompt", message });
      if (res?.disposition === "handled") return;
      await settled;
    } finally {
      off();
    }
  }

  lastText(): Promise<string | null> {
    return this.command({ type: "get_last_assistant_text" }).then((d) => d?.text ?? null);
  }

  newSession() { return this.command({ type: "new_session" }); }

  abort() { return this.command({ type: "abort" }).catch(() => {}); }

  stop() {
    try { (this.proc.stdin as import("bun").FileSink).end(); } catch {}
    setTimeout(() => this.proc.kill(), 5000);
  }
}
