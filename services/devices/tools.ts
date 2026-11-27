// kkachi-devices as an MCP service: the tools and what they do. Which agent gets which is set in
// core's kkachi.mcp.json.
import type { McpService, McpTool } from "./lib/mcp-server";
import { brightnessOn, describeDevices, lightOn, replyOn, sensorsOn, snapshotOn, soundLevelOn, speakOn } from "./devices";

const device = { type: "string", description: "Device name, as in list_devices" };

const DEFS: (Omit<McpTool, "run">)[] = [
  {
    name: "device_reply",
    description: "Kkachi core only: the answer to something said on a device, shown there (what was heard, the answer read aloud, or where the answer went instead). A long answer comes a sentence at a time, as it is written: part counts them from 0, and last ends the answer (show: the whole answer, to leave on screen).",
    inputSchema: { type: "object", properties: { device, inputId: { type: "string" }, heard: { type: "string" }, text: { type: "string" }, part: { type: "number" }, last: { type: "boolean" }, show: { type: "string" } }, required: ["device", "inputId", "heard"] },
    internal: true,
  },
  {
    name: "list_devices",
    description: "List the user's Kkachi devices (spare phones or tablets around the home, named like 거실 or 부엌), whether each is online, and what it can do.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "device_speak",
    description: "Say something out loud on one of the user's Kkachi devices, e.g. when asked to announce or tell someone something there (\"거실에서 밥 먹으라고 말해줘\"). Waits until it has been played. Write the words exactly as they should be heard, in the user's language.",
    inputSchema: { type: "object", properties: { device, text: { type: "string", description: "What to say" } }, required: ["device", "text"] },
  },
  {
    name: "device_snapshot",
    description: "Take one photo with a device's camera and look at it, e.g. \"거실 지금 어때?\", \"현관에 택배 왔어?\". Also reports how bright the room is. The photo is not stored. Use only when the user asks to see or check a place.",
    inputSchema: { type: "object", properties: { device, camera: { type: "string", enum: ["back", "front"], description: "Default back" } }, required: ["device"] },
  },
  {
    name: "device_sound_level",
    description: "Measure how loud it is around a device for a few seconds (dBFS and quiet/moderate/loud), e.g. \"아기 방 조용해?\". Nothing is recorded or kept.",
    inputSchema: { type: "object", properties: { device, seconds: { type: "number", description: "1 to 10, default 3" } }, required: ["device"] },
  },
  {
    name: "device_brightness",
    description: "How bright the room around a device is, with its camera as a light sensor: dark, dim, lit or bright, and roughly how many lux when the camera reports its exposure. E.g. \"거실 불 켜져 있어?\", \"아기 방 어두워?\". No photo is taken or kept, and nothing is shown to you but the numbers.",
    inputSchema: { type: "object", properties: { device }, required: ["device"] },
  },
  {
    name: "device_sensors",
    description: "Read a device's motion and position sensors: how it is lying (face up, standing, ...), whether and when it was last moved or picked up, its compass heading, and its location if allowed.",
    inputSchema: { type: "object", properties: { device }, required: ["device"] },
  },
  {
    name: "device_light",
    description: "Use a tablet's screen as a lamp: fill it with a color at a brightness, or turn it off. It can be no brighter than the device's own screen brightness setting. Phones cannot be lamps (list_devices says which devices can).",
    inputSchema: {
      type: "object",
      properties: {
        device,
        on: { type: "boolean" },
        color: { type: "string", description: "CSS color, e.g. white, #ffd9a0 (warm), red. Default warm white" },
        brightness: { type: "number", description: "0 to 100, default 100" },
      },
      required: ["device", "on"],
    },
  },
];

const name = (a: any) => String(a?.device ?? "");
const looks = { readOnlyHint: true, openWorldHint: true }; // reads the room; changes nothing
const RUN: Record<string, Pick<McpTool, "run" | "annotations">> = {
  device_reply: {
    annotations: { readOnlyHint: false, destructiveHint: false },
    run: (a) => replyOn(name(a), { inputId: String(a?.inputId ?? ""), heard: String(a?.heard ?? ""), ...(a?.text && { text: String(a.text) }), ...(Number.isInteger(a?.part) && { part: a.part }), ...(a?.last === true && { last: true }), ...(typeof a?.show === "string" && { show: a.show }) }),
  },
  list_devices: { annotations: { readOnlyHint: true }, run: () => describeDevices() },
  device_speak: { annotations: { readOnlyHint: false, destructiveHint: false }, run: (a) => speakOn(name(a), String(a?.text ?? "")) },
  device_snapshot: { annotations: looks, run: (a) => snapshotOn(name(a), a?.camera) },
  device_sound_level: { annotations: looks, run: (a) => soundLevelOn(name(a), a?.seconds) },
  device_brightness: { annotations: looks, run: (a) => brightnessOn(name(a)) },
  device_sensors: { annotations: looks, run: (a) => sensorsOn(name(a)) },
  device_light: { annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }, run: (a) => lightOn(name(a), a) },
};

export const service: McpService = {
  name: "kkachi-devices",
  instructions: "Spare phones and tablets around the user's home that can speak, take photos, measure sound and light, read their sensors and act as lamps. Call list_devices to see their names and what each can do now.",
  tools: DEFS.map((t) => ({ ...t, ...RUN[t.name] })),
};
