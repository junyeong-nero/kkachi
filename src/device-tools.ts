// The device tools, defined once. Served over MCP at /mcp (src/mcp.ts) for any agent, and
// registered as Pi tools by pi/kkachi.ts for Kkachi's own agent. Plain data: Pi loads this file too.
export const DEVICE_TOOLS = [
  {
    name: "list_devices",
    description: "List the user's Kkachi devices (spare phones or tablets around the home, named like 거실 or 부엌) and whether each is online and can speak.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "device_speak",
    description: "Say something out loud on one of the user's Kkachi devices, e.g. when asked to announce or tell someone something there (\"거실에서 밥 먹으라고 말해줘\"). Waits until it has been played. Write the words exactly as they should be heard, in the user's language.",
    inputSchema: {
      type: "object",
      properties: {
        device: { type: "string", description: "Device name, as in list_devices" },
        text: { type: "string", description: "What to say" },
      },
      required: ["device", "text"],
    },
  },
] as const;
