// Terms the transcript cleanup (src/polish.ts) should spell exactly, mostly English names inside
// Korean speech. Not given to Whisper itself: as a prompt it leaks into transcripts of silence.
// Sources, in priority order: the memory repo's vocabulary.md (one term per line, "- " bullets
// allowed; Kkachi extends it when the user corrects a misheard word), the titles of the user's
// notes (places and names they talk about, e.g. "삿포로"), then built-in defaults.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";

const SPECIAL = new Set(["AGENTS.md", "README.md", "vocabulary.md"]);

const DEFAULTS = [
  "GitHub", "GitHub Trending", "PR", "repo", "commit", "push", "Kkachi", "Pi", "MCP",
  "OpenRouter", "Claude", "Claude Code", "Codex", "GPT", "Gemini", "Groq", "Tailscale",
  "Bun", "TypeScript", "Python", "YouTube", "Notion", "Google Calendar", "Gmail",
];

export function vocabulary(): string[] {
  const file = join(config.memoryDir, "vocabulary.md");
  // A term is a bullet item, or a short plain line that is not a sentence or heading.
  const own = existsSync(file)
    ? readFileSync(file, "utf8").split("\n").flatMap((line) => {
        const l = line.trim();
        if (/^[-*]\s+/.test(l)) return [l.replace(/^[-*]\s+/, "")];
        return l && l.length <= 40 && !/^[#>]|^---|[.。:]$/.test(l) ? [l] : [];
      })
    : [];
  return [...new Set([...own, ...noteTitles(), ...DEFAULTS])];
}

function noteTitles(): string[] {
  const titles: string[] = [];
  for (const f of new Bun.Glob("**/*.md").scanSync({ cwd: config.memoryDir })) {
    if (SPECIAL.has(f) || f.startsWith("archive/")) continue;
    const h1 = readFileSync(join(config.memoryDir, f), "utf8").match(/^# (.+)$/m)?.[1]?.trim();
    if (h1) titles.push(h1);
  }
  return titles;
}
