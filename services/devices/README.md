# kkachi-devices

Spare phones and tablets as devices an agent can use. A phone opens one web page and becomes a speaker, a camera, a sound meter, a motion and location sensor and a lamp, and passes on what someone says to it. Nothing to install on the phone, and nothing it sees or hears is stored.

It is part of [Kkachi](../../README.md), which starts it and talks to it, and it also runs on its own as an MCP server for any agent.

## Run

```sh
bun server.ts        # http://127.0.0.1:4301
```

Phones need HTTPS for the microphone and camera, so serve it on your tailnet: `tailscale serve --bg --https=443 http://127.0.0.1:4301`, then open `https://<computer>.<tailnet>.ts.net/device` on the phone, give it a name and tap once. Only this computer and `*.ts.net` addresses are let in, never a public URL.

A new device waits until you allow it. Kkachi Home (the app on your phone) has a screen for that; on its own, find its id with `GET /api/device/list` and `POST /api/device/<id>/allow` (or `/forget`).

Point an agent at `http://127.0.0.1:4301/mcp` (MCP over Streamable HTTP, stateless). Its tools:

| Tool | Does |
|---|---|
| `list_devices` | the devices, and what each can do right now |
| `device_speak` | says something on a device |
| `device_snapshot` | takes a photo (back or front camera) and returns it with the scene's brightness |
| `device_sound_level` | measures how loud the room is for a few seconds (nothing recorded) |
| `device_sensors` | motion, orientation and location |
| `device_light` | fills the screen with a color as a lamp, or turns it off |

Whoever is next to a device sees what it is doing ("찍는 중") and, in its log, what it did. Which of a device's inputs and outputs an agent may use is kept here per device (`POST /api/device/<id>/agent` with `{cap, open}`; Kkachi Home has switches for it); a closed one is refused.

## With Kkachi core, and on its own

| | Started by Kkachi core | On its own |
|---|---|---|
| Hold to talk | goes to core's agent; the answer comes back to the device, Kkachi Home, or both | refused ("no agent") |
| Voice | core's setting: the device's own voice, or a server voice made by core | the device's own voice |
| State (`devices.json`) and log | core's data directory | `./data` |

## Settings

| Variable | Default | |
|---|---|---|
| `KKACHI_DEVICES_PORT` | `4301` | |
| `KKACHI_DATA_DIR` | `./data` | Kkachi core passes its own |
| `KKACHI_CORE_URL` | | set by core; without it the service runs on its own |
| `KKACHI_INTERNAL_TOKEN` | | shared with core: core-only tools and calls back to core |

## Files

`server.ts` (routes), `devices.ts` (devices, requests, the input queue), `tools.ts` (MCP tools), `core.ts` (calls to core), `data.ts` (state and log), `device.html` (the page a phone opens). `lib/` holds copies of Kkachi's `lib/mcp-server.ts` and `lib/trust.ts`; Kkachi's tests keep them identical until this service moves to its own repo. The messages between page, service and core are in [PROTOCOL.md](PROTOCOL.md).
