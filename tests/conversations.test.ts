import { expect, test } from "bun:test";
import { summaryOf, turnsOf } from "../src/conversations";

const msg = (role: string, content: unknown, extra: Record<string, unknown> = {}, t = "2026-11-27T02:31:40.000Z") =>
  JSON.stringify({ type: "message", id: Math.random().toString(36).slice(2), timestamp: t, message: { role, content, ...extra } });

const file = [
  JSON.stringify({ type: "session", version: 3, id: "s" }),
  msg("system", ""),
  msg("user", [{ type: "text", text: "[지금: 2026년 11월 27일 금요일 오전 11:31]\n오늘 날씨 어때?" }]),
  msg("assistant", [{ type: "text", text: "찾아볼게요." }, { type: "toolCall", id: "a", name: "web_search", arguments: {} }]),
  msg("toolResult", [{ type: "text", text: "..." }]),
  msg("assistant", [{ type: "text", text: "맑고 12도예요." }]),
  msg("user", [{ type: "text", text: "[지금: 2026년 11월 27일 금요일 오전 11:40] [기기: 오래된 아이폰, 개인 정보: 폰으로]\n불 꺼 줘" }], {}, "2026-11-27T02:40:00.000Z"),
  msg("assistant", [], { stopReason: "error" }),
  msg("user", [{ type: "image", data: "x", mimeType: "image/jpeg" }, { type: "text", text: "[지금: 오전 11:41]\n" }], {}, "2026-11-27T02:41:00.000Z"),
  '{"type":"message","cut sh', // a line cut short
].join("\n");

test("turns from a Pi session file: the words without Kkachi's header, the last reply, the device", () => {
  const turns = turnsOf(file);
  expect(turns).toEqual([
    { t: "2026-11-27T02:31:40.000Z", text: "오늘 날씨 어때?", photos: 0, reply: "맑고 12도예요." },
    { t: "2026-11-27T02:40:00.000Z", text: "불 꺼 줘", from: "오래된 아이폰", photos: 0, reply: "", failed: true },
    { t: "2026-11-27T02:41:00.000Z", text: "", photos: 1, reply: "" },
  ]);
  expect(summaryOf("s", turns)).toEqual({ id: "s", title: "오늘 날씨 어때?", t: "2026-11-27T02:41:00.000Z", turns: 3 });
  expect(summaryOf("e", [])).toBeNull();
});
