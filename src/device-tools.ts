// The device tools, as the devices MCP server lists them (src/mcp.ts). Which agent gets which is
// set in kkachi.mcp.json.
const device = { type: "string", description: "Device name, as in list_devices" };

export const DEVICE_TOOLS = [
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
    name: "device_sensors",
    description: "Read a device's motion and position sensors: how it is lying (face up, standing, ...), whether and when it was last moved or picked up, its compass heading, and its location if allowed.",
    inputSchema: { type: "object", properties: { device }, required: ["device"] },
  },
  {
    name: "device_light",
    description: "Use a device's screen as a lamp: fill it with a color at a brightness, or turn it off. It can be no brighter than the device's own screen brightness setting.",
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
