# AGENTS.md — memory rules

This repository is the user's long-term memory. Kkachi reads it to answer questions and edits it when the user asks to record something. Follow these rules for every change.

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

Prefer adding to an existing note over creating a new one. You may create new folders and notes without asking; tell the user the path you saved to.

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

- Read the relevant notes before answering. Cite file paths for facts taken from notes
- If the notes do not cover something, say so. Do not guess
- If the conversation summary and a note disagree, the note wins

## Editing and git

- Edit only when the user clearly asks to record, change, or remove something
- Re-read a file right before editing it
- Kkachi commits all changes from a turn as one commit after the turn ends. Keep each turn to one logical change
- To move or rename a note: create it at the new path, fix every link that pointed to the old path, and tell the user the old file still needs to be removed
