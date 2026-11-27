# Setup and everyday use

What the [README](../README.md) leaves out: updating, installing by hand, voices, running Kkachi as a service, what it does day to day, other agents, and the memory repo.

## Update

Run the install command again. It skips anything already installed and updates Kkachi.

## Install by hand

Install [Git](https://git-scm.com/downloads), [Bun](https://bun.sh), [Pi](https://pi.dev), [uv](https://docs.astral.sh/uv/) (for the voices) and [Tailscale](https://tailscale.com/download) yourself, then run the same setup:

```sh
git clone https://github.com/junyeong-nero/kkachi.git
cd kkachi
bun run init
```

`init` checks the tools before it starts. You can run it again later; it keeps what is already set up. It:

- installs Kkachi's packages (`bun install`)
- creates your memory repo, or uses an existing one
- installs the online voice (edge-tts), and asks whether Kkachi's voice is made on this computer (Supertonic, on the CPU) and whether dictation runs here too (it fetches [speech.cpp](https://github.com/nyosegawa/speech.cpp) for Qwen3-ASR into `data/speech`; fast on Apple silicon or with a small GPU, 3 to 10 s a sentence on a laptop CPU). Kkachi starts these servers itself and starts them again if they stop
- otherwise asks for a Groq API key for dictation, which you can skip and enter later in Settings › Accounts
- saves settings to `.env.local`
- starts Kkachi now and at every login
- makes it reachable on your tailnet with Tailscale Serve, signing this computer in to Tailscale first if needed

Then sign in from Kkachi Home: Settings › Accounts. Claude (Pro or Max) gives a code after you sign in, to paste back; ChatGPT (Plus or Pro) shows a code to type on OpenAI's page; OpenAI, Anthropic and OpenRouter API keys are entered there too. Kkachi keeps its accounts, MCP servers and its one package (web search) in `data/agent`, a Pi setup of its own: your own Pi in `~/.pi/agent` (its accounts, MCP servers, extensions, skills) is not used.

Add `?debug` to Kkachi Home's URL for an on-screen log.

## Voice (optional)

Typing needs nothing extra. Dictation and server-made voices are optional, and where each is made is chosen in Kkachi Home, Settings › Voice: on this computer or online. The `.env.local` settings below are only where they start.

| | Default | On your own computer |
|---|---|---|
| Dictation | [Groq](https://console.groq.com/keys) Whisper, an outside service (free key: enter it in Settings › Accounts › Groq, or add `GROQ_API_KEY` to `.env.local`) | Qwen3-ASR on [speech.cpp](https://github.com/nyosegawa/speech.cpp): 1 to 2 s a sentence with a small GPU, 3 to 10 s without. `bun scripts/speech-install.ts` fetches it (init offers to), then choose This computer under Dictation |
| Reading replies | each phone's and device's own built-in voice: nothing is sent anywhere | Supertonic 3 on the CPU: choose This computer under Voice, and Kkachi starts `scripts/supertonic-server.py` with uv |

Microsoft's neural voices (made online: Online under Voice) are there too: install [uv](https://docs.astral.sh/uv/) and run `uv tool install edge-tts`. Cleaning up transcripts with an LLM (English terms, noise; `openai/gpt-oss-120b` on the Groq key unless `KKACHI_POLISH_MODEL` says otherwise) is Tidy up dictation in the same place (Korean only; in English the transcript goes as heard). The page says when a server on this computer is not running or Groq has no key. The settings and the timings measured are in [design.md](design.md) (Korean).

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
- It can search the web, use the MCP tools added in Settings › Tools, and work on code in other repos.

### Kkachi Home's menu

The interface is in English and Korean: Settings › Appearance › Language. The language also sets dictation's language and what devices say.

The conversation is the screen. Everything else is in a menu that slides in from the left: tap the button at the top left, or swipe in from the left edge.

At its top are two tabs.

- Chats: New chat, and under it your earlier conversations. Tap one to go back to it and carry on. The conversation going on is shown again when you reopen the app.
- Devices: your spare phones and tablets. Open one to see what is happening in that room now (how loud it is, when it last moved, how it lies, where it is; a photo when you ask) and to choose what Kkachi may use there: its voice, speaker, lamp, camera, sound level, motion sensors and location. Add a device shows how to add one, with the address to copy. Waiting devices are allowed here. What is said to a device joins this conversation: that device answers aloud, it shows here too, and Kkachi has the same tools as here, your own MCP servers included.

Settings, at the bottom, is in five parts: Accounts (the model accounts, a Groq key, and your services: Google, Notion, GitHub), Appearance (language, light or dark, text size, showing thinking and tools), Voice (read-aloud, where the voice and dictation are made, tidying transcripts), Model (model and thinking) and Tools (its own servers, the ones you added, and suggestions to add).

The top bar shows whether home answers (Home: 2 on); tap it to see the devices.

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

Real lights, plugs and speakers come in through MCP servers, added in Kkachi Home under Settings › Tools. Two are suggested there:

- Home Assistant through [ha-mcp](https://github.com/homeassistant-ai/ha-mcp), for a whole house: Kkachi then switches lights, plays music on your speakers and sets up automations ("turn the living room light off at 11 every night"). Hue, Tapo, IKEA, Tuya, Matter and SmartThings devices come along once they are in Home Assistant. It asks for the ha-mcp address; setting up Home Assistant and ha-mcp is in [ha.md](ha.md) (Korean).
- LG ThinQ, LG's own server (beta), for LG appliances. It asks for a ThinQ personal access token and runs with `uvx`, so [uv](https://docs.astral.sh/uv/) must be installed on the computer.

Your own services are connected in Settings › Accounts, under Services, and Kkachi can then use them when you ask ("What's on tomorrow?", "Put the meeting notes in Notion"):

- Notion, Notion's own server: add it, then sign in to Notion and choose the pages to share.
- GitHub, GitHub's own server: a fine-grained personal access token.
- Google (Calendar, Gmail, Drive; Google's own servers, in preview): Google asks every app to bring its own OAuth client. In [Google Cloud](https://developers.google.com/workspace/guides/configure-mcp-servers), "personal mode" makes one: choose Desktop app, keep "Use this client for an AI-powered agent", and paste its client ID and secret. Each product then signs in on its own.

Signing in from the phone takes one extra step. The sign-in ends by sending the browser back to this computer (`127.0.0.1`), which the phone cannot reach, so it shows a page that does not load: copy that page's whole address and paste it into Kkachi Home, which opens it on the computer. Pi also opens the sign-in page in the computer's own browser; it can be ignored.

Any other server is added by its address (with a token if it wants one) or by the command that starts it. [extensions.md](extensions.md) (Korean) lists some, local ones first. Samsung's own SmartThings server accepts only the clients it knows, so Kkachi cannot sign in to it.

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
