import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeRouter } from "../src/router";

const dir = mkdtempSync(join(tmpdir(), "kkachi-router-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const knob = { id: "knob", name: "주방" }, other = { id: "other", name: "침실" };
const pair = { from: { device: "knob", kind: "dial" }, to: { device: "lamp", output: "light" } };
const sent = (n: number, failed = 0) => ({ sent: n, failed });

test("a dial's value goes to every lamp joined to it, and to nothing when unjoined", async () => {
  const got: [string, number][] = [];
  const router = makeRouter(join(dir, "a.json"), async (link, value) => { got.push([link.to.device, value]); });
  expect(await router.dispatch(knob, "dial", 40)).toEqual(sent(0));
  const link = router.add(pair)!;
  expect(router.add(pair)).toEqual(link); // the same pair twice is one link
  router.add({ from: pair.from, to: { device: "lamp2", output: "light" } }); // one input, two outputs
  expect(await router.dispatch(knob, "dial", 140.4)).toEqual(sent(2)); // kept within 0 to 100
  expect(await router.dispatch(other, "dial", 10)).toEqual(sent(0));
  expect(got.sort()).toEqual([["lamp", 100], ["lamp2", 100]]);
  expect(router.list()[0].last?.value).toBe(100);
  expect(router.joined()).toEqual({ knob: ["dial"] });
  expect(router.set(link.id, false)).toBe(true); // switched off: kept, but its values go nowhere
  expect(await router.dispatch(knob, "dial", 20)).toEqual(sent(1));
  router.set(link.id, true);
  expect(router.remove(link.id)).toBe(true);
  expect(await router.dispatch(knob, "dial", 5)).toEqual(sent(1));
});

test("links survive a restart; what cannot be joined is refused; links to the agent from before are dropped", () => {
  const file = join(dir, "b.json");
  const link = makeRouter(file, async () => {}).add(pair)!;
  expect(makeRouter(file, async () => {}).list()).toEqual([{ ...link, last: undefined }]);
  expect(makeRouter(file, async () => {}).set("nothing", false)).toBe(false);
  const router = makeRouter(join(dir, "c.json"), async () => {});
  expect(router.add({ from: { device: "knob", kind: "photo" }, to: pair.to })).toBeNull();
  expect(router.add({ from: pair.from, to: { device: "../x", output: "light" } })).toBeNull();
  expect(router.add({ from: pair.from, to: { agent: true } })).toBeNull(); // the agent is not a link: see the devices service
  expect(router.add({ from: pair.from, to: { device: "lamp", output: "speak" } })).toBeNull();
  writeFileSync(join(dir, "old.json"), JSON.stringify([{ id: "x1", from: pair.from, to: { agent: true } }, { id: "x2", ...pair }]));
  expect(makeRouter(join(dir, "old.json"), async () => {}).list().map((l) => l.id)).toEqual(["x2"]);
});

test("every press of a button goes out, in order, beside the same device's dial", async () => {
  const got: string[] = [];
  let release = () => {};
  const router = makeRouter(join(dir, "e.json"), async (link, value) => {
    if (!got.length) await new Promise<void>((r) => (release = r));
    got.push(`${link.from.kind} ${value}`);
  });
  router.add({ from: { device: "knob", kind: "click" }, to: pair.to });
  router.add(pair); // the dial of the same device to the same lamp is another link
  expect(router.list()).toHaveLength(2);
  expect(router.joined()).toEqual({ knob: ["click", "dial"] });
  const presses = [1, 1, 1].map(() => router.dispatch(knob, "click", 1));
  await Bun.sleep(1); // the first press is on its way, the others wait behind it
  release();
  await Promise.all(presses);
  expect(got).toEqual(["click 1", "click 1", "click 1"]);
});

test("while one value is on its way, only the newest of the later ones follows; a failure is kept and counted", async () => {
  const got: number[] = [], flows: string[] = [];
  let release = () => {};
  const router = makeRouter(join(dir, "d.json"), async (_link, value) => {
    got.push(value);
    if (value === 10) await new Promise<void>((r) => (release = r));
    if (value === 30) throw new Error("lamp is offline");
  }, (_id, value, error) => flows.push(`${value}${error ? " failed" : ""}`));
  router.add(pair);
  const first = router.dispatch(knob, "dial", 10);
  router.dispatch(knob, "dial", 20);
  router.dispatch(knob, "dial", 30);
  release();
  expect(await first).toEqual(sent(1, 1));
  expect(got).toEqual([10, 30]);
  expect(flows).toEqual(["10", "30", "30 failed"]); // what the app's screen is told, as it happens
  expect(router.list()[0].last).toMatchObject({ value: 30, error: "lamp is offline" });
});

test("what is said goes to other devices' speakers with the recording, never to its own or to a lamp", async () => {
  const played: string[] = [];
  const router = makeRouter(join(dir, "g.json"), async (link, _value, source, said) => { played.push(`${source.name} -> ${link.to.device}: ${(said as { audio: string }).audio}`); });
  expect(router.add({ from: { device: "knob", kind: "talk" }, to: { device: "knob", output: "speak" } })).toBeNull();
  expect(router.add({ from: { device: "knob", kind: "talk" }, to: { device: "lamp", output: "light" } })).toBeNull();
  expect(await router.dispatch(knob, "talk", 1, { audio: "0000" })).toEqual(sent(0)); // unjoined: only the agent may hear it
  const link = router.add({ from: { device: "knob", kind: "talk" }, to: { device: "room", output: "speak" } })!;
  router.add({ from: { device: "knob", kind: "talk" }, to: { device: "hall", output: "speak" } });
  expect(await router.dispatch(knob, "talk", 1, { audio: "AAAA" })).toEqual(sent(2));
  expect(played.sort()).toEqual(["주방 -> hall: AAAA", "주방 -> room: AAAA"]);
  router.set(link.id, false);
  expect(router.joined()).toEqual({ knob: ["talk"] });
  expect(await router.dispatch(knob, "talk", 1, { audio: "BBBB" })).toEqual(sent(1));
});
