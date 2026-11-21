// Entry point for the note tools in pi/kkachi.ts: bun src/tools-cli.ts <tool> '<json args>'
import { realpathSync } from "node:fs";
import { undoLast } from "./git";
import { deleteNote, moveNote } from "./notes";

const dir = realpathSync(process.env.KKACHI_MEMORY_DIR!);
const [name, raw] = process.argv.slice(2);
const args = JSON.parse(raw || "{}");

try {
  if (name === "undo_last_change") {
    const subject = await undoLast(dir);
    console.log(subject ? `Reverted the last saved change (request: "${subject}").` : "Nothing to undo: the last change was not made by Kkachi or was already undone.");
  } else if (name === "move_note") console.log(await moveNote(dir, String(args.from ?? ""), String(args.to ?? "")));
  else if (name === "delete_note") console.log(await deleteNote(dir, String(args.path ?? "")));
  else throw new Error(`unknown tool: ${name}`);
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
