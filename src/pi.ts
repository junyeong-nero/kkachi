// Pi (https://github.com/earendil-works/pi) as Kkachi's agent runtime, over RPC mode (JSONL on
// stdin/stdout). Kkachi shares the user's Pi setup (extensions, skills, MCP, auth) and adds its
// own extension (pi/kkachi.ts) and system prompt. Every Pi command Kkachi uses lives in this file.
import { join } from "node:path";
import { config } from "./config";
import { DEVICE_TOOLS } from "./device-tools";
import { MEMORY_TOOL_DEFS } from "./memory-tools";
import { settings } from "./settings";

export type PiEvent = { type: string; [k: string]: any };
export type PiImage = { data: string; mimeType: string }; // base64

export interface PiOptions {
  prompt: string; // file in prompts/
  // append: the user's own Pi (default prompt, global and project AGENTS.md) plus this prompt.
  // replace: this prompt instead of Pi's, with only the memory repo's AGENTS.md (background jobs).
  mode: "append" | "replace";
  session: "continue" | "none";
  reviewWorktree?: string; // isolated checkout; reviews need only the built-in note tools
  // A device someone talks to (src/port.ts): its own session, and only the memory and device tools,
  // which cannot leave the memory repo. No shell, file tools, web, subagents or MCP.
  port?: string; // device id
}

const PORT_TOOLS = [...MEMORY_TOOL_DEFS, ...DEVICE_TOOLS].map((t) => t.name).join(",");

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
    // Extensions, skills, MCP and auth are always the user's own Pi setup.
    const dir = this.opts.reviewWorktree ?? config.memoryDir;
    const prompt = join(config.root, "prompts", this.opts.prompt);
    const promptArgs = this.opts.mode === "append"
      ? ["--append-system-prompt", prompt] // cwd is the memory repo, so its AGENTS.md loads as project context
      // A path, not the text: Windows refuses multi-line arguments to pi.cmd. Pi reads either.
      : ["--system-prompt", prompt, "--no-context-files", "--append-system-prompt", join(dir, "AGENTS.md")];
    const args = [
      config.piBin, "--mode", "rpc",
      "--model", model,
      ...promptArgs,
      ...(this.opts.reviewWorktree ? ["--tools", "read,ls,find,grep,edit,write"] : ["-e", join(config.root, "pi", "kkachi.ts")]),
      ...(this.opts.port ? ["--no-mcp", "--tools", PORT_TOOLS] : []),
      ...(this.opts.session === "continue"
        ? ["--session-dir", this.opts.port ? join(config.dataDir, "pi-sessions-ports", this.opts.port) : join(config.dataDir, "pi-sessions"), "--continue"]
        : ["--no-session"]),
    ];
    this.proc = Bun.spawn(args, {
      cwd: dir,
      env: { ...process.env, KKACHI_ROOT: config.root, KKACHI_MEMORY_DIR: dir, KKACHI_URL: `http://127.0.0.1:${config.port}`, ...(this.opts.port ? { KKACHI_PORT_TOOLS: "1" } : {}) },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    this.exited = this.proc.exited;
    this.readStdout();
    this.readStderr();
    await this.command({ type: "set_auto_retry", enabled: false }); // Kkachi falls back to another model instead
    await this.setThinking();
  }

  // Spoken turns need speed more than depth. Ignored by models without reasoning levels.
  setThinking() {
    return this.command({ type: "set_thinking_level", level: settings().thinking }).catch(() => {});
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
    for (const l of this.listeners) {
      try { l(r); } catch (err) { console.error("pi event listener failed", err); } // never break the stdout loop
    }
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

  async setModel(model: string) {
    const [provider, ...rest] = model.split("/");
    await this.command({ type: "set_model", provider, modelId: rest.join("/") });
    await this.setThinking();
  }

  /** Send a prompt and resolve when Pi settles (no more automatic work). */
  async run(message: string, onEvent: (e: PiEvent) => void, images: PiImage[] = []): Promise<void> {
    let settle!: () => void;
    const settled = new Promise<void>((res) => (settle = res));
    const off = this.on((e) => { onEvent(e); if (e.type === "agent_settled") settle(); });
    try {
      const res = await this.command({ type: "prompt", message, ...(images.length ? { images: images.map((i) => ({ type: "image", ...i })) } : {}) });
      if (res?.disposition === "handled") return;
      await Promise.race([settled, this.exited]); // never hang if Pi dies mid-run
    } finally {
      off();
    }
  }

  lastText(): Promise<string | null> {
    return this.command({ type: "get_last_assistant_text" }).then((d) => d?.text ?? null);
  }

  newSession() { return this.command({ type: "new_session" }); }

  abort() { return this.command({ type: "abort" }).catch(() => {}); }

  async availableModels(): Promise<{ provider: string; id: string; name?: string }[]> {
    return (await this.command({ type: "get_available_models" }))?.models ?? [];
  }

  /** Stop an isolated worker before its scratch directory is removed, even during startup. */
  async terminate() {
    if (this.proc && this.proc.exitCode === null) this.proc.kill("SIGKILL");
    await this.exited;
  }

  stop() {
    try { (this.proc.stdin as import("bun").FileSink).end(); } catch {}
    setTimeout(() => this.proc.kill(), 5000);
  }
}
