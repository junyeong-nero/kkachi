# Kkachi (까치)

A self-hosted, voice-only personal assistant for your phone. Tap once, then just talk. It answers from your own Markdown notes and keeps them up to date, like a coding agent working on a git repo.

> **Status: early prototype.** The voice loop runs on macOS; setup is still manual. See [docs/plan.md](docs/plan.md) and [docs/design.md](docs/design.md) (Korean).

### Run it now (manual)

```sh
uv tool install edge-tts                 # TTS (free, unofficial Microsoft Edge voices)
# .env: GROQ_API_KEY=...                 # STT (free Groq Whisper)
# .env.local: KKACHI_MEMORY_DIR=/abs/path/to/memory-repo  (a git repo, see templates/memory)
bun start                                # needs `opencode` (@opencode/cli 2.3.x) on PATH
tailscale serve --bg --https=8443 http://127.0.0.1:4300
```

Add `?debug` to the URL for an on-screen log.

## How it works

```
Phone (mic/speaker) → Tailscale Serve (HTTPS) → Kkachi web app (Bun, localhost) → opencode serve → your memory repo + model API
                                                      ↳ speech-to-text / text-to-speech APIs
```

- **Hands-free** — after one tap, Kkachi listens, answers out loud, and listens again. No typing.
- **One conversation, two jobs** — ask questions and record decisions in the same chat. Close the page and pick up where you left off.
- **Answers with sources** — Kkachi reads only the notes it needs, cites file paths, and says so when your notes don't cover something.
- **Notes as git commits** — when you ask it to record something, it edits your memory repo and commits (and pushes, if you set a remote). Say "undo" to revert.
- **Your machine, your keys** — runs on your own computer. API keys stay on the server. Only devices on your tailnet can reach it (use Tailscale Serve, never Funnel).

## Planned setup

```sh
git clone https://github.com/junyeong-nero/kkachi && cd kkachi
bun install
bunx opencode auth login   # register your model provider key (e.g. OpenRouter)
bun run init               # choose memory repo, model, and speech providers
bun start
tailscale serve --bg 4300  # open the printed URL on your phone, add to home screen
```

Requirements: git, [Bun](https://bun.sh), [Tailscale](https://tailscale.com). macOS and Linux first; Windows later.

## Memory repo

Your notes live in a separate git repo that you own. `bun run init` creates one from `templates/memory/` with an `AGENTS.md` that tells Kkachi how to organize notes. Pushing to a private remote is optional.

Do not store secrets (ID numbers, bank accounts, passwords) in it.
