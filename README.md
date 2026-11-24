# Kkachi (까치)

A self-hosted assistant for your phone. Type or dictate (check the words, then send). Replies come back as text and can be read aloud. It remembers what you tell it in your own Markdown notes (a git repo), and it can do anything your [Pi](https://github.com/earendil-works/pi) coding agent can: search the web, use MCP servers (browser, calendar, ...), and work on code.

> **Status: early prototype.** Runs on macOS, Windows, and Linux (the Linux auto-start is untested). See [docs/plan.md](docs/plan.md) and [docs/design.md](docs/design.md) (Korean).

> **Warning:** Kkachi runs Pi with full access to your computer (shell, files, network) and acts without asking. Anyone who can reach it can make it run commands by voice. Expose it only through Tailscale Serve on a tailnet you control, never Tailscale Funnel or a public URL.

## Install

Kkachi runs on a computer that stays on (macOS, Windows, or Linux) and you use it from your phone.

1. **Install the tools** on the computer:
   - [Git](https://git-scm.com/downloads) and [Bun](https://bun.sh)
   - [Pi](https://pi.dev). Run `pi` once and sign in to a model provider with `/login`
   - [Tailscale](https://tailscale.com/download), on the computer **and** the phone, signed in to the same account
   - Optional, to hear replies: [uv](https://docs.astral.sh/uv/), then `uv tool install edge-tts` (free, unofficial Microsoft Edge voices)
   - Optional, to dictate: a free [Groq API key](https://console.groq.com/keys) (speech-to-text and transcript cleanup)
2. **Set it up:**
   ```sh
   git clone https://github.com/junyeong-nero/kkachi.git
   cd kkachi
   bun run init
   ```
   `init` checks the tools, creates your memory repo (or uses an existing one), lets you pick a model your Pi can use, saves settings to `.env.local`, starts Kkachi now and at every login, and makes it reachable on your tailnet with Tailscale Serve. Run it again any time; it keeps what is already set up.
3. **Open the printed `https://<computer>.<tailnet>.ts.net:8443` address on your phone** and add it to the home screen. Add `?debug` to the URL for an on-screen log.

Manage the background server with `bun run service status | install | uninstall`. Its log is `data/service.log`. To run in the foreground instead, use `bun start`.

- **Windows:** the server starts when you sign in (Startup folder, no admin rights needed) and stops when you sign out. Keep the computer awake: sleep stops it.
- **Linux:** a systemd user service. To keep it running while you are logged out, run `sudo loginctl enable-linger $USER`.
- **macOS:** a launchd agent that runs while you are logged in.

All settings are environment variables in `.env.local` (see `src/config.ts`), for example `KKACHI_MODEL` for the model and fallbacks, `KKACHI_PORT`, `KKACHI_TIMEZONE`, and OpenAI-compatible speech APIs instead of Groq and Edge TTS.

## How it works

```
Phone (mic/speaker) → Tailscale Serve (HTTPS) → Kkachi web app (Bun, localhost)
                                                  ├─ speech-to-text → transcript cleanup (small LLM)
                                                  ├─ Pi (RPC mode): your extensions, skills, MCP servers
                                                  ├─ text-to-speech
                                                  └─ git: commit and push the memory repo
```

- **Hands-free** — after one tap, Kkachi listens, answers out loud, and listens again. No typing, no commands: say "thanks, that's all" and it stops; say "I'll take it from the computer" and it hands off.
- **Remembers quietly** — mention a plan or decision and it is saved to the right note, without "I've noted that". Each turn is one git commit; say "forget that" to revert.
- **Answers from your notes** — questions about your life are answered from the notes, with the notes shown on screen.
- **Sees photos** — take or pick up to four photos and ask about them. They go to the model only; the memory repo records just that there were photos.
- **Speaks around the home** — open `/device` on a spare phone or tablet, name it ("거실"), tap once, and allow it in Settings → 기기. Then "거실에서 밥 먹으라고 말해줘" plays on it. Keep its screen on. Other agents can use the devices too (see below).
- **Shares with other agents** — Claude Desktop, Codex, another Pi, or anything that speaks MCP can use your devices and your memory: add `https://<computer>.<tailnet>.ts.net:8443/mcp/devices` (`list_devices`, `device_speak`) or `.../mcp/memory` (`memory_list`, `memory_search`, `memory_read`, `memory_write`, `memory_edit`, `memory_move`, `memory_undo`) to its MCP config. Each memory change is one `kkachi: …` commit, pushed, and can be undone.
- **Does things** — web search, MCP tools, code in other repos: whatever your Pi setup can do.
- **After 30 quiet minutes** — Kkachi reviews the conversation against existing notes for things it missed, such as a decision or an appointment. It commits new information as `kkachi: 대화 정리 — …` and pushes if an upstream is configured. If there is nothing to add, there is no review commit. Pending turns stay in the server's private `data/conversation.jsonl` (not the memory repo) until review succeeds, including across restarts. This does not reset your chat session.
- **A tidy library** — the librarian then sorts changed notes and refreshes the memory repo's `README.md` catalog. A new message takes priority over background work.
- **Your model, free voice** — any model your Pi can use, with automatic fallback to the next one in `KKACHI_MODEL` when it is rate-limited. Speech uses the Groq free tier and Edge TTS. Everything is configurable (`src/config.ts`).

## Memory repo

Your notes live in a separate git repo that you own, created from `templates/memory/`. Its `AGENTS.md` tells Kkachi how to organize notes. Pushing to a private remote is optional.

Already keep notes in a PARA-style folder (e.g. an Obsidian vault with `00_inbox`, `01_projects`, ...)? Import them, then let the librarian build the catalog:

```sh
bun scripts/import-notes.ts <your-notes-repo> <memory-repo> --dry-run   # preview the new paths
bun scripts/import-notes.ts <your-notes-repo> <memory-repo>             # copy, strip NN_ numbers, convert [[wikilinks]]
bun -e 'await (await import("./src/librarian")).tidyNow(); process.exit(0)'
```

Do not store secrets (ID numbers, bank accounts, passwords) in it.
