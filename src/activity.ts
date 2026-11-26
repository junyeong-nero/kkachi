// What the agent was used for, for the phone app's 기록 list: the turns written to data/kkachi.log
// (the phone app's and the shared session's as "turn", a device's own session as "port_turn").
export type Use = { t: string; text: string; from?: string; ms: number; tools?: number; aborted?: boolean; error?: boolean };

/** The latest turns in a piece of the log, newest first. `from` is the device that was spoken to. */
export function recentUses(logText: string, limit = 30): Use[] {
  const uses: Use[] = [];
  for (const line of logText.split("\n").reverse()) {
    if (uses.length >= limit) break;
    if (!line.includes('"event":"turn"') && !line.includes('"event":"port_turn"')) continue;
    let e: any;
    try { e = JSON.parse(line); } catch { continue; } // the first line of a slice is cut short
    const [, device, text] = String(e.text ?? "").match(/^\[([^\]]+)\] ([\s\S]*)$/) ?? []; // a device turn in the phone app's session
    uses.push({
      t: e.t, text: text ?? String(e.text ?? ""), from: e.device ?? device, ms: e.totalMs ?? 0,
      tools: typeof e.tools === "number" ? e.tools : undefined, aborted: e.aborted || undefined, error: e.error ? true : undefined,
    });
  }
  return uses;
}
