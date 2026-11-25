# DESIGN.md: Kkachi web app

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
| accent-ink (icons and text on the accent) | `oklch(0.99 0.004 192)` | `oklch(0.2 0.03 192)` |
| danger | `oklch(0.53 0.17 35)` | `oklch(0.74 0.13 40)` |
| scrim (behind the settings sheet) | `oklch(0.2 0.02 250 / .4)` | same |
| dim (the `/device` lamp's dimmer) | | `oklch(0.1 0.005 250)` |

- **Type**: SUIT Variable (Korean-native sans; not Inter/Pretendard by reflex). Scale ratio 1.2 from 16px: 13 / 16 / 19 / 23. Korean line breaks with `word-break: keep-all`.
- **Radius**: 8px (chips, small controls), 14px (bubbles, groups, sheet), pill (buttons, mic).
- **Shadow**: one soft elevation `0 1px 2px` in light mode only; dark mode uses lightness steps.
- **Motion**: `--ease-out: cubic-bezier(.22,1,.36,1)`, 120ms / 200ms. Only transform, opacity, color. Reduced motion keeps color and opacity changes, drops movement. The voice-level halo is a disc behind the mic scaled with transform, never an animated box-shadow, so focus rings appear at once.
- **Spacing**: mostly 8, 10, 12, 14, 16, 20 and 24px, with 3 to 9px insets inside dense controls (chips, segments, table cells). Hallmark's 4px scale is noted, not adopted: the 10 and 14px values set the bubble and card padding, and changing them is a layout change, not a polish.

## Craft decisions

- **Layout**: header (refresh, logo, settings) / transcript / composer: `(photo) [text box] (mic) (send)`, with a one-line status above it only when there is something to say (recording, transcribing, an error). Picked or taken photos (up to 4, scaled to 1600px JPEG on the phone) wait as 64px thumbnails with a remove button above the text box, and appear above your words in your bubble once sent. A photo alone can be sent. The mic is tap to start / tap to stop, or hold and let go; transcribed words are appended to the text box to check and fix, and nothing is sent until you press send (or Enter).
- **Transcript**: last 30 turns of this page, as chat bubbles: yours a light `surface` fill on the right, Kkachi's outlined (`bg` with a `line` border) on the left (fill vs outline keeps them apart without heavy color) with the working dots and activity label inside it. Kkachi's bubble appears once your words are known and is removed if the turn ends without words. Replies are Markdown (marked + DOMPurify, vendored in `src/web/vendor/`); narration before a tool call stays in the bubble as a muted aside. Read-aloud is off by default (per device) and speaks only the first two sentences.
- **Devices**: a settings section lists spare phones and tablets joined at `/device` (name, then 허용 대기 / 꺼져 있음 / 연결됨 with what it can do now) with 허용 or 삭제.
- **`/device` page**: dark only, because it sits in a room all day. From the top:
  - logo, the device name large, one status line, and a "탭해서 시작" button until sound is unlocked
  - switch cards in a grid, in two sections: 출력 (까치가 이 기기로): 말하기, 조명, and 입력 (이 기기가 까치에게): 말 걸기, 사진, 소리 크기, 센서, 위치. Each card has a line icon, a name, a state (켜짐 / 꺼 둠 / 탭 필요 / 권한 없음 / 지원 안 함, or what it is doing now: 말하는 중, 찍는 중, 재는 중, 비추는 중) and an on/off switch. The switch track is `text` when on; off dims the icon and name; an unusable card loses its fill, keeps a `line` outline, goes `muted` and shows a not-allowed cursor. A card darkens to `line` while pressed. A card in use gets the `line` background, or teal while listening (재는 중, 듣는 중)
  - one line with the time and the last thing Kkachi did there ("오후 3:02에 까치가 사진을 찍었어요 (저장 안 함)")
  - a 112px round hold-to-talk button (mic icon, teal with an `accent-ink` icon and a voice-level halo only while held, since that is listening; `muted` while waiting for the answer), what was heard in quotes (`muted`), and the words spoken (current ones in `text`, earlier ones `muted`)

  Teal appears nowhere else on the page. As a lamp (`device_light`) the whole screen is one color, dimmed by a `dim` layer, and a tap turns it off. An outdated page shows a single "새 버전이 있어요. 눌러서 새로고침" button. Status lines are sentences, never joined with middle dots.
- **Device photos**: a photo Kkachi took through a device appears in its bubble under the words, full width (max 360px tall).
- **First run**: example sentences to say, as plain quoted lines (not tappable-looking boxes), placed near the talk button.
- **States**: mic idle / recording (teal with `accent-ink`, level halo) / thinking (dimmed) / speaking (bars) / disabled (mic permission denied). Icon buttons and settings controls have hover (pointer devices), active, focus-visible (3px teal ring, instant). Disabled is never opacity alone: send goes `line` with a `muted` arrow and a not-allowed cursor; a button waiting on the server goes `muted` with a progress cursor.
- **Keyboard**: Enter sends, Shift+Enter is a new line; outside the text box, hold Space to dictate.
- **Browser surfaces**: selection, caret, and scrollbar use the palette.
- **Dark mode**: designed per token, follows the system; `?theme=light` forces light for review.
- **Docs images** (`docs/banner.svg`, `docs/architecture-simple.svg`, `docs/architecture.svg`): the same tokens in their light values, SUIT, radius 14px or less on cards and pills for tags. The banner is the logo, name, one line and tags on `accent-soft`, with a teal band at the bottom edge; the logo is the real icon embedded as a PNG, not a redrawn mascot. Diagrams place each client above the part it connects to, teal for the phone app (the personal port), and dashed lines for core-only or optional links.

## Slop audit (2026-11-21)

Checked against samber `frontend-design-deslop` slop-checklist, impeccable `craft-floor`, and anthropics `frontend-design`.

Fixed: indigo-band accent (#2F5BD3, H≈265) → teal; Pretendard (Inter-derived) → SUIT; "무엇을 도와드릴까요?" category-default copy and centered icon-tile empty state → example sentences; instruction repeated in two slots; mixed radii and an 18px bubble; missing hover/disabled states; pointer-only mic → Space key; default selection and scrollbar; muted chip contrast below 4.5:1; keyword easing.

Kept on purpose: centered single column and chat bubbles (familiar Operate-mode pattern the brief asks for); one font family (one family with weight steps suits a quiet tool).

2026-11-25, Hallmark audit then polish (`sloplint --scope app` on `src/web/index.html` and `services/devices/device.html`, stamped in each stylesheet). Fixed: the recording mic and talk button at 2:1 in dark mode (`accent-ink`); a focus ring that faded in with the halo's box-shadow transition; opacity-only disabled states; no pressed state on `/device`; middle-dot status strings; an accented word inside the `/device` section heads; colours outside the tokens; `overflow: hidden` on body; a bare `1fr` header track. Result: 0 FAIL, 0 Reflex open; one waiver (28b, the hidden camera video), one dismissal (3, the Markdown blockquote rule), one answer (F23, no meta description on a private app). Noted, not changed: 31 spacings off the 4px scale (see Spacing).

2026-11-25, docs images, against the same checklist: card radius 18px (over the 14px token) brought down to 14px. Kept: the pill tags in the banner (tags, not cards) and the three-box diagram (the content has three parts).

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
- 2026-11-25: input/output switch cards on `/device`; the settings sheet lists what each device can do now.
- 2026-11-25: README banner and architecture diagrams.
- 2026-11-25: Hallmark polish: `accent-ink`, `scrim` and `dim` tokens, the halo as a scaled disc, disabled states with fill, ink and cursor, a pressed state on `/device`, status lines as sentences.
