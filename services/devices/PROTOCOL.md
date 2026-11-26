# kkachi-devices protocol

Three parties: the page a device opens (`device.html`), this service, and Kkachi core when core started the service. Inputs are events and outputs are commands: a device sends what was said and moves on; where the answer goes is core's decision (Kkachi `docs/bus.md`).

## HTTP

| Route | |
|---|---|
| `GET /device` | the page |
| `GET /api/device/icon.png` | its icon |
| `GET /api/device/ws` | the page's WebSocket (below) |
| `GET /api/device/list` | `{devices: [{id, name, kind, allowed, online, armed, can, ...}]}`. `kind` is what the device is, for its picture: `phone` or `tablet` |
| `POST /api/device/<id>/allow`, `/forget` | allow a waiting device, or remove one |
| `POST /api/device/<id>/agent` | `{cap, open}`: open one of its inputs or outputs to the agent, or close it. `cap` is `talk`, `photo`, `sound level`, `motion sensors`, `location`, `speak` or `lamp`. Kept with the device; everything is open on a new one. A button and a dial (`click`, `dial`) never go to the agent: they are joined to outputs. Only a tablet has `lamp`: a lit lamp is the whole screen, and on a phone it took the touches meant for its pads. The list gives each device's `agent` map, and `can` (what works there now, whatever is open) |
| `POST /mcp` (also `/mcp/devices`) | MCP, Streamable HTTP, stateless JSON |

Every request must come from this computer or a `*.ts.net` name, and a browser's Origin must match its Host.

## Page and service: one WebSocket, JSON messages

### Page to service

| `type` | Fields | When |
|---|---|---|
| `hello` | `name`, `token?`, `armed`, `features`, `form`, `version` | on connect. `token` once allowed; `features` are the web APIs it has; `form` is `phone` or `tablet` (a screen 600 px or wider on its short side), a phone when missing; an old `version` gets `update` |
| `ping` | | every 25 s. With nothing heard from the service for 60 s the page takes the connection for dead and connects again |
| `state` | `armed`, `perms` | sound unlocked, permissions given. The page has no switches: what is used is chosen in Kkachi Home (`use`, below) |
| `result` | `id`, `ok`, `data?` or `error?` | the answer to a request |
| `warm` | | the talk button went down: core gets an agent ready |
| `input` | `id`, `kind: "talk"`, `age`, `audio`, `mime` | something said (16 kHz WAV, base64). Kept and sent again until acked; dropped after 60 s |
| `value` | `kind: "dial" \| "click"`, `value` | its dial moved (0 to 100, at most ten a second, only the newest matters) or its button was pressed (`value: 1`, every press sent). Never acked or sent again. Ignored unless that one is switched on there (the talk button, the button and the dial can all be on: each is a pad on the screen) |

### Service to page

| `type` | Fields | When |
|---|---|---|
| `pending`, `ready` | `name`, `token` | waiting to be allowed; allowed (the page keeps the token) |
| `forgotten` | | removed |
| `update` | | the page is older than the service: reload |
| `ack` | `id`, `ok`, `error?` | an `input` reached core. Errors: `not allowed`, `unknown kind`, `switched off`, `bad audio`, `no agent` (no core), `expired` |
| `use` | `pads`, `agent` | on connect and whenever Kkachi Home changes it. `pads`: which of `talk`, `click`, `dial` show as pads, one for each that goes somewhere (open to the agent, or joined to an output). `agent`: which inputs and outputs are open to the agent, by `cap` |
| `reply` | `inputId`, `heard`, `text?`, `elsewhere?`, `rate`, `quiet?`, `audio?`, `mime?`, `part?`, `last?`, `show?` | the answer to an input, possibly much later; kept two minutes for a page that is away. No `audio`: say `text` with the device's own voice at `rate` (percent). `elsewhere`: the answer went to the phone. An answer comes a sentence at a time while it is being written: `part` counts them from 0 and they may arrive out of order (each one's voice is made on its own, and one the server takes over 6 s to make comes without `audio`), so the page says them by number; `last` ends the answer and `show` is the whole of it, to leave on screen. Without `part` it is a whole answer |
| `replaced` | | the same device connected from another page, which has it now. The service closes this one; the page does not come back |
| `pong` | | the answer to a `ping` |
| `dim` | `brightness` or `toggle: true` | an input joined to this device's lamp. A dial moved: the brightness alone (0 turns it off), in the colour the lamp last had. A button was pressed: on as it last was, or off. Nothing to answer |

### Requests: service to page, with an `id`, answered with `result`

| `type` | Fields | `data` |
|---|---|---|
| `speak` | `text`, `rate`, `audio?`, `mime?`, `from?` | none, once it has been said. With `from`: `audio` is what was said on that device, played as recorded (a walkie-talkie), not Kkachi's words |
| `snapshot` | `camera: "back" \| "front"` | `{data, width, height, brightness}`: a JPEG (base64), at most 1280 px |
| `sound` | `seconds` | `{avg, peak}` in dBFS; nothing recorded |
| `sensors` | `skip?` (of `motion sensors`, `location`: not open to the agent, left out) | orientation, `motion`, `maxRecent`, `lastMovedAgoSec`, `location`, and `unavailable` with reasons |
| `light` | `on`, `color`, `brightness` | none |

The page does what it is asked. Whether the agent may ask is the service's to check: a tool call for something not open to the agent is refused there, before anything reaches the page. `quiet` on a `reply`: this device's speaker is not open to the agent, so the words only show.

## Service and core

Only when core started the service. Core sets `KKACHI_CORE_URL`, `KKACHI_INTERNAL_TOKEN` (sent as the `x-kkachi-internal` header both ways) and `KKACHI_DATA_DIR`, and forwards `/device`, `/api/device/*` and `/mcp/devices` from its own address.

| Call | Body | Answer |
|---|---|---|
| service → `POST /api/bus/input` | `{id, source: {id, name}, kind, age, audio, mime, agent}` (`agent`: this device's voice is open to the agent; core also plays the recording on every speaker it is joined to) | `{accepted, duplicate?, reason?}`. Each `id` is handled once; acked again if sent again |
| service → `POST /api/bus/warm` | `{source: {id, name}}` | `{}` |
| service → `POST /api/bus/voice` | `{}` | `{voice, rate}`. `voice: "device"`: the device speaks itself |
| service → `POST /api/tts` | `{text}` | audio in core's voice, only when that is not `"device"` |
| service → `POST /api/bus/value` | `{source: {id, name}, kind: "dial" \| "click", value}` | `{}`. Core passes it to the outputs joined to that input; not waited for |
| core → MCP `device_links` (core only) | `{links: {<device id>: [kinds]}}` | which inputs are joined straight to an output now; each device is sent `use` again |
| core → MCP `device_play` (core only) | `{device, audio, mime, from}` | sends `speak` with that recording to the device, and waits until it has been played |
| core → MCP `device_dim` (core only) | `{device, brightness}` or `{device, toggle: true}` | sends `dim` to that device |
| core → MCP `device_reply` (core only) | `{device, inputId, heard, text?, elsewhere?}` | sends `reply` to that device |

An `ack` means core has the input, not that it has been answered.
