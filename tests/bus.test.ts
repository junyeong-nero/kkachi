import { expect, test } from "bun:test";
import { INPUT_TTL_MS, type Input, makeInbox } from "../src/inbox";

const input = (id: string, age = 1000): Input => ({ id, source: { id: "dev1", name: "거실" }, kind: "talk", age, audio: "AAAA", mime: "audio/wav" });

test("an input sent again with the same id is handled once, and acked again", () => {
  const handled: string[] = [];
  const accept = makeInbox((e) => handled.push(e.id));
  expect(accept(input("input-0001"))).toEqual({ accepted: true });
  expect(accept(input("input-0001"))).toEqual({ accepted: true, duplicate: true });
  expect(accept(input("input-0002"))).toEqual({ accepted: true });
  expect(handled).toEqual(["input-0001", "input-0002"]);
});

test("an input older than its time is dropped, and not remembered as handled", () => {
  const handled: string[] = [];
  const accept = makeInbox((e) => handled.push(e.id));
  expect(accept(input("input-late", INPUT_TTL_MS + 1))).toEqual({ accepted: false, reason: "expired" });
  expect(accept(input("input-bad", -5))).toEqual({ accepted: false, reason: "expired" });
  expect(handled).toEqual([]);
});

test("ids are forgotten after ten minutes", () => {
  let now = 0;
  const handled: string[] = [];
  const accept = makeInbox((e) => handled.push(e.id), INPUT_TTL_MS, () => now);
  accept(input("input-0001"));
  now += 11 * 60_000;
  accept(input("input-0001"));
  expect(handled).toEqual(["input-0001", "input-0001"]);
});
