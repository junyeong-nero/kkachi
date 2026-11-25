# DESIGN.md — Kkachi web app

Single source of truth for the app's visual system (`src/web/index.html`). Interaction design (voice flow, states, latency) lives in [docs/design.md](docs/design.md).

## Discovery

- **Artifact**: mobile AI/conversational interface, text-first with optional dictation and read-aloud (Operate mode). Used one-handed on a phone.
- **Who / job**: one person talking to their own assistant. Primary action: type (or dictate) something, check it, send.
- **Brief**: clean and neutral like other AI products; the magpie (까치) appears only as the app icon and logo, the way Kitsune uses its fox. An earlier full-screen magpie illustration was rejected as kitschy.
- **Adjectives**: calm, clear, quick, trustworthy. Essence: *quiet text assistant*.

## Commitments

- **Aesthetic**: plain neutral surfaces, one accent, content first. Familiar chat patterns (your words right, Kkachi's answer left) because Operate mode rewards familiarity.
- **Signature move**: the mic button that draws your live voice level as a halo while recording, and "remembered" chips in the same magpie-wing teal. Teal only ever means "Kkachi is listening" or "Kkachi remembered this".
- **Symbol**: flat magpie head-and-shoulders mark (black, white belly and wing, one teal wing patch) on pale mint `#CEE8E2`, generated with Codex image generation on deep ink `#16181C` and moved onto mint by `assets/icon/recolor.py` (the black bird disappeared on the ink at home-screen size). Used for the app icon and the header logo only. Source and the two unused candidates (perched profile on off-white, in flight on pale teal) are in `assets/icon/`; `src/web/icon.png` (512), `apple-touch-icon.png` (180), `favicon.png` (64) are resized from `icon-b-mint.png`.

## Tokens

| Role | Light | Dark |
|---|---|---|
| bg | `oklch(0.992 0.002 240)` | `oklch(0.185 0.006 250)` |
| surface | `oklch(0.962 0.005 240)` | `oklch(0.235 0.008 250)` |
| line | `oklch(0.905 0.007 240)` | `oklch(0.31 0.01 250)` |
| text | `oklch(0.22 0.012 250)` | `oklch(0.94 0.005 250)` |
| muted | `oklch(0.49 0.014 250)` | `oklch(0.71 0.012 250)` |
| accent (magpie teal, H≈192) | `oklch(0.54 0.105 192)` | `oklch(0.76 0.095 190)` |
| accent-soft | `oklch(0.948 0.03 192)` | `oklch(0.3 0.045 192)` |
| danger | `oklch(0.53 0.17 35)` | `oklch(0.74 0.13 40)` |

- **Type**: SUIT Variable (Korean-native sans; not Inter/Pretendard by reflex). Scale ratio 1.2 from 16px: 13 / 16 / 19 / 23. Korean line breaks with `word-break: keep-all`.
- **Radius**: 8px (chips, small controls), 14px (bubbles, groups, sheet), pill (buttons, mic).
- **Shadow**: one soft elevation `0 1px 2px` in light mode only; dark mode uses lightness steps.
- **Motion**: `--ease-out: cubic-bezier(.22,1,.36,1)`, 120ms / 200ms. Only transform, opacity, color. Reduced motion keeps color and opacity changes, drops movement.

## Craft decisions

- **Layout**: header (refresh, logo, settings) / transcript / composer: `(photo) [text box] (mic) (send)`, with a one-line status above it only when there is something to say (recording, transcribing, an error). Picked or taken photos (up to 4, scaled to 1600px JPEG on the phone) wait as 64px thumbnails with a remove button above the text box, and appear above your words in your bubble once sent. A photo alone can be sent. The mic is tap to start / tap to stop, or hold and let go; transcribed words are appended to the text box to check and fix, and nothing is sent until you press send (or Enter).
- **Transcript**: last 30 turns of this page, as chat bubbles: yours a light `surface` fill on the right, Kkachi's outlined (`bg` with a `line` border) on the left (fill vs outline keeps them apart without heavy color) with the working dots and activity label inside it. Kkachi's bubble appears once your words are known and is removed if the turn ends without words. Replies are Markdown (marked + DOMPurify, vendored in `src/web/vendor/`); narration before a tool call stays in the bubble as a muted aside. Read-aloud is off by default (per device) and speaks only the first two sentences.
- **Devices**: a settings section lists spare phones and tablets joined at `/device` (name, then 허용 대기 / 꺼져 있음 / 연결됨) with 허용 or 삭제. The `/device` page itself is dark only (it sits in a room all day): logo, the device name large, one status line, a "탭해서 시작" button until sound is unlocked, then a 112px round hold-to-talk button (mic icon; teal with a voice-level halo only while held, since that is listening), what was heard in quotes (`muted`), and the words spoken (current ones in `text`, earlier ones `muted`). No other teal: teal stays "listening" and "remembered". As a lamp (`device_light`) the whole screen is one color, dimmed by a black layer; a tap turns it off. An outdated page shows one "새 버전이 있어요 · 눌러서 새로고침" button.
- **Device photos**: a photo Kkachi took through a device appears in its bubble under the words, full width (max 360px tall).
- **First run**: example sentences to say, as plain quoted lines (not tappable-looking boxes), placed near the talk button.
- **States**: mic idle / recording (teal, level ring) / thinking (dimmed) / speaking (bars) / disabled (mic permission denied). Icon buttons and settings controls have hover (pointer devices), active, focus-visible (3px teal ring).
- **Keyboard**: Enter sends, Shift+Enter is a new line; outside the text box, hold Space to dictate.
- **Browser surfaces**: selection, caret, and scrollbar use the palette.
- **Dark mode**: designed per token, follows the system; `?theme=light` forces light for review.

## Slop audit (2026-11-21)

Checked against samber `frontend-design-deslop` slop-checklist, impeccable `craft-floor`, and anthropics `frontend-design`.

Fixed: indigo-band accent (#2F5BD3, H≈265) → teal; Pretendard (Inter-derived) → SUIT; "무엇을 도와드릴까요?" category-default copy and centered icon-tile empty state → example sentences; instruction repeated in two slots; mixed radii and an 18px bubble; missing hover/disabled states; pointer-only mic → Space key; default selection and scrollbar; muted chip contrast below 4.5:1; keyword easing.

Kept on purpose: centered single column and chat bubbles (familiar Operate-mode pattern the brief asks for); one font family (one family with weight steps suits a quiet tool).

## Changelog

- 2026-11-21: clean AI-app direction, magpie as icon only, deslop pass.
- 2026-11-21: voice and keyboard merged into one composer; dictation fills the text box for review before sending (no more send-on-release).
- 2026-11-21: text-first: Markdown replies, keyboard input mode, read-aloud optional; Kkachi uses Pi's own prompt and AGENTS.md (short-spoken-reply rules dropped). Icon background ink → mint.
- 2026-11-21: Kkachi's replies in bubbles like the user's (were plain text).
- 2026-11-21: hand-drawn SVG icon replaced by a Codex-generated icon (candidate A of three), then switched to candidate B at the user's choice.
- 2026-11-25: photo button left of the text box; thumbnails above it; photos in your bubble. `?demo=photo` for review.
- 2026-11-25: devices section in settings; `/device` page for spare phones and tablets.
- 2026-11-25: hold-to-talk on `/device`.
- 2026-11-25: device photos in Kkachi's bubble; lamp and update notice on `/device`.
