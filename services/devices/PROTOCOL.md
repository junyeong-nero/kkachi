# kkachi-devices protocol

Three parties: the page a device opens (`device.html`), this service, and Kkachi core when core started the service. Inputs are events and outputs are commands: a device sends what was said and moves on; where the answer goes is core's decision (Kkachi `docs/bus.md`).

## HTTP

| Route | |
|---|---|
| `GET /device` | the page |
| `GET /api/device/icon.png` | its icon |
| `GET /api/device/ws` | the page's WebSocket (below) |
| `GET /api/device/list` | `{devices: [{id, name, allowed, online, armed, can, ...}]}` |
| `POST /api/device/<id>/allow`, `/forget` | allow a waiting device, or remove one |
| `POST /mcp` (also `/mcp/devices`) | MCP, Streamable HTTP, stateless JSON |

Every request must come from this computer or a `*.ts.net` name, and a browser's Origin must match its Host.

## Page and service: one WebSocket, JSON messages

### Page to service

| `type` | Fields | When |
|---|---|---|
| `hello` | `name`, `token?`, `armed`, `features`, `version` | on connect. `token` once allowed; `features` are the web APIs it has; an old `version` gets `update` |
| `state` | `armed`, `perms`, `enabled` | sound unlocked, permissions given, a switch on its screen changed |
| `result` | `id`, `ok`, `data?` or `error?` | the answer to a request |
| `warm` | | the talk button went down: core gets an agent ready |
| `input` | `id`, `kind: "talk"`, `age`, `audio`, `mime` | something said (16 kHz WAV, base64). Kept and sent again until acked; dropped after 60 s |

### Service to page

| `type` | Fields | When |
|---|---|---|
| `pending`, `ready` | `name`, `token` | waiting to be allowed; allowed (the page keeps the token) |
| `forgotten` | | removed |
| `update` | | the page is older than the service: reload |
| `ack` | `id`, `ok`, `error?` | an `input` reached core. Errors: `not allowed`, `unknown kind`, `switched off`, `bad audio`, `no agent` (no core), `expired` |
| `reply` | `inputId`, `heard`, `text?`, `elsewhere?`, `rate`, `audio?`, `mime?` | the answer to an input, possibly much later; kept two minutes for a page that is away. No `audio`: say `text` with the device's own voice at `rate` (percent). `elsewhere`: the answer went to the phone |

### Requests: service to page, with an `id`, answered with `result`

| `type` | Fields | `data` |
|---|---|---|
| `speak` | `text`, `rate`, `audio?`, `mime?` | none, once it has been said |
| `snapshot` | `camera: "back" \| "front"` | `{data, width, height, brightness}`: a JPEG (base64), at most 1280 px |
| `sound` | `seconds` | `{avg, peak}` in dBFS; nothing recorded |
| `sensors` | | orientation, `motion`, `maxRecent`, `lastMovedAgoSec`, `location`, and `unavailable` with reasons |
| `light` | `on`, `color`, `brightness` | none |

A request for something switched off on the device's screen gets `{ok: false, error: "turned off on the device"}`.

## Service and core

Only when core started the service. Core sets `KKACHI_CORE_URL`, `KKACHI_INTERNAL_TOKEN` (sent as the `x-kkachi-internal` header both ways) and `KKACHI_DATA_DIR`, and forwards `/device`, `/api/device/*` and `/mcp/devices` from its own address.

| Call | Body | Answer |
|---|---|---|
| service → `POST /api/bus/input` | `{id, source: {id, name}, kind, age, audio, mime}` | `{accepted, duplicate?, reason?}`. Each `id` is handled once; acked again if sent again |
| service → `POST /api/bus/warm` | `{source: {id, name}}` | `{}` |
| service → `POST /api/bus/voice` | `{}` | `{voice, rate}`. `voice: "device"`: the device speaks itself |
| service → `POST /api/tts` | `{text}` | audio in core's voice, only when that is not `"device"` |
| core → MCP `device_reply` (core only) | `{device, inputId, heard, text?, elsewhere?}` | sends `reply` to that device |

An `ack` means core has the input, not that it has been answered.
