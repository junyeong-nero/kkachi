// Pi (https://github.com/earendil-works/pi) as Kkachi's agent runtime, over RPC mode (JSONL on
// stdin/stdout). Kkachi has a Pi setup of its own (config.agentDir: its accounts, MCP servers and the
// web search package, src/agent-dir.ts), not the user's, and adds its extension (pi/kkachi.ts) and
// system prompt. Every Pi command Kkachi uses lives in this file.
import { join } from "node:path";
import { ensureAgentDir } from "./agent-dir";
import { config } from "./config";
import { type Agent, toolsFor } from "./mcp-bridge";
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
  mcp?: Agent; // which MCP tools it gets from kkachi.mcp.json (src/mcp-bridge.ts), as which agent
}

// Dialog requests block Pi until answered. A voice UI cannot show them, so they are cancelled.
const DIALOGS = new Set(["select", "confirm", "input", "editor"]);

export class Pi {
  private proc!: ReturnType<typeof Bun.spawn>;
  private nextId = 0;
  private pending = new Map<string, (r: any) => void>();
  private listeners = new Set<(e: PiEvent) => void>();
  // Exists from the start: callers watch it before start() has spawned anything (it awaits the MCP tools first).
  private exit!: (code: number) => void;
  readonly exited = new Promise<number>((resolve) => (this.exit = resolve));
  private stopped = false;

  constructor(private opts: PiOptions) {}

  async start(model: string) {
    ensureAgentDir();
    const dir = this.opts.reviewWorktree ?? config.memoryDir;
    const mcp = this.opts.mcp ? await toolsFor(this.opts.mcp) : null;
    const prompt = join(config.root, "prompts", this.opts.prompt);
    const promptArgs = this.opts.mode === "append"
      ? ["--append-system-prompt", prompt] // cwd is the memory repo, so its AGENTS.md loads as project context
      // A path, not the text: Windows refuses multi-line arguments to pi.cmd. Pi reads either.
      : ["--system-prompt", prompt, "--no-context-files", "--append-system-prompt", join(dir, "AGENTS.md")];
    const args = [
      config.piBin, "--mode", "rpc",
      "--no-skills", // the user's skills (~/.agents/skills) are not Kkachi's
      ...(this.opts.mcp === "chat" ? [] : ["--no-mcp"]), // the servers added in Kkachi Home are for the conversation
      "--model", model,
      ...promptArgs,
      ...(this.opts.reviewWorktree ? ["--tools", "read,ls,find,grep,edit,write"] : ["-e", join(config.root, "pi", "kkachi.ts")]),
      ...(this.opts.session === "continue"
        ? ["--session-dir", join(config.dataDir, "pi-sessions"), "--continue"]
        : ["--no-session"]),
    ];
    if (this.stopped) throw new Error("pi was stopped before it started");
    this.proc = Bun.spawn(args, {
      cwd: dir,
      env: { ...process.env, PI_CODING_AGENT_DIR: config.agentDir, KKACHI_ROOT: config.root, KKACHI_DATA_DIR: config.dataDir, KKACHI_MEMORY_DIR: dir, KKACHI_URL: `http://127.0.0.1:${config.port}`, ...(mcp ? { KKACHI_MCP_TOOLS: mcp.file } : {}) },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    this.proc.exited.then((code) => this.exit(code));
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

  /** The session file Pi writes to now (it may not exist until the first message). */
  sessionFile(): Promise<string | null> { return this.command({ type: "get_state" }).then((d) => d?.sessionFile ?? null); }

  switchSession(sessionPath: string) { return this.command({ type: "switch_session", sessionPath }); }

  abort() { return this.command({ type: "abort" }).catch(() => {}); }

  async availableModels(): Promise<{ provider: string; id: string; name?: string }[]> {
    return (await this.command({ type: "get_available_models" }))?.models ?? [];
  }

  /** Stop an isolated worker before its scratch directory is removed, even during startup. */
  async terminate() {
    this.stopped = true;
    if (!this.proc) { this.exit(-1); return; } // not spawned yet: start() will not spawn it now
    if (this.proc.exitCode === null) this.proc.kill("SIGKILL");
    await this.exited;
  }

  stop() {
    this.stopped = true;
    if (!this.proc) { this.exit(-1); return; }
    try { (this.proc.stdin as import("bun").FileSink).end(); } catch {}
    setTimeout(() => this.proc.kill(), 5000);
  }
}
