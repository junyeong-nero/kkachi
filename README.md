# Kkachi (까치)

A self-hosted, voice-only assistant for your phone. Tap once, then just talk. It remembers what you tell it in your own Markdown notes (a git repo), and it can do anything your [Pi](https://github.com/earendil-works/pi) coding agent can: search the web, use MCP servers (browser, calendar, ...), and work on code.

> **Status: early prototype.** Runs on macOS; setup is still manual. See [docs/plan.md](docs/plan.md) and [docs/design.md](docs/design.md) (Korean).

> **Warning:** Kkachi runs Pi with full access to your computer (shell, files, network) and acts without asking. Anyone who can reach it can make it run commands by voice. Expose it only through Tailscale Serve on a tailnet you control, never Tailscale Funnel or a public URL.

### Run it now (manual)

```sh
# Requirements: git, Bun, Pi (configured with an OpenRouter key), Tailscale
uv tool install edge-tts                 # TTS (free, unofficial Microsoft Edge voices)
# .env: GROQ_API_KEY=...                 # STT (Groq Whisper) and transcript cleanup (free tier)
# .env.local: KKACHI_MEMORY_DIR=/abs/path/to/memory-repo  (a git repo, see templates/memory)
bun start
tailscale serve --bg --https=8443 http://127.0.0.1:4300
```

Open the printed URL on your phone and add it to the home screen. Add `?debug` to the URL for an on-screen log.

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
- **Does things** — web search, MCP tools, code in other repos: whatever your Pi setup can do.
- **A tidy library** — after each conversation a background librarian sorts the inbox, merges duplicates, archives finished items, and rewrites the memory repo's `README.md` as a catalog you can browse on GitHub.
- **Free by default** — OpenRouter free models with automatic fallback, Groq free tier, Edge TTS. Everything is configurable (`src/config.ts`).

## Memory repo

Your notes live in a separate git repo that you own, created from `templates/memory/`. Its `AGENTS.md` tells Kkachi how to organize notes. Pushing to a private remote is optional.

Do not store secrets (ID numbers, bank accounts, passwords) in it.
