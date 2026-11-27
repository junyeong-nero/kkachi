# Setup and everyday use

What the [README](../README.md) leaves out: updating, installing by hand, voices, running Kkachi as a service, what it does day to day, other agents, and the memory repo.

## Update

Run the install command again. It skips anything already installed and updates Kkachi.

## Install by hand

Install [Git](https://git-scm.com/downloads), [Bun](https://bun.sh), [Pi](https://pi.dev) and [Tailscale](https://tailscale.com/download) yourself, then run the same setup:

```sh
git clone https://github.com/junyeong-nero/kkachi.git
cd kkachi
bun run init
```

`init` checks the tools before it starts. You can run it again later; it keeps what is already set up. To sign Pi in yourself first, use `pi auth login`. It:

- creates your memory repo, or uses an existing one
- signs Pi in to a model provider if it is not yet, and lets you pick a model
- offers to bring in the MCP servers you set up for Claude Code, Codex, Cursor or VS Code (through [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter))
- asks for a Groq API key for dictation, which you can skip
- saves settings to `.env.local`
- starts Kkachi now and at every login
- makes it reachable on your tailnet with Tailscale Serve, signing this computer in to Tailscale first if needed

Add `?debug` to Kkachi Home's URL for an on-screen log.

## Voice (optional)

Typing needs nothing extra. Dictation and server-made voices are optional.

| | Default | On your own computer |
|---|---|---|
| Dictation | [Groq](https://console.groq.com/keys) Whisper, an outside service (free key; the setup asks for it, or add `GROQ_API_KEY` to `.env.local`) | Qwen3-ASR on [speech.cpp](https://github.com/nyosegawa/speech.cpp): 1 to 2 s a sentence with a small GPU, 3 to 10 s without |
| Reading replies | each phone's and device's own built-in voice: nothing is sent anywhere | Supertonic 3 on the CPU: `uv run scripts/supertonic-server.py` and `KKACHI_TTS_PROVIDER=supertonic` |

Microsoft's neural voices (made online) are there too: install [uv](https://docs.astral.sh/uv/), run `uv tool install edge-tts`, and pick one in Settings. Cleaning up transcripts with an LLM (English terms, noise) is off unless you set `KKACHI_POLISH_MODEL`, for example `openai/gpt-oss-120b` on the Groq key. The settings and the timings measured are in [design.md](design.md) (Korean).

## Run and configure

Kkachi runs as a background server:

```sh
bun run service status      # or: install, uninstall
```

Its log is `data/service.log`. To run in the foreground instead, use `bun start`.

| OS | How it runs |
|---|---|
| macOS | A launchd agent that runs while you are logged in. |
| Linux | A systemd user service. `sudo loginctl enable-linger $USER` keeps it running while you are logged out. The auto-start is untested. |
| Windows | Starts when you sign in (from the Startup folder, so no admin rights are needed) and stops when you sign out. Sleep stops it too, so keep the computer awake. |

All settings are environment variables in `.env.local` (see `src/config.ts`), for example `KKACHI_MODEL` for the model and fallbacks, `KKACHI_PORT`, `KKACHI_TIMEZONE`, and the speech settings above. Kkachi works with any model your Pi can use and falls back to the next one in `KKACHI_MODEL` when one is rate-limited.

## What it does

### Talk and remember

- Type, or tap the mic and dictate into the text box to check before sending. Read-aloud is off by default and set per device.
- There are no commands to learn. Saying "thanks, that's all" or "I'll take it from the computer" ends the conversation, and the librarian then tidies the notes.
- Mention a plan or decision and it goes into the right note, without Kkachi announcing "I've noted that". Each turn is one git commit, and "forget that" reverts it.
- Ask about your own life and it answers from the notes, showing which notes it used.
- Take or pick up to four photos and ask about them. They go to the model only; the memory repo records only that there were photos.
- It can search the web, use MCP tools, and work on code in other repos: whatever your Pi setup can do.

### Kkachi Home's menu

The interface is in Korean.

The conversation is the screen. Everything else is in a menu that slides in from the left: tap the button at the top left, or swipe in from the left edge.

At its top are two tabs.

- Chat (대화): New chat (새 대화), and under it your earlier conversations. Tap one to go back to it and carry on. The conversation going on is shown again when you reopen the app.
- Devices (기기): your spare phones and tablets. Open one to see what is happening in that room now (how loud it is, when it last moved, how it lies, where it is; a photo when you ask) and to choose what Kkachi may use there: its voice, speaker, lamp, camera, sound level, motion sensors and location. 기기 추가 shows how to add one, with the address to copy. Waiting devices are allowed here. What is said to a device joins this conversation: that device answers aloud, it shows here too, and Kkachi has the same tools as here, your own MCP servers included.

Settings (설정), at the bottom, is in four parts: 외형 (light or dark, text size), 소리 (read-aloud and voice), 모델 (model and thinking) and 도구 (its MCP servers).

The top bar shows whether home answers (집, 기기 2대 켜짐); tap it to see the devices.

### Spare devices

- "Tell the living room dinner is ready" plays on it.
- From Kkachi Home, Kkachi can take a photo there ("How does the living room look?"), measure how loud it is, read its motion and orientation sensors, and turn a tablet's screen into a lamp. Nothing is stored ([sensors.md](sensors.md)).
- The device's own screen shows what is in use right now and keeps a log, so anyone in the room can see when its camera or microphone was used.
- Hold the talk pad on the device's screen to ask Kkachi something. Kkachi answers there a sentence at a time, on your phone, or both.

By default a device joins your phone's conversation with the same tools, which assumes only you use these devices. The spare-device conversation settings can give devices a conversation of their own, limit them to the notes, speaking and the lamp, and keep private details from being said aloud ([bus.md](bus.md)). The MCP servers you added to Pi stay with Kkachi Home unless you let devices use them too.

### In the background

After 30 quiet minutes, Kkachi checks the conversation against the notes for anything it missed, such as a decision or an appointment. New information is committed as a conversation-review `kkachi: …` commit (and pushed if sync is on); if there is nothing to add, there is no commit. Turns waiting for this review stay in the server's private `data/conversation.jsonl` (not the memory repo) until it succeeds, across restarts too. Your chat session is not reset.

A librarian then sorts the changed notes and rewrites the catalog in the memory repo's `README.md`. A new message always goes ahead of this background work.

## Other agents

Claude Desktop, Codex, another Pi, or anything else that speaks MCP can use your devices and your memory. Add one of these to its MCP config:

| Address | Tools |
|---|---|
| `https://<computer>.<tailnet>.ts.net/mcp/devices` | `list_devices`, `device_speak`, `device_snapshot`, `device_sound_level`, `device_sensors`, `device_light` |
| `https://<computer>.<tailnet>.ts.net/mcp/memory` | `memory_list`, `memory_search`, `memory_read`, `memory_write`, `memory_edit`, `memory_move`, `memory_delete`, `memory_undo` |

Each memory change is one `kkachi: …` commit (pushed only if sync is on) and can be undone. Both services also run by themselves ([services/devices/README.md](../services/devices/README.md), [services/memory/README.md](../services/memory/README.md)).

## Lights, speakers and Home Assistant

Real lights, plugs and speakers come in through MCP servers. [extensions.md](extensions.md) (Korean) lists ones worth adding, local ones first: for TP-Link Tapo, Philips Hue, WiZ and others. For a whole house, plug in Home Assistant with [ha-mcp](https://github.com/homeassistant-ai/ha-mcp): Kkachi then switches lights, plays music on your speakers and sets up automations ("turn the living room light off at 11 every night"). Put the ha-mcp address in `.env.local` as `KKACHI_HA_MCP_URL`; the steps are in [ha.md](ha.md) (Korean). Without that setting, nothing Home Assistant-related runs.

## Memory repo

Your notes live in a separate git repo that you own, created from `templates/memory/`. Its `AGENTS.md` tells Kkachi how to organize notes. Do not store secrets (ID numbers, bank accounts, passwords) in it.

### Backup

The notes stay on your computer: Kkachi never pushes or pulls unless you ask it to. To keep a backup:

1. Add a remote: a private GitHub repo, or a bare repo on a USB drive or NAS (`git init --bare E:/kkachi-memory.git`).
2. Push yourself now and then, or set `KKACHI_MEMORY_SYNC=1` in `.env.local` to have Kkachi pull before each turn and push after each commit.

A remote on its own changes nothing.

### Bring existing notes

```sh
bun scripts/import-notes.ts <your-notes-repo> <memory-repo> --dry-run   # preview the new paths
bun scripts/import-notes.ts <your-notes-repo> <memory-repo>             # copy, strip NN_ numbers, convert [[wikilinks]]
bun -e 'await (await import("./src/librarian")).tidyNow(); process.exit(0)'   # build the catalog
```
