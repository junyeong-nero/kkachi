import { expect, test } from "bun:test";
import { recentUses } from "../src/activity";

const log = [
  'cut short","totalMs":1}', // a slice of the log starts mid-line
  '{"t":"2026-11-25T01:00:00.000Z","event":"turn","model":"m","text":"오늘 날씨 어때?","totalMs":6763,"tools":1,"aborted":false}',
  '{"t":"2026-11-25T01:01:00.000Z","event":"client","msg":"visibility hidden"}',
  '{"t":"2026-11-25T01:02:00.000Z","event":"turn","model":"m","text":"[거실] 불 꺼줘","totalMs":900,"tools":0,"aborted":true}',
  '{"t":"2026-11-25T01:03:00.000Z","event":"port_turn","device":"안방","text":"잘 들려?","totalMs":2089,"error":"timeout"}',
  "",
].join("\n");

test("turns from the log, newest first, with the device that was spoken to", () => {
  expect(recentUses(log)).toEqual([
    { t: "2026-11-25T01:03:00.000Z", text: "잘 들려?", from: "안방", ms: 2089, error: true },
    { t: "2026-11-25T01:02:00.000Z", text: "불 꺼줘", from: "거실", ms: 900, tools: 0, aborted: true },
    { t: "2026-11-25T01:00:00.000Z", text: "오늘 날씨 어때?", ms: 6763, tools: 1 },
  ]);
  expect(recentUses(log, 1)).toHaveLength(1);
});
