![Kkachi: your own assistant, on your phone and around your home](docs/banner.svg)

# Kkachi (까치)

A lightweight home assistant that remembers. It runs on the computer you already have, turns the old phones in your drawer into speakers, microphones and cameras with nothing but a web page, and keeps what you tell it in your own Markdown notes (a git repo). The agent behind it is the [Pi](https://github.com/earendil-works/pi) coding agent you already use, with your subscription, your MCP servers and your skills, so it can also search the web, use your tools and work on code.

On your phone you type or dictate (check the words, then send). Replies come back as text and can be read aloud.

> **Status: early prototype.** Runs on macOS, Windows, and Linux (the Linux auto-start is untested). See [docs/plan.md](docs/plan.md) and [docs/design.md](docs/design.md) (Korean).

> **Warning:** Kkachi runs Pi with full access to your computer (shell, files, network) and acts without asking. Anyone who can reach it can make it run commands by voice. Expose it only through Tailscale Serve on a tailnet you control, never Tailscale Funnel or a public URL.

## Principles

Home Assistant adds AI to a house; Kkachi brings the agent you already use into your home. Three rules decide what goes in ([docs/philosophy.md](docs/philosophy.md), Korean):

1. Light. One install, no VM or hub: the computer you have and the phones you no longer use. Heavier things, like Home Assistant or a local LLM, plug in when you need them.
2. Yours. Your memory is plain Markdown in your own git repo, your data stays on your computer, and backups go where you choose, only when you choose. Apart from the LLM, Kkachi itself calls no outside service. Not there yet: speech still uses Groq and Edge TTS.
3. Bring your own. Your Pi subscription, your MCP servers (imported from Claude Code, Codex, Cursor or VS Code), your skills. Pi is the one runtime; everything else is imported.

## Install

Kkachi runs on a computer that stays on (macOS, Windows, or Linux), and you use it from your phone.

1. Install the tools on the computer:
   - [Git](https://git-scm.com/downloads) and [Bun](https://bun.sh)
   - [Pi](https://pi.dev). Run `pi` once and sign in to a model provider with `/login`
   - [Tailscale](https://tailscale.com/download), on the computer **and** the phone, signed in to the same account
   - Optional, to hear replies: [uv](https://docs.astral.sh/uv/), then `uv tool install edge-tts` (free, unofficial Microsoft Edge voices)
   - Optional, to dictate: a free [Groq API key](https://console.groq.com/keys) (speech-to-text and transcript cleanup)
2. Set it up:
   ```sh
   git clone https://github.com/junyeong-nero/kkachi.git
   cd kkachi
   bun run init
   ```
   `init` checks the tools, creates your memory repo (or uses an existing one), lets you pick a model your Pi can use, saves settings to `.env.local`, starts Kkachi now and at every login, and makes it reachable on your tailnet with Tailscale Serve. You can run it again later; it keeps what is already set up.
3. Open the printed `https://<computer>.<tailnet>.ts.net` address on your phone and add it to the home screen. Add `?debug` to the URL for an on-screen log.

Manage the background server with `bun run service status | install | uninstall`. Its log is `data/service.log`. To run in the foreground instead, use `bun start`.

On Windows the server starts when you sign in (from the Startup folder, so no admin rights are needed) and stops when you sign out; sleep stops it too, so keep the computer awake. On Linux it is a systemd user service, and `sudo loginctl enable-linger $USER` keeps it running while you are logged out. On macOS it is a launchd agent that runs while you are logged in.

All settings are environment variables in `.env.local` (see `src/config.ts`), for example `KKACHI_MODEL` for the model and fallbacks, `KKACHI_PORT`, `KKACHI_TIMEZONE`, and OpenAI-compatible speech APIs instead of Groq and Edge TTS.

## How it works

```
Phone app, spare phones, other agents
  → Tailscale Serve (HTTPS, tailnet only)
  → kkachi-core (src/, :4300): the agent loop and MCP orchestration
       ├─ speech-to-text → transcript cleanup → Pi (RPC) → text-to-speech
       ├─ kkachi.mcp.json: which MCP servers, which tools each agent gets
       ├─ kkachi-devices (services/devices/, :4301): spare phones' inputs and outputs
       └─ kkachi-memory  (services/memory/, :4302): the notes and their git history
```

![How Kkachi fits together](docs/architecture-simple.svg)

Core starts the two services, restarts them if they stop, and forwards their pages from its own address. Any other MCP server can be added in `kkachi.mcp.json`. A more detailed diagram is in [docs/architecture.svg](docs/architecture.svg).

## What it does

- Type, or tap the mic and dictate into the text box to check before sending. Read-aloud is off by default and set per device. There are no commands to learn: "thanks, that's all" or "I'll take it from the computer" ends the conversation, and the librarian then tidies the notes.
- Mention a plan or decision and it goes into the right note without "I've noted that". Each turn is one git commit, and "forget that" reverts it.
- Ask about your own life and it answers from the notes, showing which notes it used.
- Take or pick up to four photos and ask about them. They go to the model only; the memory repo records just that there were photos.
- Open `/device` on a spare phone or tablet, name it ("거실"), tap once, and allow it in Settings → 기기. "거실에서 밥 먹으라고 말해줘" then plays on it. From the phone app Kkachi can also take a photo there ("거실 지금 어때?"), measure how loud it is, read its motion and orientation sensors, and turn its screen into a lamp; nothing is stored ([docs/sensors.md](docs/sensors.md)). Each input and output has an on/off switch on the device's own screen. Hold its button to ask Kkachi something. The device sends what you said and moves on; Kkachi answers there, on your phone, or both. By default a device joins your phone's conversation with the same tools, which assumes only you use these devices. Settings → 공기계 대화 can give devices a conversation of their own, limit them to the notes, speaking and the lamp, and keep private details from being said aloud ([docs/bus.md](docs/bus.md)). Keep its screen on.
- Claude Desktop, Codex, another Pi, or anything else that speaks MCP can use your devices and your memory. Add `https://<computer>.<tailnet>.ts.net/mcp/devices` (`list_devices`, `device_speak`, `device_snapshot`, `device_sound_level`, `device_sensors`, `device_light`) or `.../mcp/memory` (`memory_list`, `memory_search`, `memory_read`, `memory_write`, `memory_edit`, `memory_move`, `memory_delete`, `memory_undo`) to its MCP config. Each memory change is one `kkachi: …` commit (pushed only if sync is on) and can be undone.
- When you get real lights, speakers or cameras, plug in Home Assistant with [ha-mcp](https://github.com/homeassistant-ai/ha-mcp): Kkachi then switches lights, plays music on your speakers and sets up automations ("turn the living room light off at 11 every night"). Put the ha-mcp address in `.env.local` as `KKACHI_HA_MCP_URL`; setup steps are in [docs/ha.md](docs/ha.md) (Korean). Until then nothing about Home Assistant runs.
- It can search the web, use MCP tools, and work on code in other repos: whatever your Pi setup can do.
- After 30 quiet minutes, Kkachi checks the conversation against the notes for anything it missed, such as a decision or an appointment. New information is committed as `kkachi: 대화 정리 — …` (and pushed if sync is on, see below); if there is nothing to add, there is no commit. Turns waiting for this review stay in the server's private `data/conversation.jsonl` (not the memory repo) until it succeeds, across restarts too. Your chat session is not reset.
- A librarian then sorts the changed notes and rewrites the catalog in the memory repo's `README.md`. A new message always goes ahead of this background work.
- It works with any model your Pi can use and falls back to the next one in `KKACHI_MODEL` when one is rate-limited. Speech uses the Groq free tier and Edge TTS for now; both are outside services, and moving them local is next (see Principles). Everything is configurable (`src/config.ts`).

## Memory repo

Your notes live in a separate git repo that you own, created from `templates/memory/`. Its `AGENTS.md` tells Kkachi how to organize notes.

The notes stay on your computer: Kkachi never pushes or pulls unless you ask it to. To keep a backup, add a remote (a private GitHub repo, or a bare repo on a USB drive or NAS: `git init --bare E:/kkachi-memory.git`) and either push yourself now and then, or set `KKACHI_MEMORY_SYNC=1` in `.env.local` to have Kkachi pull before each turn and push after each commit. A remote on its own changes nothing.

If you already keep notes in a PARA-style folder (for example an Obsidian vault with `00_inbox`, `01_projects`, ...), import them and let the librarian build the catalog:

```sh
bun scripts/import-notes.ts <your-notes-repo> <memory-repo> --dry-run   # preview the new paths
bun scripts/import-notes.ts <your-notes-repo> <memory-repo>             # copy, strip NN_ numbers, convert [[wikilinks]]
bun -e 'await (await import("./src/librarian")).tidyNow(); process.exit(0)'
```

Do not store secrets (ID numbers, bank accounts, passwords) in it.
