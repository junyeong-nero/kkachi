// Kkachi Home (까치 홈), the app on the user's phone. One composer: type, or tap the mic and speak.
// Spoken words land in the text box to check and fix before sending. Replies render as Markdown and
// can be read aloud. See DESIGN.md.
"use strict";

// ---- tuning ----
const TARGET_RATE = 16000;
const MIN_RECORD_MS = 300;   // shorter recordings are accidental taps
const HOLD_MS = 400;         // mic held longer than this: letting go stops; a shorter tap toggles
const MAX_RECORD_MS = 60000; // stop by itself after a minute
const PREROLL_FRAMES = 2;    // ~170 ms from just before recording, when the mic was already open

const DEBUG = new URLSearchParams(location.search).has("debug");
const $ = (id) => document.getElementById(id);

// Per-device preference (a phone and a laptop want different ones), kept in localStorage.
const readAloud = () => localStorage.getItem("kkachi.speak") === "on";

// ---- state ----
let ctx, stream, frameMs = 0;
let state = "idle"; // the mic: idle | recording | transcribing | error
let recording = false, recordFrames = [], preroll = [], prerollCount = 0, recordStart = 0, holdTimer = null;
let turnId = 0, currentSource = null;

if (DEBUG) document.body.classList.add("debug");
const diagLines = [];
// Key events (timings, errors) always go to the server log; state changes only with ?debug.
function diag(msg, data) {
  if (DEBUG) {
    const line = `${new Date().toISOString().slice(11, 23)} ${msg}${data ? " " + JSON.stringify(data) : ""}`;
    diagLines.unshift(line); diagLines.length = Math.min(diagLines.length, 60);
    $("diag").textContent = diagLines.join("\n");
  }
  if (DEBUG || msg !== "state") fetch("/api/log", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ msg, ...data }) }).catch(() => {});
}

function setState(s, hint = "") {
  state = s; document.body.dataset.state = s; $("status").textContent = hint;
  if (s !== "recording") $("mic").style.setProperty("--level", "0");
  diag("state", { s });
}

// ---- sounds ----
function tone(freq, ms, vol = 0.12) {
  if (!ctx) return;
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.frequency.value = freq; g.gain.setValueAtTime(vol, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + ms / 1000);
  o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + ms / 1000);
}
const earcon = {
  start: () => tone(660, 90),
  heard: () => tone(880, 70, 0.08),
  error: () => tone(220, 260),
};


// ---- audio setup: the first press is the user gesture iOS needs for mic and playback ----
function audioOut() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    setSession("play-and-record"); // not "playback": WebKit then refuses the mic
  }
  if (ctx.state !== "running") ctx.resume();
}

// Music from other apps: while a web page captures the mic, iOS puts it in a play-and-record session
// that does not mix, so the music pauses (a page cannot change that). So the mic is open only while
// you hold the button, and with read-aloud off the page lets go of audio entirely afterwards and
// returns to the default session, so the music can come back.
const setSession = (type) => { if (navigator.audioSession) { try { navigator.audioSession.type = type; } catch {} } };
let micNodes = [];

function releaseMic() {
  try { stream?.getTracks().forEach((t) => t.stop()); } catch {}
  for (const n of micNodes) { try { n.disconnect(); } catch {} n.onaudioprocess = null; }
  stream = null; micNodes = []; preroll = [];
}

// After each utterance. Read-aloud keeps the AudioContext for the spoken reply.
function doneWithMic() {
  if (readAloud()) releaseMic();
  else { resetAudio(); setSession("auto"); }
}

// iOS stops the mic and leaves the AudioContext "interrupted" when the app is backgrounded or the
// screen locks. Reusing either records silence, so tear both down and rebuild on the next press.
function resetAudio() {
  releaseMic();
  try { ctx?.close(); } catch {}
  ctx = null; currentSource = null;
}

let micGranted = false; // after the first grant, a rebuilt mic records on the same press

async function ensureAudio() {
  if (ctx && ctx.state !== "running") { try { await ctx.resume(); } catch {} }
  if (ctx && ctx.state !== "running") resetAudio(); // could not wake it: start over
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    setSession(readAloud() ? "play-and-record" : "auto"); // "auto" lets iOS pick, and drop back after capture
    diag("env", { standalone: matchMedia("(display-mode: standalone)").matches || !!navigator.standalone, rate: ctx.sampleRate, state: ctx.state });
  }
  const track = stream?.getAudioTracks()[0];
  if (track && track.readyState === "live" && !track.muted) return true;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (e) {
    diag("mic error", { err: String(e) });
    // Not a permanent block: iOS also refuses while the app is going to the background. The next
    // press tries again.
    if (document.visibilityState === "visible") setState("error", "마이크를 쓸 수 없어요. 설정에서 마이크를 허용해 주세요.");
    else ready();
    return false;
  }
  micGranted = true;
  const t = stream.getAudioTracks()[0];
  for (const ev of ["mute", "unmute", "ended"]) t.addEventListener(ev, () => diag("track " + ev));
  t.addEventListener("ended", () => { if (stream?.getAudioTracks()[0] === t) resetAudio(); });
  const source = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  frameMs = (4096 / ctx.sampleRate) * 1000;
  const sink = ctx.createGain(); sink.gain.value = 0;
  source.connect(proc); proc.connect(sink); sink.connect(ctx.destination);
  micNodes = [source, proc, sink];
  proc.onaudioprocess = (e) => onFrame(new Float32Array(e.inputBuffer.getChannelData(0)));
  return true;
}

function ready(hint = "") { setState("idle", hint); }

// ---- capture: record only while the mic button says so ----
function onFrame(f) {
  if (!recording) {
    preroll.push(f); if (preroll.length > PREROLL_FRAMES) preroll.shift();
    return;
  }
  recordFrames.push(f);
  let sum = 0; for (let i = 0; i < f.length; i++) sum += f[i] * f[i];
  $("mic").style.setProperty("--level", Math.min(Math.sqrt(sum / f.length) / 0.08, 1).toFixed(2));
}

async function startRecording() {
  if (recording || state === "transcribing") return;
  stopPlayback(); // speaking over Kkachi silences it (the reply itself keeps coming)
  recording = true;
  recordFrames = [];
  const firstGrant = !micGranted;
  if (!(await ensureAudio())) { recording = false; return; }
  if (firstGrant) { recording = false; doneWithMic(); ready("마이크 준비됐어요. 다시 눌러 말하세요"); return; } // the permission prompt ate this press
  if (!recording) { doneWithMic(); ready(); return; } // stopped while the mic was opening
  recordFrames = [...preroll];
  prerollCount = recordFrames.length;
  recordStart = performance.now();
  earcon.start();
  setState("recording", "듣고 있어요. 다시 누르면 받아적어요");
  clearTimeout(holdTimer);
  holdTimer = setTimeout(stopRecording, MAX_RECORD_MS);
}

function stopRecording() {
  if (!recording) return;
  recording = false;
  clearTimeout(holdTimer);
  if (state !== "recording") return; // still opening the mic: startRecording() finishes up
  const frames = recordFrames, rate = ctx?.sampleRate ?? 48000, ctxState = ctx?.state;
  doneWithMic(); // let go of the mic right away (other apps' music)
  if (performance.now() - recordStart < MIN_RECORD_MS) { ready(); return; }
  // No new audio while held: the audio pipeline is dead (iOS interruption). Do not send silence.
  if (frames.length - prerollCount < 2) {
    diag("no audio while held", { frames: frames.length, ctx: ctxState });
    resetAudio();
    ready("마이크를 다시 연결했어요. 다시 눌러 말해 주세요");
    return;
  }
  transcribe(frames, rate);
}

// Spoken words go into the text box (after what is already there), to check and fix before sending.
async function transcribe(frames, rate) {
  const t0 = performance.now();
  earcon.heard();
  setState("transcribing", "받아적는 중…");
  let text;
  try {
    const r = await fetch("/api/stt", { method: "POST", headers: { "Content-Type": "audio/wav" }, body: encodeWav(frames, rate, TARGET_RATE) });
    const body = await r.json();
    if (!r.ok) throw new Error(body.error);
    text = body.text;
  } catch (e) {
    diag("stt error", { err: String(e) });
    earcon.error();
    return setState("error", "잘 못 들었어요. 다시 말해 주세요.");
  }
  if (!text) return setState("error", "잘 못 들었어요. 다시 말해 주세요.");
  diag("stt", { text, ms: Math.round(performance.now() - t0) });
  addToDraft(text);
  ready();
}

// ---- one turn ----
function sendMessage(text, images = []) {
  const my = ++turnId; // a newer message replaces a reply still coming
  stopPlayback();
  if (readAloud()) audioOut(); // the send tap is the gesture iOS needs before it plays sound
  if (state === "error") ready();
  runTurn(my, addTurn(text, images), images.length ? { text, images } : { text }, performance.now());
}

// Sending it again: the failed turn goes, and the same words (and photos) are sent as a new one.
const retry = (view, body) => () => { view.remove(); sendMessage(body.text ?? "", body.images ?? []); };
async function runTurn(my, view, body, t0) {
  const speak = readAloud();
  const queue = [];       // Promise<AudioBuffer|null>, in play order
  let skipBefore = 0;     // queue items before this index were narration before a tool call: not played
  let streamDone = false, firstSound = 0;

  const player = !speak ? Promise.resolve() : (async () => {
    for (let i = 0; ; ) {
      if (my !== turnId) return;
      if (i < skipBefore) { i = skipBefore; continue; }
      if (i < queue.length) {
        const buf = await queue[i++];
        if (my !== turnId) return;
        if (!buf) continue;
        if (!firstSound) { firstSound = performance.now(); diag("first sound", { ms: Math.round(firstSound - t0) }); }
        await play(buf);
      } else if (streamDone) return;
      else await new Promise((r) => setTimeout(r, 40));
    }
  })();

  try {
    await followTurn(body, () => my === turnId, (e) => {
      if (my !== turnId) return;
      if (e.type === "delta") view.stream(e.text);                       // live text on screen
      else if (e.type === "sentence") { if (speak && !e.silent) queue.push(spoken(e.text)); } // speak as soon as a sentence is complete
      else if (e.type === "aside") { view.aside(); if (speak) { skipBefore = queue.length; stopPlayback(); } }
      else if (e.type === "activity") view.working(activityLabel(e.tool, e.path));
      else if (e.type === "thinking") view.thinking(e.text, e.start);
      else if (e.type === "tool") view.tool(e);
      else if (e.type === "photo") view.photo(e);
      else if (e.type === "done") { view.finish(); showChips(view.chips, e.sources, e.changed, e.titles); }
      else if (e.type === "error") { view.fail(e.message, retry(view, body)); if (speak) queue.push(spoken(e.message)); earcon.error(); }
    });
    view.finish();
  } catch (e) {
    streamDone = true;
    diag("turn error", { err: String(e) });
    if (my === turnId) { view.fail("연결이 끊겼어요.", retry(view, body)); earcon.error(); }
    return;
  }
  streamDone = true;
  await player;
}

// ---- transcript ----
const MAX_TURNS = 30;
// Follow new content only while the reader is at the bottom: someone scrolling up to read an earlier
// reply is not pulled back down by every streamed word. Sending a message always goes to the bottom.
let pinned = true;
function scrollDown(force = false) {
  const log = $("log");
  if (force) pinned = true;
  if (pinned) log.scrollTop = log.scrollHeight;
}
$("log").addEventListener("scroll", () => {
  const log = $("log");
  pinned = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
}, { passive: true });

const el = (tag, cls, html) => { const n = document.createElement(tag); if (cls) n.className = cls; if (html) n.innerHTML = html; return n; };
const DOTS = '<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>';

// What Kkachi is doing, in words, from the tool it is running.
function activityLabel(tool = "", path = "") {
  const note = /\.md$/.test(path) && !path.startsWith("/");
  if (/^(read|grep|find|ls|glob)$/.test(tool)) return note ? "노트 찾는 중" : "파일 보는 중";
  if (tool === "edit" || tool === "write") return note ? "기억하는 중" : "파일 고치는 중";
  if (/web|search|fetch/i.test(tool)) return "웹에서 찾는 중";
  if (/undo/.test(tool)) return "되돌리는 중";
  if (/subagent/i.test(tool)) return "다른 에이전트에게 맡기는 중";
  const device = { device_snapshot: "사진 찍는 중", device_sound_level: "소리 듣는 중", device_brightness: "밝기 재는 중", device_sensors: "기기 살펴보는 중", device_light: "조명 바꾸는 중", device_speak: "기기로 말하는 중" }[tool];
  if (device) return device;
  if (/mcp|browser/i.test(tool)) return "도구 쓰는 중";
  return "작업하는 중";
}

// Replies are Markdown, sanitized before they touch the page (they can quote web pages).
if (window.DOMPurify) {
  DOMPurify.addHook("afterSanitizeAttributes", (n) => { if (n.tagName === "A") { n.target = "_blank"; n.rel = "noopener noreferrer"; } });
}
function renderMarkdown(target, text) {
  if (window.marked && window.DOMPurify) target.innerHTML = DOMPurify.sanitize(marked.parse(text, { gfm: true, breaks: true }));
  else target.textContent = text; // vendor scripts failed to load: plain text still works
}

// One turn in the transcript. It appears the moment you send and fills in live.
const dataUrl = (img) => `data:${img.mimeType};base64,${img.data}`;
// from: where it came from when not this app ("거실에서", a device conversation), shown above it.
function addTurn(text, images = [], from = null, fromKkachi = false) {
  $("log").querySelector(".hello")?.remove();
  const turn = el("article", "turn");
  if (from) { const label = el("div", fromKkachi ? "from left" : "from"); label.textContent = from; turn.append(label); }
  const you = el("div", "you");
  if (!text && !images.length) you.hidden = true; // a message Kkachi sent: no words of yours
  if (images.length) {
    const photos = el("div", "photos");
    for (const img of images) { const im = new Image(); im.src = dataUrl(img); im.alt = "보낸 사진"; photos.append(im); }
    you.append(photos);
  }
  if (text) you.append(text);
  const reply = el("div", "kkachi");
  const work = el("div", "working", `${DOTS}<span class="label"></span>`);
  let block = el("div", "md"); // the message being written; earlier ones (narration before tool calls) are asides
  reply.append(block, work);
  const chips = el("div", "chips");
  turn.append(you, reply, chips);
  const log = $("log");
  log.append(turn);
  while (log.querySelectorAll(".turn").length > MAX_TURNS) log.querySelector(".turn").remove();
  scrollDown(!from); // your own message: always; a device conversation arriving: only if at the bottom
  let raw = "", frame = 0;
  const render = () => { cancelAnimationFrame(frame); frame = 0; renderMarkdown(block, raw.trimStart()); scrollDown(); };
  // What came before the words now being written (thinking, tool calls) goes above them.
  const place = (node) => { reply.insertBefore(node, raw ? work : block); reply.hidden = false; scrollDown(); };
  let think = null, thought = "";
  const fold = () => { for (const t of reply.querySelectorAll("details.think")) t.open = false; }; // the answer has begun
  return {
    chips,
    thinking(delta, start) {
      if (!showThinking()) return;
      if (start || !think) {
        think = el("details", "think"); think.open = true; thought = "";
        const s = el("summary"); s.textContent = "생각";
        think.append(s, el("div", "think-text"));
        place(think);
      }
      thought += delta;
      think.lastChild.textContent = thought.trimStart();
      scrollDown();
    },
    tool(e) {
      if (!showTools()) return;
      let line = [...reply.querySelectorAll(".tool-line")].find((x) => x.dataset.id === e.id);
      if (!line) {
        line = el("div", "tool-line", '<span class="tool-state" aria-hidden="true"></span><span class="tool-name"></span><code class="tool-args"></code>');
        line.dataset.id = e.id;
        line.querySelector(".tool-name").textContent = e.name;
        line.querySelector(".tool-args").textContent = e.args ?? "";
        line.title = e.args ?? "";
        place(line);
      }
      think = null; // thinking after a tool is a block of its own
      line.dataset.state = e.state;
      line.querySelector(".tool-state").textContent = e.state === "start" ? "…" : e.state === "ok" ? "✓" : "✕";
      if (e.ms != null) line.querySelector(".tool-state").title = t("{s}초", { s: (e.ms / 1000).toFixed(1) });
    },
    working(label) { work.hidden = false; work.querySelector(".label").textContent = label; scrollDown(); },
    stream(delta) { if (!raw) fold(); work.hidden = true; raw += delta; if (!frame) frame = requestAnimationFrame(render); }, // one render per frame
    aside() {
      render();
      if (raw.trim()) { block.classList.add("aside"); block = el("div", "md"); reply.insertBefore(block, work); }
      raw = ""; work.hidden = false;
    },
    finish() {
      if (frame) render();
      work.hidden = true;
      if (!raw.trim()) block.remove();
      fold(); think = null;
      if (!reply.querySelector(".md, .err, .photos, .think, .tool-line")) reply.hidden = true; // only actions, no words: no empty bubble
    },
    photo(img) { const p = el("div", "photos"); const im = new Image(); im.src = dataUrl(img); im.alt = "기기가 찍은 사진"; p.append(im); reply.insertBefore(p, work); scrollDown(); },
    fail(message, again) {
      if (frame) render(); work.hidden = true; reply.hidden = false; reply.append(el("p", "err")); reply.lastChild.textContent = message;
      if (again) { const b = el("button", "play retry"); b.type = "button"; b.textContent = "다시 보내기"; b.addEventListener("click", again); reply.append(b); }
      scrollDown();
    },
    remove() { turn.remove(); showHello(); },
  };
}

function clearTranscript() { $("log").replaceChildren(); showHello(); }
// Nothing said yet: who is there and what it can do, in the middle of the screen.
function showHello() {
  const log = $("log");
  if (log.querySelector(".turn, .hello")) return;
  const hello = el("div", "hello", '<img src="/icon.png" alt=""><span class="name">집에 있는 까치예요</span>');
  hello.append(text("p", "", "물어보거나 시켜 보세요. 기억해 둘 것도 말해 주세요. 기기를 둔 방은 보고 들을 수 있어요."));
  log.append(hello);
}

// Notes used for the answer; remembered ones (changed this turn) are highlighted.
function showChips(container, sources, changed, titles = {}) {
  const chips = sources.map((p) => {
    const el = document.createElement("span");
    const remembered = changed.includes(p);
    el.className = "chip" + (remembered ? " changed" : "");
    const name = titles[p] ?? p.replace(/\/index\.md$|\.md$/, "").split("/").pop();
    el.textContent = remembered ? t("기억함: {name}", { name }) : name;
    return el;
  });
  container.replaceChildren(...chips);
  scrollDown();
}

// ---- audio out ----
// The voice is made on Kkachi's server (Settings, 음성: local or online), one sentence at a time.
const spoken = (text) => ttsBuffer(text);

async function ttsBuffer(text) {
  try {
    const r = await fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
    if (!r.ok) throw new Error("tts " + r.status);
    const data = await r.arrayBuffer();
    if (!ctx) return null; // audio was torn down (app backgrounded): keep the text, skip the sound
    return await ctx.decodeAudioData(data);
  } catch (e) { diag("tts error", { err: String(e) }); return null; }
}

function play(buf) {
  if (!ctx) return Promise.resolve();
  return new Promise((resolve) => {
    const src = ctx.createBufferSource(); src.buffer = buf; src.connect(ctx.destination);
    src.onended = () => { if (currentSource === src) currentSource = null; resolve(); };
    currentSource = src; src.start();
  });
}

function stopPlayback() {
  try { currentSource?.stop(); } catch {}
  currentSource = null;
  if ("speechSynthesis" in window) speechSynthesis.cancel();
}

// ---- a turn's server-sent events ----
// iOS cuts a backgrounded app's connections, but the turn keeps running on the server. So the app
// names each turn itself and counts the events it got; when the stream breaks or the app comes back,
// it posts the same id again with that count and the server continues from there. Because the id
// is the app's own, this works even when the first response never arrived (backgrounded right after
// sending). Nothing is lost, shown twice, or run twice.
// The server sends a heartbeat every 15 s; silence longer than this means the stream is dead.
const STREAM_IDLE_MS = 45_000;
let liveStream = null; // the turn stream being read; returning to the app restarts it

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const foreground = () => new Promise((resolve) => {
  if (document.visibilityState === "visible") return resolve();
  const on = () => { if (document.visibilityState === "visible") { document.removeEventListener("visibilitychange", on); resolve(); } };
  document.addEventListener("visibilitychange", on);
});

const newId = () => crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;

async function followTurn(body, isCurrent, onEvent) {
  const id = newId();
  let got = 0, failures = 0;
  const count = (e) => { got++; onEvent(e); };
  for (;;) {
    const before = got;
    try {
      // Resuming: the server already has the photos, do not upload them again.
      const payload = JSON.stringify({ ...body, images: got ? undefined : body.images, id, from: got });
      await readEvents("/api/turn", { method: "POST", headers: { "Content-Type": "application/json" }, body: payload }, count);
      return; // the server closed the stream: the turn is over
    } catch (e) {
      // Refused (bad request, or the server lost the turn: restarted) or replaced by a newer turn: give up.
      if ((e.status >= 400 && e.status < 500) || !isCurrent()) throw e;
      failures = got > before ? 0 : failures + 1;
      if (failures > 4) throw e;
      diag("turn resume", { got, failures, err: String(e) });
      await foreground();
      if (failures > 1) await sleep(1000 * failures);
      if (!isCurrent()) throw e;
    }
  }
}

async function readEvents(url, init, onEvent) {
  const ctrl = new AbortController();
  liveStream = ctrl;
  let idle;
  const arm = () => { clearTimeout(idle); idle = setTimeout(() => ctrl.abort(), STREAM_IDLE_MS); };
  arm();
  try {
    const r = await fetch(url, { ...init, signal: ctrl.signal });
    if (!r.ok || !r.body) throw Object.assign(new Error("turn " + r.status), { status: r.status });
    await readStream(r.body, onEvent, arm);
  } finally {
    clearTimeout(idle);
    if (liveStream === ctrl) liveStream = null;
  }
}

async function readStream(body, onEvent, alive) {
  const reader = body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    alive();
    buf += value;
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 2);
      if (line.startsWith("data: ")) onEvent(JSON.parse(line.slice(6)));
    }
  }
}

// ---- WAV encoding (mono, downsampled, 16-bit PCM) ----
function encodeWav(frames, inRate, outRate) {
  const total = frames.reduce((n, f) => n + f.length, 0);
  const all = new Float32Array(total); let o = 0;
  for (const f of frames) { all.set(f, o); o += f.length; }
  const ratio = inRate / outRate, outLen = Math.floor(total / ratio);
  const pcm = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const s = Math.floor(i * ratio), e = Math.min(Math.floor((i + 1) * ratio), total);
    let acc = 0; for (let j = s; j < e; j++) acc += all[j];
    const v = Math.max(-1, Math.min(1, acc / Math.max(1, e - s)));
    pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  const buf = new ArrayBuffer(44 + pcm.byteLength), d = new DataView(buf);
  const w = (p, s) => { for (let i = 0; i < s.length; i++) d.setUint8(p + i, s.charCodeAt(i)); };
  w(0, "RIFF"); d.setUint32(4, 36 + pcm.byteLength, true); w(8, "WAVE"); w(12, "fmt ");
  d.setUint32(16, 16, true); d.setUint16(20, 1, true); d.setUint16(22, 1, true);
  d.setUint32(24, outRate, true); d.setUint32(28, outRate * 2, true); d.setUint16(32, 2, true); d.setUint16(34, 16, true);
  w(36, "data"); d.setUint32(40, pcm.byteLength, true);
  new Int16Array(buf, 44).set(pcm);
  return new Blob([buf], { type: "audio/wav" });
}

// ---- settings, and 앱 다시 불러오기 under them (a home-screen web app has no reload button) ----
$("refresh").addEventListener("click", () => location.reload());

function toast(text) {
  const el = $("toast");
  el.textContent = text; el.classList.add("show");
  clearTimeout(toast.timer); toast.timer = setTimeout(() => el.classList.remove("show"), 1800);
}

let saved = null;
async function saveSettings(patch) {
  const r = await fetch("/api/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(patch) });
  if (r.ok) { saved = (await r.json()).settings; toast("저장했어요"); } else toast("저장하지 못했어요");
}

const rateLabel = (v) => (v === 0 ? "보통" : `${v > 0 ? "+" : ""}${v}%`);
const providerLabel = { anthropic: "Claude", "openai-codex": "ChatGPT", openai: "OpenAI API", openrouter: "OpenRouter 무료" };

// Text size is a per-device preference (a phone and a laptop want different sizes), kept in
// localStorage as the body font size in px; every other size scales with it.
const theme = () => localStorage.getItem("kkachi.theme") || "auto";
// 외형, 대화: whether this phone shows the model's thinking and the tools it used, in each reply.
const showThinking = () => localStorage.getItem("kkachi.showThinking") === "on";
const showTools = () => localStorage.getItem("kkachi.showTools") === "on";
const THEME_COLOR = { light: "#fcfcfd", dark: "#16181c" };
function applyTheme() {
  const t = theme(), root = document.documentElement;
  if (t === "auto") delete root.dataset.theme; else root.dataset.theme = t;
  for (const m of document.querySelectorAll("meta[name=theme-color]")) m.content = THEME_COLOR[t] ?? (m.media.includes("dark") ? THEME_COLOR.dark : THEME_COLOR.light);
}
applyTheme();
const BASE_PX = 16;
const textSize = () => Number(localStorage.getItem("kkachi.fontSize")) || BASE_PX;
const applyTextSize = (px) => document.documentElement.style.setProperty("--scale", String(px / BASE_PX));
applyTextSize(textSize());

function renderTextSize() {
  const input = $("text-size"), out = $("text-size-out");
  input.value = textSize(); out.textContent = `${textSize()}px`;
  input.oninput = () => { const px = Number(input.value); out.textContent = `${px}px`; applyTextSize(px); }; // live preview
  input.onchange = () => localStorage.setItem("kkachi.fontSize", input.value);
}

// Read-aloud: a radio group in the sheet, stored on this device.
function renderDevicePrefs() {
  const r = row("이 폰에서 읽어 주기", "답의 첫 두 문장을 소리로");
  r.id = "speak-row";
  r.append(switchFor(readAloud(), "이 폰에서 읽어 주기", (on) => { localStorage.setItem("kkachi.speak", on ? "on" : "off"); applySpeak(); renderSums(); }));
  $("speak-row").replaceWith(r);
  applySpeak();
  $("trace-group").replaceChildren(...[["showThinking", "생각 과정 보기", "답하기 전에 모델이 생각한 것", showThinking], ["showTools", "도구 사용 보기", "까치가 쓴 도구와 그 결과", showTools]].map(([key, name, sub, on]) => {
    const r = row(name, sub);
    r.append(switchFor(on(), name, (v) => { localStorage.setItem(`kkachi.${key}`, v ? "on" : "off"); renderSums(); }));
    return r;
  }));
  // 외형's 화면: the phone's setting, or always light or dark
  for (const input of document.querySelectorAll("input[name=lang]")) {
    input.checked = input.value === LANG;
    input.onchange = async () => { await saveSettings({ lang: input.value }); useLang(input.value); };
  }
  for (const input of document.querySelectorAll("input[name=theme]")) {
    input.checked = input.value === theme();
    input.onchange = () => { localStorage.setItem("kkachi.theme", input.value); applyTheme(); };
  }
}

function applySpeak() {
  if (!readAloud() && !recording) { stopPlayback(); resetAudio(); setSession("auto"); } // nothing holds audio now
}

let catalog = null; // what /api/settings offers, for the summaries
function renderSums() {
  $("sum-look").textContent = [t({ auto: "폰 설정대로", light: "밝게", dark: "어둡게" }[theme()]), t("글자 {n}px", { n: textSize() }), ...(showThinking() && showTools() ? [t("생각과 도구 보기")] : showThinking() ? [t("생각 보기")] : showTools() ? [t("도구 보기")] : [])].join(", ");
  if (mcp) $("sum-mcp").textContent = t("기본 {a}개, 추가 {b}개", { a: mcp.builtin.length, b: mcp.added.length });
  if (accountList.length) $("sum-account").textContent = accountList.filter((a) => a.connected).map((a) => a.name).join(", ") || "연결된 계정 없음";
  if (!catalog || !saved) return;
  const name = (list, id) => list.find((x) => x.id === id)?.name ?? "";
  $("sum-voice").textContent = t("목소리 {voice}, 받아쓰기 {stt}", { voice: t({ local: "로컬", edge: "온라인" }[saved.tts]), stt: saved.stt === "local" ? t("로컬") : "Groq" });
  $("sum-model").textContent = [name(catalog.models, saved.model) || saved.model?.split("/").pop(), name(catalog.thinking, saved.thinking)].filter(Boolean).join(", ");
}
async function openSettings() {
  renderTextSize();
  renderDevicePrefs();
  const r = await fetch("/api/settings");
  if (!r.ok) { toast("설정을 불러오지 못했어요"); return; }
  const { settings: s, voices, thinking, models, fallbacks } = await r.json();
  saved = s; catalog = { voices, thinking, models };
  renderSpeech();
  fetch("/api/speech").then((x) => x.json()).then((ready) => { speechState = ready; renderSpeech(); }).catch(() => {});

  const rate = $("rate");
  rate.value = s.rate; $("rate-out").textContent = rateLabel(s.rate);
  rate.oninput = () => ($("rate-out").textContent = rateLabel(Number(rate.value)));
  rate.onchange = () => saveSettings({ rate: Number(rate.value) });

  $("thinking").replaceChildren(...thinking.map((t) => {
    const l = document.createElement("label");
    l.innerHTML = `<input type="radio" name="thinking" value="${t.id}">`;
    l.append(t.name);
    const input = l.querySelector("input");
    input.checked = t.id === s.thinking;
    input.addEventListener("change", () => saveSettings({ thinking: t.id }));
    return l;
  }));

  const select = $("model");
  const groups = new Map();
  for (const m of models) {
    if (!groups.has(m.provider)) {
      const g = document.createElement("optgroup");
      g.label = providerLabel[m.provider] ?? m.provider;
      groups.set(m.provider, g);
    }
    const o = new Option(m.name, m.id, false, m.id === s.model);
    groups.get(m.provider).append(o);
  }
  select.replaceChildren(...groups.values());
  select.onchange = () => saveSettings({ model: select.value });
  const others = fallbacks.filter((m) => m !== s.model);
  renderSums();
  $("fallbacks").textContent = others.length ? t("이 모델이 막히면 {list} 순서로 넘어가요.", { list: others.map((m) => m.split("/").pop()).join(", ") }) : "";
}

// Settings, 음성: where the voice is made, the voices of that engine, where dictation is heard, and
// whether it is tidied (src/speech.ts). speechState: what is ready (GET /api/speech).
let speechState = null;
const segmentOf = (id, name, options, value, change) => {
  $(id).replaceChildren(...options.map(([v, label]) => {
    const l = el("label"); l.innerHTML = `<input type="radio" name="${name}">`; l.append(label);
    const input = l.querySelector("input"); input.checked = v === value;
    input.addEventListener("change", () => change(v));
    return l;
  }));
};
function renderSpeech() {
  if (!saved || !catalog) return;
  const ok = speechState ?? {}, known = !!speechState; // until it is known, nothing is said to be off
  const ENGINE = { local: "로컬", edge: "온라인" };
  segmentOf("tts-engine", "tts", Object.entries(ENGINE), saved.tts, async (v) => { await saveSettings({ tts: v }); renderSpeech(); });
  const ttsDown = known && ((saved.tts === "local" && !ok.ttsLocal) || (saved.tts === "edge" && !ok.edge));
  $("tts-note").textContent = {
    local: ttsDown ? "로컬 목소리 서버가 꺼져 있어요. 켜기 전에는 말하지 못해요." : "까치 서버에서 만들어요 (Supertonic). 읽을 말이 밖으로 나가지 않아요.",
    edge: ttsDown ? "까치 서버에 edge-tts 가 없어요. 설치하기 전에는 말하지 못해요." : "Microsoft Edge 의 목소리예요. 읽을 말이 인터넷으로 나가요.",
  }[saved.tts];
  $("tts-note").classList.toggle("down", ttsDown);
  const voiceName = (catalog.voices[saved.tts] ?? []).find((v) => v.id === saved.voice)?.name ?? saved.voice;
  $("voice-now").textContent = ttsDown ? t("{engine}. 지금 말하지 못해요", { engine: t(ENGINE[saved.tts]) }) : `${t(ENGINE[saved.tts])}, ${t(voiceName)}`;
  $("voice-now").classList.toggle("down", ttsDown);
  const voices = catalog.voices[saved.tts] ?? [];
  $("voices").replaceChildren(...voices.map((v) => {
    const row = document.createElement("label");
    row.className = "voice";
    row.innerHTML = `<input type="radio" name="voice" value="${v.id}"><span><span class="name"></span><span class="sub"></span></span><button type="button" class="play">들어보기</button>`;
    row.querySelector(".name").textContent = v.name;
    row.querySelector(".sub").textContent = v.note;
    const input = row.querySelector("input");
    input.checked = v.id === saved.voice;
    input.addEventListener("change", () => saveSettings({ voice: v.id }));
    row.querySelector(".play").addEventListener("click", (e) => { e.preventDefault(); preview(v.id); });
    return row;
  }));
  segmentOf("stt-engine", "stt", [["local", "로컬"], ["groq", "Groq"]], saved.stt, async (v) => { await saveSettings({ stt: v }); renderSpeech(); });
  const noKey = "Groq 키가 없어요";
  $("stt-note").textContent = saved.stt === "local"
    ? (ok.sttLocal || !known ? "밖으로 안 나가요" : "서버가 꺼져 있어요")
    : (ok.groq || !known ? "Groq 로 나가요" : noKey);
  $("stt-note").classList.toggle("down", known && (saved.stt === "local" ? !ok.sttLocal : !ok.groq));
  segmentOf("polish-engine", "polish", [["off", "끄기"], ["groq", "Groq"]], saved.polish, async (v) => { await saveSettings({ polish: v }); renderSpeech(); });
  $("polish-note").textContent = saved.polish === "off" ? "받아쓴 그대로" : ok.groq || !known ? "Groq 로 나가요" : noKey;
  $("polish-note").classList.toggle("down", known && saved.polish === "groq" && !ok.groq);
}

async function preview(voice) {
  audioOut();
  stopPlayback();
  try {
    const r = await fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "안녕하세요, 까치예요. 오늘도 반가운 소식 전해 드릴게요.", voice, rate: Number($("rate").value) }) });
    if (!r.ok) throw new Error("tts " + r.status);
    play(await ctx.decodeAudioData(await r.arrayBuffer()));
  } catch (e) { toast("목소리를 불러오지 못했어요"); }
}

// ---- screens: the conversation, and a menu that slides in from the left over it (the button at the
// top left, or a swipe from the left edge): 새 대화, the devices (+ to add one), what Kkachi was used
// for, and 설정. A device, adding one, and 설정 open as a page over the conversation; going back
// shows the menu again, where they were opened from ----
const page = () => document.body.dataset.view; // chat | device | add | settings
const chatting = () => page() === "chat" && !menuOpen;
// Motion (DESIGN.md, What moves): a page comes 12px from the right with a fade; going back, the menu
// slides in. Reduced motion keeps the fades only (CSS).
function enter(node, how) {
  node.classList.remove("in-forward");
  void node.offsetWidth; // start again, also when the last one has not finished
  node.classList.add(`in-${how}`);
}
const SETTLE = 160; // a switch finishes moving before its list is drawn again
function openPage(view, deviceId = null) {
  setMenu(false, false);
  opened = deviceId;
  document.body.dataset.view = view;
  if (view === "settings") { showCat(""); openSettings(); loadAccounts(); loadMcp(); }
  if (view === "device") readRoom(deviceId);
  drawn = ""; renderPage();
  const pane = view === "settings" ? $("settings") : $("devices");
  pane.scrollTop = 0;
  enter(pane.firstElementChild, "forward");
}
function closePage() { document.body.dataset.view = "chat"; opened = null; setMenu(true); scrollDown(true); }

// The menu. It follows the finger from the left edge and from itself, and opens or closes on letting go
// by how far and how fast it went. While it is open the rest of the app is inert: Tab stays in it,
// Escape closes it.
let menuOpen = false;
const menu = $("menu"), scrim = $("scrim");
function setMenu(open, focus = true) {
  menuOpen = open;
  document.body.classList.toggle("menu", open);
  menu.style.transform = ""; scrim.style.opacity = "";
  menu.inert = !open;
  for (const id of ["top", "log", "dock", "devices", "settings"]) $(id).inert = open;
  if (open) { loadDevices(); loadConversations(); if (focus) menu.focus({ preventScroll: true }); } // the menu itself: Tab goes on to its first row
  else if (focus && page() === "chat") $("open-menu").focus({ preventScroll: true });
}
setMenu(false, false);
$("open-menu").addEventListener("click", () => setMenu(true));
scrim.addEventListener("click", () => setMenu(false));
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (menuOpen) { e.preventDefault(); setMenu(false); return; }
  if (page() === "chat" || typing(e.target)) return;
  e.preventDefault();
  const inCat = $("settings-body").querySelector(".cat-home").hidden; // a category of settings is open
  const open = document.querySelector("#settings .cat:not([hidden]) .cat-back");
  if (page() === "settings" && inCat) showCat(open?.dataset.back ?? ""); else closePage();
});
let ticks = 0; // the menu and a device's page every 5 seconds; the top bar's 집 every 30
setInterval(() => { if (document.visibilityState === "visible" && (menuOpen || page() === "device" || ++ticks % 6 === 0)) loadDevices(); }, 5000);
loadDevices();
{
  const EDGE = 24; // a swipe that starts this close to the left edge opens the menu
  let drag = null; // { x0, y0, t0, open, width, dx, sideways }
  addEventListener("touchstart", (e) => {
    const t = e.touches[0];
    if (e.touches.length !== 1 || (!menuOpen && (t.clientX > EDGE || page() !== "chat"))) return;
    drag = { x0: t.clientX, y0: t.clientY, t0: performance.now(), open: menuOpen, width: menu.offsetWidth, dx: 0, sideways: null };
  }, { passive: true });
  addEventListener("touchmove", (e) => {
    if (!drag) return;
    const t = e.touches[0], dx = t.clientX - drag.x0, dy = t.clientY - drag.y0;
    drag.sideways ??= Math.abs(dx) > 8 || Math.abs(dy) > 8 ? Math.abs(dx) > Math.abs(dy) : null;
    if (drag.sideways === false) { drag = null; return; } // a scroll: not the menu's
    if (!drag.sideways) return;
    e.preventDefault();
    drag.dx = dx;
    const shown = Math.min(1, Math.max(0, (drag.open ? drag.width + dx : dx) / drag.width)); // 0 closed, 1 open
    document.body.classList.add("dragging", "menu");
    menu.style.transform = `translateX(${(shown - 1) * 100}%)`;
    scrim.style.opacity = String(shown);
  }, { passive: false });
  addEventListener("touchend", () => {
    if (!drag) return;
    const d = drag; drag = null;
    document.body.classList.remove("dragging");
    if (!d.sideways) { if (!d.open) document.body.classList.remove("menu"); return; }
    const speed = d.dx / (performance.now() - d.t0); // px per ms, + to the right
    const shown = (d.open ? d.width + d.dx : d.dx) / d.width;
    setMenu(speed > 0.4 || (speed > -0.4 && shown > 0.5));
  });
}

// A row in a list: a name, a line under it, and sometimes a button.
function row(name, sub, button) {
  const r = el("div", "device", '<span><span class="name"></span><span class="sub"></span></span>');
  r.querySelector(".name").textContent = name;
  r.querySelector(".sub").textContent = sub;
  if (button) { const b = el("button", "play"); b.type = "button"; b.textContent = button.label; b.addEventListener("click", button.click); r.append(b); }
  return r;
}
const clock = (t) => {
  const d = new Date(t), today = d.toDateString() === new Date().toDateString();
  return d.toLocaleString(LANG === "en" ? "en-US" : "ko-KR", today ? { hour: "numeric", minute: "2-digit" } : { month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
};

const text = (tag, cls, s) => { const n = el(tag, cls); n.textContent = s; return n; }; // names come from devices: never as HTML
const icon = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
// What a device has, by the service's names, as the app says them.
const CAN = { speak: "스피커", lamp: "조명", talk: "음성", photo: "카메라", "sound level": "소리 크기", "motion sensors": "움직임 센서", location: "위치" };
// The round picture of a thing: what kind of device it is (a phone, a tablet), or what one of its parts is.
const PIC = {
  phone: "M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM11 18h2",
  tablet: "M6 3h12a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM11 18h2",
  talk: "M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM5 11a7 7 0 0 0 14 0M12 18v3",
  lamp: "M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z",
  speak: "M4 10v4h4l5 4V6L8 10H4zM16.5 8.5a5 5 0 0 1 0 7",
  photo: "M4 8h3l2-3h6l2 3h3v11H4zM12 9.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 0 0 0-7z",
  "sound level": "M3 12h2M7 8v8M11 5v14M15 9v6M19 11v2",
  "motion sensors": "M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18zM15.5 8.5l-2 5-5 2 2-5z",
  location: "M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21zM12 7a2.5 2.5 0 1 0 0 5a2.5 2.5 0 0 0 0-5z",
  pose: "M4 19h16M6 15l12-6", // how it lies: a tilted line over the ground
  brightness: "M12 8a4 4 0 1 0 0 8a4 4 0 0 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4", // a sun
  motion: "M3 12h4l3-7 4 14 3-7h4", // when it last moved
};
const picture = (pic) => el("span", "pic", icon(PIC[pic] ?? PIC.phone));
function backToMenu() {
  const b = el("button", "back", icon("M15 6l-6 6 6 6"));
  b.type = "button"; b.append("메뉴");
  b.addEventListener("click", closePage);
  return b;
}
$("settings-back").addEventListener("click", closePage);
// The settings page: its categories first, and one opened shows only its own settings; back shows the
// categories again, each with what it is set to now.
function showCat(cat) {
  $("settings-body").querySelector(".cat-home").hidden = !!cat;
  for (const n of document.querySelectorAll("#settings .cat")) n.hidden = n.dataset.cat !== cat;
  if (!cat) renderSums();
  $("settings").scrollTop = 0;
  enter($("settings-body"), "forward");
}
for (const b of document.querySelectorAll("#settings .cat-row")) b.addEventListener("click", () => showCat(b.dataset.cat));
for (const b of document.querySelectorAll("#settings .cat-back")) b.addEventListener("click", () => showCat(b.dataset.back ?? ""));
$("voice-row").addEventListener("click", () => showCat("voice-pick"));
// The menu's tabs, remembered on this device.
const menuTab = (tab) => { menu.dataset.tab = tab; localStorage.setItem("kkachi.menuTab", tab); };
const pickMenuTab = (tab) => { menuTab(tab); for (const i of document.querySelectorAll("input[name=menu-tab]")) i.checked = i.value === tab; };
for (const input of document.querySelectorAll("input[name=menu-tab]")) {
  input.checked = input.value === (localStorage.getItem("kkachi.menuTab") || "chat");
  input.addEventListener("change", () => menuTab(input.value));
}
menu.dataset.tab = localStorage.getItem("kkachi.menuTab") || "chat";
const iconButton = (path, label, click) => { const b = el("button", "icon-btn", icon(path)); b.type = "button"; b.setAttribute("aria-label", label); b.addEventListener("click", click); return b; };
const switchFor = (on, label, flip) => {
  const sw = el("button", "switch", "<i></i>");
  sw.type = "button"; sw.setAttribute("role", "switch"); sw.setAttribute("aria-checked", String(on)); sw.setAttribute("aria-label", label);
  sw.addEventListener("click", () => { const now = sw.getAttribute("aria-checked") !== "true"; sw.setAttribute("aria-checked", String(now)); flip(now); }); // moves at once
  return sw;
};

// ---- the devices: listed in the menu; one opened is a page with its room and what Kkachi may use ----
let devices = [], listed = true, opened = null; // as last read; listed: the list came; opened: the device on its page
const reading = new Map(); // device id → { sensors, sound, photo }: each null (reading), an object, or { error }
let reach = null; // the last answer from home: "ok", "devices" (home answers, its device list did not) or "down"
async function loadDevices() {
  const res = await fetch("/api/device/list").catch(() => null);
  const r = res?.ok ? await res.json().catch(() => null) : null;
  listed = !!r;
  reach = r ? "ok" : res ? "devices" : "down";
  if (r) devices = r.devices;
  renderHome();
  renderMenuDevices();
  renderPage();
}
function renderHome() {
  const b = $("home"), on = devices.filter((d) => d.allowed && d.online).length;
  const [cls, words] = reach === "down" ? ["no", "집에 연결할 수 없어요"] : reach === "devices" ? ["off", "집, 기기 목록을 못 읽었어요"]
    : ["ok", devices.length ? t("집, 기기 {n}대 켜짐", { n: on }) : "집"];
  b.classList.toggle("down", reach === "down");
  b.replaceChildren(el("span", `dot ${cls}`), words);
  b.setAttribute("aria-label", t("{words}. 기기 보기", { words: t(words) }));
}
$("home").addEventListener("click", () => { pickMenuTab("devices"); setMenu(true); });
const stateOf = (d) => (!d.allowed ? "허용을 기다려요" : !d.online ? "꺼져 있어요" : !d.armed ? "켜져 있어요. 화면을 한 번 눌러야 소리를 써요" : "켜져 있어요");
const shortState = (d) => (!d.allowed ? "허용을 기다려요" : !d.online ? "꺼져 있어요" : !d.armed ? "화면을 한 번 눌러야 해요" : "켜져 있어요");
const CHEV = '<span class="chev" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg></span>';
let menuDrawn = "";
function renderMenuDevices() {
  const key = JSON.stringify([devices, listed]);
  if (key === menuDrawn) return; // redrawing under a finger loses the tap
  menuDrawn = key;
  const rows = devices.map((d) => {
    const r = el(d.allowed ? "button" : "div", "device item", '<span><span class="name"></span><span class="sub"></span></span>');
    r.querySelector(".name").textContent = d.name;
    r.querySelector(".sub").textContent = shortState(d);
    r.prepend(picture(d.kind));
    if (!d.online || !d.allowed) r.classList.add("off");
    if (d.allowed) {
      r.type = "button";
      const dot = el("span", `dot ${!d.online ? "off" : d.armed ? "ok" : "wait"}`); dot.setAttribute("aria-hidden", "true"); // the words say it
      r.append(dot);
      r.insertAdjacentHTML("beforeend", CHEV);
      r.addEventListener("click", () => openPage("device", d.id));
    } else {
      const allow = text("button", "play allow", "허용");
      allow.type = "button"; allow.setAttribute("aria-label", t("{name} 허용", { name: d.name }));
      allow.addEventListener("click", async () => { const res = await fetch(`/api/device/${d.id}/allow`, { method: "POST" }); if (res.ok) { devices = (await res.json()).devices; renderMenuDevices(); } else toast("허용하지 못했어요"); });
      r.append(allow);
    }
    return r;
  });
  $("menu-devices").replaceChildren(...(!listed ? [el("div", "loading", "기기 목록을 불러오지 못했어요")]
    : rows.length ? rows : [el("div", "loading", "아직 없어요. 기기 추가에서 붙여요")]));
}
$("add-device").addEventListener("click", () => openPage("add"));
$("open-settings").addEventListener("click", () => openPage("settings"));

// The page showing, unless nothing it shows has changed: redrawing under a finger loses the tap.
let drawn = "";
function renderPage() {
  const view = page(), d = devices.find((x) => x.id === opened);
  if (view !== "device" && view !== "add") return;
  const key = JSON.stringify([view, opened, view === "device" && [devices, listed, d && reading.get(d.id)]]);
  if (key === drawn) return;
  drawn = key;
  if (view === "add") renderAdd();
  else if (d) renderDevice(d);
  else closePage(); // it was deleted
}

// Adding a device: what to do on the spare phone, and the address to open there, to copy.
function renderAdd() {
  const url = `${location.origin}/device`;
  const address = el("div", "address");
  const copy = text("button", "play", "복사");
  copy.type = "button"; copy.setAttribute("aria-label", "주소 복사");
  copy.addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(url); copy.textContent = "복사했어요"; setTimeout(() => (copy.textContent = "복사"), 1600); }
    catch { getSelection().selectAllChildren(address.querySelector(".url")); toast("주소를 길게 눌러 복사해 주세요"); } // no clipboard: the address is selected
  });
  address.append(text("span", "url", url), copy);
  const steps = el("ol", "steps");
  for (const [title, words] of [
    ["이 주소를 여세요", "안 쓰는 폰이나 태블릿의 Safari 나 Chrome 에서요. 그 기기도 이 폰과 같은 Tailscale 계정에 로그인해 있어야 열려요."],
    ["이름을 붙이고 화면을 한 번 누르세요", "거실, 주방처럼 둔 곳의 이름이 좋아요. 그때 마이크, 카메라, 움직임, 위치 권한을 한꺼번에 물어요."],
    ["여기서 허용하세요", "메뉴의 기기 탭에 허용을 기다리는 기기로 나타나요."],
    ["화면을 켜 두세요", "자동 잠금을 꺼 두고 충전기에 꽂아 두면 좋아요."],
  ]) { const li = el("li"); li.append(text("span", "name", title), text("span", "sub", words)); steps.append(li); }
  $("devices-body").replaceChildren(backToMenu(), text("h1", "", "기기 추가"), text("p", "lede", "안 쓰는 폰이나 태블릿이 그 방에서 까치의 눈과 귀와 입이 돼요. 앱은 깔지 않아요."), address, steps);
}

// What is happening in a device's room, read when it is opened (POST /api/device/<id>/read).
async function read(id, what) {
  const r = await fetch(`/api/device/${id}/read`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ what }) }).catch(() => null);
  const body = await r?.json().catch(() => null);
  return r?.ok && body ? body : { error: body?.error ?? "읽지 못했어요" };
}
function readRoom(id, whats = ["sensors", "sound", "brightness"]) {
  const d = devices.find((x) => x.id === id);
  if (!d?.online) return;
  const now = { ...reading.get(id) };
  for (const w of whats) now[w] = null;
  reading.set(id, now);
  for (const w of whats) read(id, w).then((v) => { reading.set(id, { ...reading.get(id), [w]: v }); renderPage(); });
}
// A reading, as words: [words, down?]. The device's own reasons ("not allowed yet (tap the screen)") are
// turned into the app's.
const why = (reason = "") => (/tap|armed|탭/i.test(reason) ? "기기 화면을 한 번 눌러야 해요" : /denied|not allowed|권한/i.test(reason) ? "권한이 없어요" : /offline/i.test(reason) ? "기기가 꺼져 있어요" : "읽을 수 없어요");
const POSE = { "flat, screen up": "화면이 위로 누워 있어요", "flat, screen down": "화면이 아래로 엎어져 있어요", "standing upright": "세워져 있어요", "on its side": "옆으로 누워 있어요", tilted: "기울어져 있어요" };
const compass = (deg) => ["북", "북동", "동", "남동", "남", "남서", "서", "북서"][Math.round(deg / 45) % 8];
function roomRows(r = {}, name = "") {
  const s = r.sensors, sound = r.sound, rows = [];
  const add = (pic, name, words, down = false) => { const x = row(name, words); x.classList.add("cap"); x.prepend(picture(pic)); if (down) x.querySelector(".sub").classList.add("down"); rows.push(x); };
  const light = r.brightness;
  const LIGHT = { dark: "어두워요. 불이 꺼진 것 같아요", dim: "어둑해요", lit: "불이 켜진 방 정도로 밝아요", bright: "밝아요", daylight: "햇빛처럼 아주 밝아요" };
  add("brightness", "밝기", light === null ? "재는 중…" : light?.error ? why(light.error) : light ? (light.lux != null ? t("{words}. 약 {lux} lx", { words: t(LIGHT[light.level] ?? ""), lux: light.lux }) : LIGHT[light.level] ?? "") : "", !!light?.error);
  add("sound level", "소리", sound === null ? "재는 중…" : sound?.error ? why(sound.error) : sound ? (sound.peak > -25 && sound.avg < -35 ? t("{words}. 가끔 큰 소리가 나요", { words: t(sound.avg < -55 ? "조용해요" : "보통이에요") }) : sound.avg < -55 ? "조용해요" : sound.avg < -35 ? "보통이에요" : "시끄러워요") : "", !!sound?.error);
  const motionWords = s === null ? "읽는 중…" : s?.error ? why(s.error) : s?.lastMovedAgoSec != null ? (s.lastMovedAgoSec < 5 ? "지금 움직이고 있어요" : (s.lastMovedAgoSec < 90 ? t("{n}초 전에 움직였어요", { n: s.lastMovedAgoSec }) : t("{n}분 전에 움직였어요", { n: Math.round(s.lastMovedAgoSec / 60) }))) : s?.motion ? "페이지를 연 뒤로 움직이지 않았어요" : why(s?.unavailable?.motion);
  add("motion", "움직임", motionWords, !!s?.error);
  if (s && !s.error) {
    add("pose", "놓인 자세", s.pose ? (s.heading != null ? t("{pose}. {dir}쪽을 봐요", { pose: t(POSE[s.pose] ?? s.pose), dir: t(compass(s.heading)) }) : POSE[s.pose] ?? s.pose) : why(s.unavailable?.orientation));
    if (s.location) { // a place on a map says more than numbers
      const { lat, lon, accuracy } = s.location;
      const x = row("위치", t("알아요. 오차 {m} m", { m: Math.round(accuracy) }), { label: "지도", click: () => open(`https://maps.apple.com/?ll=${lat},${lon}&q=${encodeURIComponent(name)}`, "_blank", "noopener") });
      x.classList.add("cap"); x.prepend(picture("location")); rows.push(x);
    } else add("location", "위치", why(s.unavailable?.location));
  }
  return rows;
}
function renderDevice(d) {
  const r = reading.get(d.id) ?? {};
  const parts = [backToMenu(), text("h1", "", d.name), text("p", "lede", d.online ? `${t(stateOf(d))}${LANG === "en" ? "" : "."}` : "꺼져 있어요. 그 기기에서 기기 페이지를 열어 두면 다시 켜져요.")];
  if (d.online) {
    const head = el("div", "title-row sub-head");
    head.append(text("h2", "", "지금 이 방"), iconButton("M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7", "다시 읽기", () => readRoom(d.id, ["sensors", "sound", "brightness", ...(r.photo ? ["photo"] : [])])));
    const room = el("div", "group");
    room.append(...roomRows(r, d.name));
    const shot = row("사진", r.photo === null ? "찍는 중…" : r.photo?.error ? why(r.photo.error) : r.photo ? "방금 찍었어요" : "뒤쪽 카메라로 한 장 찍어요. 저장하지 않아요", r.photo === null ? null : { label: r.photo ? "다시 찍기" : "찍기", click: () => readRoom(d.id, ["photo"]) });
    shot.classList.add("cap"); shot.prepend(picture("photo"));
    if (r.photo?.error) shot.querySelector(".sub").classList.add("down");
    room.append(shot);
    parts.push(head, room);
    if (r.photo?.data) { const im = new Image(); im.className = "room-photo"; im.src = `data:image/jpeg;base64,${r.photo.data}`; im.alt = t("{name}에서 방금 찍은 사진", { name: d.name }); parts.push(im); }
    parts.push(text("p", "note", "기기 화면의 기록에 까치 홈에서 읽었다고 남아요."));
  }
  // What Kkachi may use there: chosen here and nowhere else (POST /api/device/<id>/agent).
  const may = el("div", "group");
  const caps = ["talk", "speak", ...(d.kind === "tablet" ? ["lamp"] : []), "photo", "sound level", "motion sensors", "location"];
  may.append(...caps.map((c) => {
    const works = d.can.includes(c), x = row(CAN[c] ?? c, !d.online ? "" : works ? "" : !d.armed && ["speak", "talk", "sound level"].includes(c) ? "기기 화면을 한 번 눌러야 써요" : "이 기기에서 쓸 수 없어요");
    x.classList.add("cap"); x.prepend(picture(c));
    if (!d.agent?.[c]) x.classList.add("off");
    else if (d.online && !works) x.classList.add("idle");
    x.append(switchFor(!!d.agent?.[c], t("까치가 {name} {cap}을(를) 쓰기", { name: d.name, cap: t(CAN[c] ?? c).toLowerCase() }), async (on) => {
      x.classList.toggle("off", !on);
      const res = await fetch(`/api/device/${d.id}/agent`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cap: c, open: on }) });
      await sleep(SETTLE);
      if (res.ok) devices = (await res.json()).devices; else toast("바꾸지 못했어요");
      drawn = ""; renderPage(); // a refusal: the switch goes back
    }));
    return x;
  }));
  parts.push(text("h2", "", "까치가 쓸 수 있는 것"), may, text("p", "note", "음성을 끄면 그 기기의 말하기 버튼이 사라져요."));
  const forget = text("button", "plain-btn danger", "이 기기 삭제");
  forget.type = "button";
  forget.addEventListener("click", async () => {
    if (!confirm(t("'{name}' 기기를 삭제할까요? 다시 쓰려면 그 기기에서 처음부터 다시 붙여야 해요.", { name: d.name }))) return;
    const res = await fetch(`/api/device/${d.id}/forget`, { method: "POST" });
    if (!res.ok) { toast("삭제하지 못했어요"); return; }
    devices = (await res.json()).devices; reading.delete(d.id); closePage();
  });
  parts.push(forget);
  $("devices-body").replaceChildren(...parts);
}

const post = (url, body) => fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  .then(async (r) => ({ ok: r.ok, ...(await r.json().catch(() => ({}))) })).catch(() => ({ ok: false }));
const field = (label, input) => { const f = el("label", "field"); f.append(text("span", "", label), input); return f; };
const inputOf = (type, placeholder = "", value = "") => { const i = el(type === "textarea" ? "textarea" : "input"); if (type !== "textarea") i.type = type; i.placeholder = placeholder; i.value = value; i.autocomplete = "off"; i.spellcheck = false; return i; };
const button = (label, click, cls = "play") => { const b = text("button", cls, label); b.type = "button"; b.addEventListener("click", click); return b; };
const actions = (...items) => { const a = el("div", "actions"); a.append(...items); return a; };

// ---- accounts (Settings, 계정; src/accounts.ts): signing in to a subscription or entering a key ----
let accountList = [], flowFor = null; // flowFor: the account being connected, its form under the list
const CONNECTED = { subscription: "구독으로 연결됨", key: "API 키로 연결됨", env: "서버 설정으로 연결됨" };
async function loadAccounts() {
  const r = await fetch("/api/accounts").then((x) => (x.ok ? x.json() : null)).catch(() => null);
  if (!r) { $("accounts").replaceChildren(el("div", "loading", "불러오지 못했어요")); return; }
  accountList = r.accounts;
  renderAccounts();
  if (r.login && !["done", "error"].includes(r.login.step)) { flowFor = r.login.id; showLogin(r.login); } // one already going
  renderSums();
}
function renderAccounts() {
  $("accounts").replaceChildren(...accountList.map((a) => {
    const stored = a.connected === "subscription" || a.connected === "key";
    const r = row(a.name, a.connected ? CONNECTED[a.connected] : a.note, stored
      ? { label: "연결 해제", click: () => signOut(a) }
      : { label: "연결", click: () => connect(a) });
    if (!a.connected) r.classList.add("off");
    return r;
  }));
}
async function signOut(a) {
  if (!confirm(t("{name} 연결을 해제할까요?", { name: a.name }))) return;
  const r = await post("/api/accounts/signout", { id: a.id });
  if (!r.ok) { toast("해제하지 못했어요"); return; }
  accountList = r.accounts; renderAccounts(); renderSums(); toast("연결을 해제했어요");
}
const flowBox = () => $("account-flow");
function flowPanel(title, ...parts) {
  const box = flowBox();
  box.className = "flow";
  box.replaceChildren(text("h3", "", title), ...parts);
  box.scrollIntoView({ block: "nearest", behavior: "smooth" });
}
function closeFlow() { flowFor = null; flowBox().replaceChildren(); }
const cancelFlow = () => button("취소", () => { post("/api/accounts/cancel", {}); closeFlow(); });
function connect(a) {
  flowFor = a.id;
  if (a.ways.length > 1) flowPanel(t("{name} 연결", { name: a.name }), actions(button("구독으로 로그인", () => signIn(a), "play primary"), button("API 키 넣기", () => keyForm(a)), cancelFlow()));
  else if (a.ways[0] === "subscription") signIn(a);
  else keyForm(a);
}
function keyForm(a) {
  const key = inputOf("password", "API 키");
  const err = el("p", "err"); err.hidden = true;
  const save = async () => {
    if (!key.value.trim()) return;
    const r = await post("/api/accounts/key", { id: a.id, key: key.value });
    if (!r.ok) { err.textContent = "저장하지 못했어요"; err.hidden = false; return; }
    accountList = r.accounts; closeFlow(); renderAccounts(); renderSums(); toast(t("{name} 연결했어요", { name: a.name }));
  };
  key.addEventListener("keydown", (e) => { if (e.key === "Enter") save(); });
  flowPanel(t("{name} API 키", { name: a.name.replace(/ API$/, "") }), field("API 키", key), err, actions(button("저장", save, "play primary"), cancelFlow()));
  key.focus();
}
async function signIn(a) {
  flowFor = a.id;
  flowPanel(t("{name} 로그인", { name: a.name }), text("p", "note", "로그인 준비 중…"));
  const r = await post("/api/accounts/login", { id: a.id });
  if (flowFor !== a.id) return;
  showLogin(r.login ?? { id: a.id, step: "error", error: r.error });
}
// Where the sign-in is: Claude gives a code to paste back here, ChatGPT a code to type on its page.
function showLogin(l) {
  const a = accountList.find((x) => x.id === l.id) ?? { name: l.id };
  if (l.step === "done") { closeFlow(); toast(t("{name} 연결했어요", { name: a.name })); loadAccounts(); openSettings(); return; }
  if (l.step === "error") {
    flowPanel(t("{name} 로그인", { name: a.name }), text("p", "err", t("연결하지 못했어요. {error}", { error: t(l.error ?? "") }).trim()), actions(button("다시 시도", () => signIn(a), "play primary"), cancelFlow()));
    return;
  }
  const open = el("a", "play primary"); open.href = l.url ?? "#"; open.target = "_blank"; open.rel = "noopener noreferrer";
  if (l.step === "code") {
    open.textContent = "로그인 페이지 열기";
    const code = inputOf("text", "코드");
    const err = el("p", "err"); err.hidden = true;
    const send = async () => {
      if (!code.value.trim()) return;
      const r = await post("/api/accounts/code", { code: code.value });
      if (!r.ok || r.login?.step === "error") { err.textContent = t("코드가 맞지 않아요. {error}", { error: r.login?.error ?? "" }).trim(); err.hidden = false; if (r.login?.step === "error") showLogin(r.login); return; }
      showLogin(r.login);
    };
    code.addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
    flowPanel(t("{name} 로그인", { name: a.name }),
      text("p", "note", "1. 로그인 페이지에서 로그인하세요. 끝나면 코드가 나와요."), actions(open),
      text("p", "note", "2. 그 코드를 복사해서 여기에 붙여 넣으세요."), field("코드", code), err,
      actions(button("확인", send, "play primary"), cancelFlow()));
    return;
  }
  if (l.step === "device") {
    open.textContent = "OpenAI 페이지 열기";
    flowPanel(t("{name} 로그인", { name: a.name }),
      text("p", "note", "1. OpenAI 페이지를 열고 로그인하세요."), actions(open),
      text("p", "note", "2. 이 코드를 넣고 승인하세요. 승인하면 저절로 연결돼요."), text("div", "user-code", l.userCode ?? ""),
      actions(cancelFlow()));
  } else flowPanel(t("{name} 로그인", { name: a.name }), text("p", "note", "확인하는 중…"), actions(cancelFlow()));
  waitForLogin(l.id); // until it is done, or given up
}
let waiting = null;
function waitForLogin(id) {
  clearTimeout(waiting);
  waiting = setTimeout(async () => {
    if (flowFor !== id || page() !== "settings") return;
    const r = await fetch("/api/accounts").then((x) => (x.ok ? x.json() : null)).catch(() => null);
    if (flowFor !== id) return;
    if (r?.login && r.login.step !== "device" && r.login.step !== "starting") showLogin(r.login);
    else if (!r?.login) { closeFlow(); loadAccounts(); } // it ended elsewhere
    else waitForLogin(id);
  }, 2000);
}

// ---- tools (Settings, 도구; src/mcp-servers.ts): Kkachi's own, the ones added, and what to add ----
const MCP_NAME = { devices: "기기", memory: "노트" };
let mcp = null, adding = null; // adding: the suggestion (or "own") whose form is open
async function loadMcp(fresh = false) {
  const r = await fetch(`/api/mcp${fresh ? "?fresh" : ""}`).then((x) => (x.ok ? x.json() : null)).catch(() => null);
  if (!r) { for (const id of ["mcp-builtin", "mcp-added"]) $(id).replaceChildren(el("div", "loading", "불러오지 못했어요")); return; }
  mcp = r; renderMcp(); renderSums();
}
const toolState = (s) => (!s.enabled ? ["꺼 둠"] : s.state === "connected" ? [t("연결됨. 도구 {n}개", { n: s.tools })] : s.state === "needs-auth" ? ["로그인이 필요해요", true]
  : s.state === "failed" ? [s.error ? t("연결하지 못했어요. {why}", { why: s.error.split("\n")[0].slice(0, 80) }) : "연결하지 못했어요", true] : ["확인하는 중…"]);
function renderMcp() {
  $("mcp-builtin").replaceChildren(...mcp.builtin.map((s) => {
    const r = row(MCP_NAME[s.name] ?? s.name, s.ok ? t("연결됨. 도구 {n}개", { n: s.tools }) : "응답이 없어요");
    if (!s.ok) r.querySelector(".sub").classList.add("down");
    return r;
  }));
  $("mcp-added").replaceChildren(...(mcp.added.length ? mcp.added.map((s) => {
    const [words, down] = toolState(s);
    const r = row(s.title, words);
    if (down) r.querySelector(".sub").classList.add("down");
    if (!s.enabled) r.classList.add("off");
    r.append(actions(
      ...(s.enabled && s.state === "needs-auth" ? [button("로그인", () => mcpSignIn(s, "tools"))] : []),
      iconButton("M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13", t("{name} 삭제", { name: t(s.title) }), () => removeTool(s)),
      switchFor(s.enabled, t("{name} 쓰기", { name: t(s.title) }), (on) => changeTool("enable", { name: s.name, on }))));
    return r;
  }) : [el("div", "loading", "아직 없어요")]));
  const rows = [];
  for (const s of mcp.suggested.filter((x) => !x.added && x.group === "home")) {
    rows.push(row(s.name, `${t(s.by)}. ${t(s.note)}`, adding === s.id ? null : { label: "추가", click: () => { adding = s.id; renderMcp(); } }));
    if (adding === s.id) rows.push(suggestedForm(s));
  }
  rows.push(row("직접 추가", "주소나 실행 명령으로 다른 MCP 서버를 붙여요", adding === "own" ? null : { label: "추가", click: () => { adding = "own"; renderMcp(); } }));
  if (adding === "own") rows.push(ownForm());
  $("mcp-suggest").replaceChildren(...rows);
  renderServices();
}

// ---- services (Settings, 계정): the user's own accounts elsewhere, as MCP servers (src/mcp-servers.ts,
// group "service"). Added, each of its servers is a row: signed in, or a 로그인 button. ----
let serviceForm = null; // the service whose form is open
function renderServices() {
  if (!mcp) return;
  const rows = [];
  for (const s of mcp.suggested.filter((x) => x.group === "service")) {
    const mine = mcp.added.filter((a) => a.suggested === s.id);
    if (!mine.length) {
      rows.push(row(s.name, `${t(s.by)}. ${t(s.note)}`, serviceForm === s.id ? null : { label: "연결", click: () => { serviceForm = s.id; renderServices(); } }));
      if (serviceForm === s.id) rows.push(serviceFormFor(s));
      continue;
    }
    for (const a of mine) {
      const [words, down] = toolState(a);
      const r = row(a.title, words);
      if (down) r.querySelector(".sub").classList.add("down");
      r.append(actions(
        ...(a.enabled && a.state === "needs-auth" ? [button("로그인", () => mcpSignIn(a, "services"), "play primary")] : []),
        button("연결 해제", async () => { if (confirm(t("{name} 연결을 해제할까요?", { name: t(a.title) })) && (await changeTool("remove", { name: a.name }))) toast("연결을 해제했어요"); })));
      rows.push(r);
    }
  }
  $("services").replaceChildren(...rows);
}
function serviceFormFor(s) {
  const inputs = s.fields.map((x) => [x.key, inputOf(x.secret ? "password" : "text", x.placeholder ?? "", x.value ?? "")]);
  const boxes = (s.choices ?? []).map((c) => { const l = el("label"); l.innerHTML = '<input type="checkbox">'; l.append(c.label); l.querySelector("input").checked = !!c.on; return [c.key, l]; });
  const help = el("a"); help.href = s.help; help.target = "_blank"; help.rel = "noopener noreferrer"; help.textContent = s.fields.length ? "어디서 받나요?" : "자세히";
  const note = el("p", "note"); note.append(help);
  const parts = inputs.map(([k, i]) => field(s.fields.find((x) => x.key === k).label, i));
  if (boxes.length) { const c = el("div", "choices"); c.append(...boxes.map(([, l]) => l)); parts.push(c); }
  const f = formWith([...parts, note], async (fail) => {
    const values = { ...Object.fromEntries(inputs.map(([k, i]) => [k, i.value])), ...Object.fromEntries(boxes.map(([k, l]) => [k, l.querySelector("input").checked ? "on" : ""])) };
    const r = await post("/api/mcp/add", { suggested: s.id, values });
    if (!r.ok) { fail(r.error ?? "연결하지 못했어요"); return false; }
    mcp.added = r.added; mcp.suggested = mcp.suggested.map((x) => (x.id === s.id ? { ...x, added: true } : x));
    serviceForm = null; renderMcp(); renderSums();
    const first = r.added.find((a) => r.names.includes(a.name) && a.state === "needs-auth");
    if (first) mcpSignIn(first, "services"); // straight on to signing in
    return false; // the form is gone: nothing more for formWith to do
  });
  f.querySelector(".actions .play").textContent = "연결";
  f.querySelector(".actions .play:last-child").onclick = () => { serviceForm = null; renderServices(); };
  return f;
}

// Signing in to an MCP server from a phone (src/mcp-login.ts): open its page, sign in, and paste back
// the address the browser ends on (it cannot reach this computer, so it shows an error page).
async function mcpSignIn(a, where) {
  const box = $(where === "services" ? "service-flow" : "mcp-flow") ?? $("service-flow");
  const panel = (...parts) => { box.className = "flow"; box.replaceChildren(text("h3", "", t("{name} 로그인", { name: t(a.title) })), ...parts); box.scrollIntoView({ block: "nearest", behavior: "smooth" }); };
  const close = () => { clearTimeout(mcpWaiting); box.replaceChildren(); };
  const cancel = () => button("취소", () => { post("/api/mcp/login/cancel", {}); close(); });
  panel(text("p", "note", "로그인 준비 중…"));
  const r = await post("/api/mcp/login", { name: a.name });
  const show = (l) => {
    if (!l || l.step === "done") { close(); toast(t("{name} 연결했어요", { name: t(a.title) })); loadMcp(true); return; }
    if (l.step === "error") { panel(text("p", "err", t("연결하지 못했어요. {error}", { error: t(l.error ?? "") }).trim()), actions(button("다시 시도", () => mcpSignIn(a, where), "play primary"), cancel())); return; }
    if (l.step !== "open") { panel(text("p", "note", "확인하는 중…"), actions(cancel())); return; }
    const open = el("a", "play primary"); open.href = l.url; open.target = "_blank"; open.rel = "noopener noreferrer"; open.textContent = "로그인 페이지 열기";
    const back = inputOf("url", "http://127.0.0.1:…/callback?code=…");
    const err = el("p", "err"); err.hidden = true;
    const send = async () => {
      if (!back.value.trim()) return;
      panel(text("p", "note", "확인하는 중…"));
      const res = await post("/api/mcp/login/answer", { url: back.value });
      if (!res.ok) { show(l); const e = box.querySelector(".err"); e.textContent = res.error ?? "확인하지 못했어요"; e.hidden = false; return; }
      if (res.added) mcp.added = res.added;
      show(res.login);
    };
    back.addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
    panel(
      text("p", "note", "1. 로그인 페이지를 열고 로그인해서 허용하세요."), actions(open),
      text("p", "note", "2. 그러면 열리지 않는 페이지(127.0.0.1)로 넘어가요. 그 페이지의 주소를 통째로 복사해서 붙여 넣으세요."),
      field("주소", back), err, actions(button("확인", send, "play primary"), cancel()));
    waitMcp(a, show);
  };
  show(r.login ?? { step: "error", error: r.error });
}
let mcpWaiting = null;
function waitMcp(a, show) { // signed in on this computer's own browser: no address to paste
  clearTimeout(mcpWaiting);
  mcpWaiting = setTimeout(async () => {
    if (page() !== "settings") return;
    const r = await fetch("/api/mcp").then((x) => (x.ok ? x.json() : null)).catch(() => null);
    if (r?.login?.name === a.name && r.login.step === "open") return waitMcp(a, show);
    if (r) { mcp = r; renderMcp(); }
    if (r?.login?.name === a.name) show(r.login);
  }, 3000);
}
async function changeTool(what, body, done) {
  const r = await post(`/api/mcp/${what}`, body);
  if (!r.ok) { done?.(r.error ?? "바꾸지 못했어요"); if (!done) toast(r.error ?? "바꾸지 못했어요"); return false; }
  mcp.added = r.added; mcp.suggested = mcp.suggested.map((x) => ({ ...x, added: r.added.some((a) => a.name === x.id) }));
  renderMcp(); renderSums();
  return true;
}
async function removeTool(s) {
  if (!confirm(t("'{name}' 도구를 삭제할까요?", { name: t(s.title) }))) return;
  if (await changeTool("remove", { name: s.name })) toast("삭제했어요");
}
function formWith(parts, submit) {
  const f = el("div", "form");
  const err = el("p", "err"); err.hidden = true;
  const go = button("추가", async () => {
    go.disabled = true; go.textContent = "확인하는 중…"; // the new server is asked at once
    const ok = await submit((message) => { err.textContent = message; err.hidden = false; });
    go.disabled = false; go.textContent = "추가";
    if (ok) { adding = null; renderMcp(); toast("추가했어요. 다음 말부터 써요"); }
  }, "play primary");
  f.append(...parts, err, actions(go, button("취소", () => { adding = null; renderMcp(); })));
  return f;
}
function suggestedForm(s) {
  const inputs = s.fields.map((x) => [x.key, inputOf(x.secret ? "password" : "text", x.placeholder ?? "", x.value ?? "")]);
  const help = el("a"); help.href = s.help; help.target = "_blank"; help.rel = "noopener noreferrer"; help.textContent = "어디서 받나요?";
  const note = el("p", "note"); note.append(help);
  return formWith([...inputs.map(([k, i]) => field(s.fields.find((x) => x.key === k).label, i)), note],
    (fail) => changeTool("add", { suggested: s.id, values: Object.fromEntries(inputs.map(([k, i]) => [k, i.value])) }, fail));
}
function ownForm() {
  const name = inputOf("text", "my-server"), url = inputOf("url", "https://…/mcp"), token = inputOf("password", "없으면 비워 두세요");
  const command = inputOf("text", "npx -y some-mcp-server"), env = inputOf("textarea", "API_KEY=…");
  const kind = el("div", "segment two", '<label><input type="radio" name="own-kind" value="url" checked>주소</label><label><input type="radio" name="own-kind" value="command">명령</label>');
  kind.setAttribute("role", "radiogroup"); kind.setAttribute("aria-label", "붙이는 방법");
  const byUrl = el("div", "form"), byCommand = el("div", "form");
  byUrl.style.padding = byCommand.style.padding = "0";
  byUrl.append(field("주소", url), field("토큰", token));
  byCommand.append(field("실행 명령 (서버에서 실행돼요)", command), field("환경 변수 (한 줄에 하나씩)", env));
  byCommand.hidden = true;
  kind.addEventListener("change", () => { const c = kind.querySelector("input:checked").value === "command"; byCommand.hidden = !c; byUrl.hidden = c; });
  return formWith([field("이름 (영문, 숫자, -, _)", name), kind, byUrl, byCommand], (fail) => {
    const c = kind.querySelector("input:checked").value === "command";
    return changeTool("add", c ? { name: name.value, command: command.value, env: env.value } : { name: name.value, url: url.value, token: token.value }, fail);
  });
}

$("new-conversation").addEventListener("click", async () => {
  const r = await fetch("/api/new-conversation", { method: "POST" });
  if (!r.ok) { toast("새 대화를 시작하지 못했어요"); return; }
  turnId++; stopPlayback();
  clearTranscript(); shownConversation = null;
  document.body.dataset.view = "chat"; setMenu(false, false);
  ready();
  toast("새 대화를 시작했어요");
});

// ---- input: the mic button ----
// Tap to start and tap again to stop, or hold while speaking and let go. pointerdown's default is
// prevented so the text box keeps (or does not get) focus: no keyboard popping up on a phone.
const mic = $("mic");
let micDownAt = 0;
mic.addEventListener("pointerdown", (e) => {
  e.preventDefault();
  if (recording) { stopRecording(); return; } // second tap
  micDownAt = performance.now();
  startRecording();
});
mic.addEventListener("pointerup", () => { if (recording && performance.now() - micDownAt >= HOLD_MS) stopRecording(); }); // held
mic.addEventListener("contextmenu", (e) => e.preventDefault()); // no iOS long-press menu

// On a computer: hold Space to talk (when not typing).
const typing = (el) => el?.closest?.("dialog[open], input, select, textarea");
document.addEventListener("keydown", (e) => {
  if (e.code !== "Space" || e.repeat || typing(e.target) || !chatting()) return;
  e.preventDefault(); startRecording();
});
document.addEventListener("keyup", (e) => {
  if (e.code !== "Space" || typing(e.target) || !recording) return;
  e.preventDefault(); stopRecording();
});

// ---- input: the text box ----
// Enter sends, Shift+Enter is a new line. Enter that ends a Korean IME composition is not a send.
const say = $("say"), send = $("send");
const grow = () => {
  say.style.height = "auto";
  const border = say.offsetHeight - say.clientHeight; // scrollHeight leaves the border out
  say.style.height = `${Math.min(say.scrollHeight + border, 200)}px`; // as #say's max-height
  send.disabled = !say.value.trim() && !attached.length;
};

// ---- input: photos ----
// Pick or take pictures (iOS offers both). Scaled down to a JPEG here: phone photos are several MB.
const MAX_PHOTOS = 4, MAX_SIDE = 1600;
let attached = []; // { data: base64, mimeType }
async function shrink(file) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const url = canvas.toDataURL("image/jpeg", 0.85);
  return { data: url.slice(url.indexOf(",") + 1), mimeType: "image/jpeg" };
}
function renderAttachments() {
  $("attachments").replaceChildren(...attached.map((img, i) => {
    const thumb = el("div", "thumb");
    const im = new Image(); im.src = dataUrl(img); im.alt = t("첨부한 사진 {n}", { n: i + 1 });
    const remove = el("button"); remove.type = "button"; remove.textContent = "×"; remove.setAttribute("aria-label", "사진 빼기");
    remove.addEventListener("click", () => { attached.splice(i, 1); renderAttachments(); });
    thumb.append(im, remove);
    return thumb;
  }));
  grow();
}
$("photo-input").addEventListener("change", async (e) => {
  const picked = [...e.target.files];
  e.target.value = ""; // picking the same photo again still fires
  const files = picked.slice(0, MAX_PHOTOS - attached.length);
  if (picked.length > files.length) toast(t("사진은 {n}장까지 보낼 수 있어요", { n: MAX_PHOTOS }));
  for (const f of files) {
    try { attached.push(await shrink(f)); }
    catch (err) { diag("photo failed", { type: f.type, err: String(err) }); toast("이 사진은 열 수 없어요"); }
  }
  renderAttachments();
});
function addToDraft(text) {
  const draft = say.value.trimEnd();
  say.value = draft ? `${draft} ${text}` : text;
  grow();
}
say.addEventListener("input", grow);
say.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.shiftKey || e.isComposing || e.keyCode === 229) return;
  e.preventDefault(); $("compose").requestSubmit();
});
// The on-screen keyboard: iOS keeps the page full height and pans it up to the text box, pushing the
// header and the conversation out of sight. Keep the app exactly on the visible area instead, so the
// conversation shrinks above the text box (CSS: body height and offset).
//
// Typing has three cases, and the text box sits at the bottom of what can be seen in each:
// - the on-screen keyboard (it covers more than 80px): the text box sits on the keyboard. iOS reports the keyboard only once it has come up, so the height it had last time is
//   remembered and the text box goes up with it, not after it;
// - a keyboard joined to an iPhone or iPad: no keyboard comes up, but iOS floats a pill (previous, next,
//   done) over the bottom 58px of the screen, and the text box keeps clear of it;
// - a computer: nothing covers anything, and nothing changes.
const vv = window.visualViewport;
if (vv) {
  const root = document.documentElement.style;
  const IOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const PILL = 58;       // what iOS's pill takes at the bottom with a joined keyboard (10px under it, 48px tall)
  const SETTLE_MS = 500; // by then the on-screen keyboard has come up, if it is going to
  const typingNow = () => document.activeElement === say;
  let tallest = 0, settled = true, guess = null; // the most ever seen (nothing covering); the keyboard has had time to show; what is assumed until it has
  const remembered = () => localStorage.getItem("kkachi.keyboard"); // "hard", or the on-screen keyboard's height in px
  const fit = () => {
    // How tall the screen is with nothing over it. Some Android browsers shrink innerHeight with the
    // keyboard, so while typing on a touch screen it is the tallest seen; otherwise what it is now (a
    // computer's window can be made smaller, and that is no keyboard).
    const now = Math.max(vv.height, window.innerHeight);
    tallest = typingNow() && matchMedia("(pointer: coarse)").matches ? Math.max(tallest, now) : now;
    const real = Math.max(0, tallest - vv.height);
    if (real > 80) guess = null; // it is up: no more guessing
    const cover = guess ?? real;
    root.setProperty("--vv-height", `${tallest - cover}px`);
    // Follow the pan only as far as something covers the screen. Pulling past the end of the conversation
    // makes iOS bounce the page, which also moves offsetTop (below zero at the top): following that slid
    // the app the opposite way to the finger. The covered height is the limit, not a "keyboard is up"
    // guess: with an external keyboard only a short bar covers the screen, and the page can stay panned
    // from the on-screen keyboard that was there before. Not following that left the text box off screen.
    const covered = cover;
    root.setProperty("--vv-top", `${Math.min(Math.max(0, vv.offsetTop), covered)}px`);
    // The on-screen keyboard is up: the text box sits on it, with no room left for the home indicator.
    document.body.classList.toggle("kb", covered > 80);
    // A joined keyboard: known once the on-screen one has had time to come and did not, or at once when
    // that is how it went last time.
    const hard = IOS && typingNow() && real <= 80 && guess === null && (settled || remembered() === "hard");
    document.body.classList.toggle("hw", hard);
    root.setProperty("--pill", `${Math.max(0, PILL - real)}px`);
  };
  let settle;
  say.addEventListener("focus", () => {
    if (!matchMedia("(pointer: coarse)").matches) return; // a computer
    const last = Number(remembered());
    settled = false; guess = last > 80 ? last : null; // go up with the keyboard, to where it stopped last time
    fit();
    clearTimeout(settle);
    settle = setTimeout(() => { // what really happened, for next time
      settled = true; guess = null;
      const real = Math.max(0, tallest - vv.height);
      if (typingNow()) { localStorage.setItem("kkachi.keyboard", real > 80 ? String(Math.round(real)) : "hard"); diag("keyboard", { real: Math.round(real), h: Math.round(vv.height), inner: window.innerHeight, top: Math.round(vv.offsetTop) }); }
      fit(); scrollDown();
    }, SETTLE_MS);
  });
  say.addEventListener("blur", () => { clearTimeout(settle); settled = true; guess = null; fit(); });
  window.addEventListener("orientationchange", () => { tallest = 0; guess = null; setTimeout(fit, 300); });
  vv.addEventListener("resize", () => { // keyboard in or out: keep the latest message in view
    fit(); scrollDown();
    if (DEBUG) diag("viewport", { h: vv.height, top: vv.offsetTop, inner: window.innerHeight });
  });
  vv.addEventListener("scroll", fit);
  fit();
}

$("compose").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = say.value.trim();
  if (!text && !attached.length) return;
  const images = attached;
  attached = []; renderAttachments();
  say.value = ""; grow();
  sendMessage(text, images);
});

clearTranscript();
// ?demo=<state> renders a sample screen for design review (no audio, no requests).
const demo = new URLSearchParams(location.search).get("demo");
if (new URLSearchParams(location.search).get("theme") === "light") document.documentElement.dataset.theme = "light";
if (demo === "settings") openPage("settings");
else if (demo) {
  const hints = { recording: "듣고 있어요. 다시 누르면 받아적어요", transcribing: "받아적는 중…" };
  if (hints[demo]) setState(demo, hints[demo]);
  mic.style.setProperty("--level", "0.7");
  const sample = (you, reply) => { const v = addTurn(you); if (reply) { v.stream(reply); v.finish(); } return v; };
  if (demo === "draft") addToDraft("다음 주 화요일 저녁 7시에 엄마 졸업 연주회 있어");
  if (demo === "photo") {
    const c = document.createElement("canvas"); c.width = 320; c.height = 240;
    const g = c.getContext("2d"); g.fillStyle = "#cfe3dd"; g.fillRect(0, 0, 320, 240);
    g.fillStyle = "#2a7f74"; g.beginPath(); g.arc(160, 120, 70, 0, 7); g.fill();
    const img = { data: c.toDataURL("image/jpeg").split(",")[1], mimeType: "image/jpeg" };
    const v = addTurn("이거 무슨 식물이야?", [img]);
    v.stream("몰스테라예요. 밝은 간접광에 두고 겉흙이 마르면 물을 주세요."); v.finish();
    addTurn("", [img]).working("사진 보는 중");
    attached = [img, img]; renderAttachments();
    addToDraft("이 두 개 차이가 뭐야?");
  }
  if (demo === "speaking") {
    sample("오늘 서울 날씨 어때?", "서울은 지금 맑고 영하 1도예요.");
    const v = sample("친구 결혼식 언제였지?", "다다음 주 금요일, 12월 4일이에요. 축가는 성시경의 「거리에서」예요.");
    showChips(v.chips, ["a.md", "b.md"], ["b.md"], { "a.md": "친구 결혼식 축가", "b.md": "건강" });
  }
  if (demo === "thinking") {
    sample("오늘 서울 날씨 어때?", "서울은 지금 맑고 영하 1도예요.");
    sample("다음 주 일정 정리해줘").working("노트 찾는 중");
  }
  if (demo === "text") {
    const v = addTurn("이번 주 일정이랑 할 일 정리해줘");
    v.stream("노트에서 이번 주 일정을 찾아볼게요.");
    v.aside();
    v.stream("이번 주 일정이에요.\n\n| 날짜 | 일정 |\n|---|---|\n| 11월 24일 (화) 19:00 | 엄마 졸업 연주회 |\n| 11월 27일 (금) | 팀 회식 |\n\n**할 일**\n- 연주회 꽃다발 예약\n- `kkachi` 아이콘 수정\n\n연주회는 대경선으로 가면 돼요. 자세한 건 [노트](https://example.com)에 있어요.");
    v.finish();
    showChips(v.chips, ["a.md"], [], { "a.md": "엄마 졸업 연주회" });
  }
}

// ---- conversations (Pi's sessions, src/conversations.ts): the one going on is shown again when the
// app opens (iOS often closes a home-screen app), and the menu's 대화 tab lists them to go back to ----
let shownConversation = null;
const restored = new Set(); // device turns shown from the conversation: not again from the feed
let restoredAt = 0;
async function restoreConversation(id = null) {
  const r = await fetch(`/api/conversation${id ? `?id=${encodeURIComponent(id)}` : ""}`).then((x) => (x.ok ? x.json() : null)).catch(() => null);
  if (!r) return;
  shownConversation = r.id; restoredAt = Date.now();
  clearTranscript();
  for (const turn of r.turns.slice(-MAX_TURNS)) {
    const v = addTurn(turn.text + (turn.photos ? `${turn.text ? " " : ""}${t("(사진 {n}장)", { n: turn.photos })}` : ""), [], turn.from ? t("{from}에서", { from: turn.from }) : null);
    if (turn.reply) { v.stream(turn.reply); v.finish(); } else if (turn.failed) v.fail("답하지 못했어요"); else v.finish();
    if (turn.from) restored.add(`${turn.from}|${turn.text}`);
  }
  scrollDown(true);
}
async function loadConversations() {
  const r = await fetch("/api/conversations").then((x) => (x.ok ? x.json() : null)).catch(() => null);
  if (!r) { $("menu-history").replaceChildren(el("div", "loading", "불러오지 못했어요")); return; }
  $("menu-history").replaceChildren(...(r.list.length ? r.list.map((c) => {
    const now = c.id === r.current;
    const b = el("button", "device conv" + (now ? " current" : ""), '<span><span class="name"></span><span class="sub"></span></span>');
    b.type = "button";
    b.querySelector(".name").textContent = c.title;
    b.querySelector(".sub").textContent = now ? t("지금 대화. {when}", { when: clock(c.t) }) : clock(c.t);
    if (now) b.setAttribute("aria-current", "true");
    b.addEventListener("click", () => openConversation(c.id, now));
    return b;
  }) : [el("div", "loading", "아직 없어요")]));
}
async function openConversation(id, now) {
  if (!now) {
    const res = await fetch("/api/conversation/open", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) }).catch(() => null);
    if (!res?.ok) { toast("대화를 열지 못했어요"); return; }
    turnId++; stopPlayback();
  }
  if (!now || shownConversation !== id) await restoreConversation(id);
  document.body.dataset.view = "chat"; setMenu(false, false); ready();
}

// ---- the feed (docs/bus.md): conversations on spare devices and messages sent to the phone ----
// Listened to while the app is open. The last event id is kept, so reopening shows what came
// meanwhile; only fresh items are read aloud.
// iOS can leave an EventSource "open" after the app was away, receiving nothing and never erroring:
// so it is opened anew whenever the app comes back, and again when the server's ping (every 15 s) has
// not come for 40 s.
let feed = null, feedSeen = 0, feedWatch = null;
function openFeed() {
  if (demo || document.visibilityState !== "visible") return;
  closeFeed();
  const last = localStorage.getItem("kkachi.feed");
  feed = new EventSource(`/api/feed${last ? `?last=${encodeURIComponent(last)}` : ""}`);
  feedSeen = Date.now();
  feed.onopen = () => (feedSeen = Date.now());
  feed.addEventListener("ping", () => (feedSeen = Date.now()));
  feed.onmessage = (e) => {
    feedSeen = Date.now();
    if (e.lastEventId) localStorage.setItem("kkachi.feed", e.lastEventId);
    const item = JSON.parse(e.data);
    if (item.kind !== "hello") showFeedItem(item);
  };
  feedWatch = setInterval(() => { if (Date.now() - feedSeen > 40_000) { diag("feed went quiet; opening it again"); openFeed(); } }, 10_000);
}
function closeFeed() { clearInterval(feedWatch); feed?.close(); feed = null; }
addEventListener("pageshow", (e) => { if (e.persisted) openFeed(); }); // back from the page cache
function showFeedItem(item) {
  // A turn the restored conversation already has (it came while the app was closed); a later one is new.
  if (item.kind === "turn" && restored.has(`${item.from}|${item.heard}`) && Date.parse(item.at) <= restoredAt) return;
  const v = item.kind === "turn" ? addTurn(item.heard, [], t("{from}에서", { from: item.from })) : addTurn("", [], "까치가 보냈어요", true);
  v.stream(item.text || "");
  v.finish();
  scrollDown(true); // said elsewhere: easy to miss below, so it is brought into view
  const fresh = Date.now() - Date.parse(item.at) < 15_000;
  if (item.speak && fresh && readAloud() && ctx && item.text) spoken(item.text).then((buf) => buf && play(buf));
}
restoreConversation().finally(openFeed); // the conversation first, then what came meanwhile
// The voice setting decides how replies are read aloud, so it is needed before the first one.
fetch("/api/settings").then((r) => r.json()).then((j) => { saved ??= j.settings; useLang(j.settings.lang); }).catch(() => {});
function useLang(lang) {
  if (!lang || lang === LANG) return;
  localStorage.setItem("kkachi.lang", lang);
  location.reload();
}

document.addEventListener("visibilitychange", () => {
  diag("visibility " + document.visibilityState);
  if (document.visibilityState === "hidden") { stopRecording(); resetAudio(); closeFeed(); } // iOS will cut the mic anyway; keep what was said
  // Back in the app: the turn stream may be dead without having errored yet. Restart it now; it
  // resumes from the last event received (see followTurn).
  else { liveStream?.abort(); openFeed(); loadDevices(); }
});
