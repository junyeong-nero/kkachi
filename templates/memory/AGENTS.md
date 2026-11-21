# AGENTS.md — memory rules

This repository is the user's long-term memory, kept like a library. Kkachi reads it to answer questions and edits it when the user asks to record something. After each conversation, Kkachi's librarian reorganizes it and refreshes the catalog in `README.md`, so a person browsing the repo can see at a glance what is here. Follow these rules for every change.

## Structure

```
inbox/       # captured but not yet sorted. Empty is the normal state
projects/    # things with a deadline or a clear finish line
areas/       # ongoing responsibilities with no end date (health, career, home, ...)
resources/   # reference material and finished work worth looking up later
archive/     # inactive items, moved here with their original path
```

Where does a new fact go?

1. Does it have a deadline or finish line? → `projects/<slug>/`
2. Is it an ongoing responsibility? → `areas/<slug>/`
3. Is it reference material? → `resources/<slug>/`
4. Not sure → `inbox/`, and ask the user where it belongs

Prefer adding to an existing note over creating a new one. You may create new folders and notes without asking.

Special files at the root, never moved, merged, or listed in the catalog: `AGENTS.md`, `README.md` (catalog), `vocabulary.md` (terms for speech recognition, one per line).

## Naming

- Folders and files: lowercase English kebab-case (`trip-2027/`, `plan.md`)
- Note contents use the language the user speaks
- A folder's main note is `index.md`

## Note format

Every `.md` note starts with frontmatter:

```yaml
---
created: 2026-01-31   # never change after creation
updated: 2026-01-31   # update on every content change
status: active        # active | paused | done | archived
---
```

- Decisions: write the decision, the date, and the reason in one place. Mark open questions separately from decided items
- When a decision changes, update the note and add a line under `## History` (date + summary). Do not silently rewrite past decisions
- Links: relative Markdown links (`[plan](../trip-2027/plan.md)`)

## Sensitive information

Never write these into notes: national ID numbers, passport numbers, bank or card numbers, passwords, API keys, full home addresses. Write only where to find them ("in my wallet", "see password manager").

## Answering

- Read the relevant notes before answering. Kkachi shows the notes you used on screen; do not read paths aloud
- If the notes do not cover something, say so. Do not guess
- If the conversation summary and a note disagree, the note wins

## Editing and git

- Save anything worth remembering that the user shares, without being asked and without announcing it. Skip small talk
- Re-read a file right before editing it
- Kkachi commits all changes from a turn as one commit after the turn ends. Keep each turn to one logical change
- To move, rename, or archive a note or folder use the `move_note` tool (it repairs links). After merging a note into another, remove it with `delete_note`

## Catalog (`README.md`)

`README.md` is the library catalog. Only the librarian rewrites it, as a whole, in the user's language:

```markdown
# Memory

> Organized by Kkachi. Last tidied: 2026-01-31 · 12 notes

## Projects
| Note | Summary | Status | Updated |
|---|---|---|---|
| [Trip to Jeju](projects/jeju-trip/index.md) | Mar 14-16, hotel booked, flights open | active | 2026-01-31 |

## Areas
(same table)

## Resources
(same table)

## Inbox
(same table, or "Empty")

## Archive
(same table, done or inactive items)

## Recent tidying
- 2026-01-31: moved inbox/dentist.md to areas/health/dentist.md; merged areas/gym and areas/fitness into areas/fitness
```

- One row per note. A folder with an `index.md` gets one row for the index; list its other notes only if they matter on their own
- Summary: one line, the current state (decisions, dates), not a description of the file
- Sort rows by `updated`, newest first
- "Recent tidying": newest first, keep the last 20 entries

## Tidying (librarian)

Change structure, never meaning. Do not drop, reword, or invent facts or decisions.

1. Sort every note in `inbox/` into the right place; if unsure, leave it
2. Merge notes that cover the same topic: move all content into one note (keep every fact and history line), then delete the other
3. Archive finished items: a project whose finish date has passed or whose status is `done` → set `status: done` and move it to `archive/<original path>`
4. Fix structure: frontmatter present, kebab-case names, an `index.md` for any folder with 3 or more notes, relative links that resolve
5. Rewrite `README.md` and add one "Recent tidying" line describing what moved, merged, or was archived (skip the line if nothing changed)
