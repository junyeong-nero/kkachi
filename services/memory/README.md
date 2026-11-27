# kkachi-memory

Your notes as an agent's memory: Markdown files in a git repo you own, behind one MCP server. Any agent can list, search, read and change them; every change is one git commit, so it can be read, reverted, moved or backed up like any other repo. The notes stay on your computer unless you turn on sync.

It is part of [Kkachi](../../README.md), which starts it and commits its conversations through it, and it also runs on its own for any agent.

## Run

```sh
KKACHI_MEMORY_DIR=~/notes bun server.ts        # http://127.0.0.1:4302
```

`KKACHI_MEMORY_DIR` must be a git repo with a commit author set. Any folder of Markdown notes works; Kkachi's template (`templates/memory/` in Kkachi) adds an `AGENTS.md` with rules for folders, names and private data, which agents read before writing.

Point an agent at `http://127.0.0.1:4302/mcp` (MCP over Streamable HTTP, stateless). From another computer on your tailnet, serve it with `tailscale serve`; only this computer and `*.ts.net` names are let in.

| Tool | Does |
|---|---|
| `memory_list` | notes (path and title), optionally under one folder |
| `memory_search` | notes containing words, with the matching lines (Korean words match inside longer words) |
| `memory_read` | one note |
| `memory_write` | a new note; fails if the path exists |
| `memory_edit` | replaces one exact passage in a note |
| `memory_move` | moves or renames a note or folder and repairs links to it |
| `memory_delete` | deletes a note |
| `memory_undo` | reverts the last change made through these tools or a Kkachi turn |

Each change is committed at once as `kkachi: <summary>`, touching only its own paths. `AGENTS.md`, `README.md` and `.gitignore` cannot be changed through the tools.

## Sync

Off by default: a remote alone changes nothing. With sync on (Kkachi Home, Settings › Notes, stored as `memorySync` in `settings.json` under `KKACHI_DATA_DIR` and read on each sync) and an upstream, the service pulls before a change and pushes after it. The remote can be a private GitHub repo or a bare repo on a USB drive or NAS.

## With Kkachi core

Core passes `KKACHI_INTERNAL_TOKEN`; requests carrying it (header `x-kkachi-internal`) also see the `git_*` tools, which no other client can list or call: `git_sync`, `git_set_aside`, `git_checkpoint`, `git_head`, `git_changes`, `git_staged`, `git_discard`, `git_draft_open`, `git_draft_publish`, `git_draft_close`. Core uses them to commit a whole conversation turn as one commit, to tidy the notes (the librarian), and to review a finished conversation in a separate checkout.

A caller can also hold a change for its own commit: with `_meta: {commit: "later"}` in the call, the tool changes the files and does not commit. Kkachi's own agents edit notes as files and leave the commit to core, so one turn stays one commit.

## Settings

| Variable | Default | |
|---|---|---|
| `KKACHI_MEMORY_DIR` | | the notes repo (required) |
| `KKACHI_MEMORY_PORT` | `4302` | |
| `KKACHI_MEMORY_SYNC` | off | `1`: pull and push with the upstream, until the setting is chosen in Kkachi Home |
| `KKACHI_INTERNAL_TOKEN` | | shared with Kkachi core: the `git_*` tools |
| `KKACHI_DATA_DIR` | | where core keeps its log; without it the log goes to the console only |

## Files

`server.ts` (routes), `tools.ts` (the tools), `git.ts` (every git command, one at a time), `notes.ts` (move and delete with link repair), `log.ts`. `lib/` holds copies of Kkachi's `lib/mcp-server.ts` and `lib/trust.ts`; Kkachi's tests keep them identical until this service moves to its own repo.
