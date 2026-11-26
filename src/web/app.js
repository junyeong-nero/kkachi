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
  if (builtInVoice()) { const u = new SpeechSynthesisUtterance(" "); u.volume = 0; speechSynthesis.speak(u); } // iOS: the built-in voice too wants a tap first
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
        await (buf.say ? sayBuiltIn(buf.say) : play(buf));
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
      else if (e.type === "photo") view.photo(e);
      else if (e.type === "done") { view.finish(); showChips(view.chips, e.sources, e.changed, e.titles); }
      else if (e.type === "error") { view.fail(e.message); if (speak) queue.push(spoken(e.message)); earcon.error(); }
    });
    view.finish();
  } catch (e) {
    streamDone = true;
    diag("turn error", { err: String(e) });
    if (my === turnId) { view.fail("연결이 끊겼어요. 다시 보내 주세요."); earcon.error(); }
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
  const device = { device_snapshot: "사진 찍는 중", device_sound_level: "소리 듣는 중", device_sensors: "기기 살펴보는 중", device_light: "조명 바꾸는 중", device_speak: "기기로 말하는 중" }[tool];
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
  return {
    chips,
    working(label) { work.hidden = false; work.querySelector(".label").textContent = label; scrollDown(); },
    stream(delta) { work.hidden = true; raw += delta; if (!frame) frame = requestAnimationFrame(render); }, // one render per frame
    aside() {
      render();
      if (raw.trim()) { block.classList.add("aside"); block = el("div", "md"); reply.insertBefore(block, work); }
      raw = ""; work.hidden = false;
    },
    finish() {
      if (frame) render();
      work.hidden = true;
      if (!raw.trim()) block.remove();
      if (!reply.querySelector(".md, .err, .photos")) reply.hidden = true; // only actions, no words: no empty bubble
    },
    photo(img) { const p = el("div", "photos"); const im = new Image(); im.src = dataUrl(img); im.alt = "기기가 찍은 사진"; p.append(im); reply.insertBefore(p, work); scrollDown(); },
    fail(message) { if (frame) render(); work.hidden = true; reply.hidden = false; reply.append(el("p", "err")); reply.lastChild.textContent = message; scrollDown(); },
  };
}

function clearTranscript() { $("log").replaceChildren(); }

// Notes used for the answer; remembered ones (changed this turn) are highlighted.
function showChips(container, sources, changed, titles = {}) {
  const chips = sources.map((p) => {
    const el = document.createElement("span");
    const remembered = changed.includes(p);
    el.className = "chip" + (remembered ? " changed" : "");
    const name = titles[p] ?? p.replace(/\/index\.md$|\.md$/, "").split("/").pop();
    el.textContent = remembered ? `기억함: ${name}` : name;
    return el;
  });
  container.replaceChildren(...chips);
  scrollDown();
}

// ---- audio out ----
// With the voice "device" (기기 목소리) the phone speaks with its own voice (Web Speech API) and
// no words go to the server for speech; any other voice is made on the server, one sentence at a time.
const builtInVoice = () => saved?.voice === "device" && "speechSynthesis" in window;
if ("speechSynthesis" in window) speechSynthesis.getVoices(); // browsers fill the list only once asked
const spoken = (text) => (builtInVoice() ? Promise.resolve({ say: text }) : ttsBuffer(text));

function sayBuiltIn(text, rate = saved?.rate ?? 0) {
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "ko-KR";
    const ko = speechSynthesis.getVoices().filter((v) => /^ko([-_]|$)/i.test(v.lang));
    u.voice = ko.find((v) => v.localService) ?? ko[0] ?? null; // made on the phone first (desktop browsers also offer online ones)
    u.rate = Math.max(0.5, Math.min(2, 1 + rate / 100));
    u.onend = u.onerror = () => resolve();
    speechSynthesis.speak(u);
  });
}

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

// ---- settings, and refresh beside its heading (a home-screen web app has no reload button) ----
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
const providerLabel = { openai: "OpenAI", anthropic: "Anthropic", "claude-pro-max-native": "Claude (구독)", openrouter: "OpenRouter 무료" };

// Text size is a per-device preference (a phone and a laptop want different sizes), kept in
// localStorage as the body font size in px; every other size scales with it.
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
  for (const input of document.querySelectorAll("input[name=speak]")) {
    input.checked = input.value === (readAloud() ? "on" : "off");
    input.onchange = () => { localStorage.setItem("kkachi.speak", input.value); applySpeak(); toast("저장했어요"); };
  }
  applySpeak();
}

function applySpeak() {
  $("voice-settings").hidden = !readAloud();
  if (!readAloud() && !recording) { stopPlayback(); resetAudio(); setSession("auto"); } // nothing holds audio now
}

// Spare phones and tablets joined at /device: allow new ones, forget old ones. Each shows what
// Kkachi can use there now (allowed and switched on, on the device's own screen).
const CAN = { speak: "스피커", lamp: "조명", talk: "음성", photo: "카메라", "sound level": "소리 크기", "motion sensors": "가속도 센서", location: "위치", dial: "다이얼", click: "버튼" };
function renderDevices(devices) {
  $("device-url").textContent = `${location.origin}/device`;
  if (!devices.length) { $("devices").replaceChildren(el("div", "loading", "아직 없어요")); return; }
  $("devices").replaceChildren(...devices.map((d) => {
    const row = el("div", "device", '<span><span class="name"></span><span class="sub"></span></span><button type="button" class="play"></button>');
    row.querySelector(".name").textContent = d.name;
    const can = (d.can ?? []).map((c) => CAN[c] ?? c).join(", ") || "쓸 수 있는 기능 없음";
    row.querySelector(".sub").textContent = !d.allowed ? "허용을 기다려요" : !d.online ? "꺼져 있음" : `연결됨. 쓸 수 있는 기능: ${can}${d.armed ? "" : ". 기기 화면을 한 번 눌러 주세요"}`;
    const btn = row.querySelector("button");
    btn.textContent = d.allowed ? "삭제" : "허용";
    if (!d.allowed) btn.classList.add("allow");
    btn.addEventListener("click", async () => {
      if (d.allowed && !confirm(`'${d.name}' 기기를 삭제할까요?`)) return;
      const r = await fetch(`/api/device/${d.id}/${d.allowed ? "forget" : "allow"}`, { method: "POST" });
      if (r.ok) renderDevices((await r.json()).devices); else toast("바꾸지 못했어요");
    });
    return row;
  }));
}

// What is said to a spare device (docs/bus.md): one segmented control per option.
const DEVICE_TALK_NOTE = {
  all: "공기계에서 한 말이 이 대화에 이어지고, 여기와 같은 도구를 써요. 내 MCP(Claude Code 등에서 가져온 서버)는 공기계도일 때만 써요.",
  own: "도구가 전체면 공기계에 말하는 누구나 명령을 실행시킬 수 있어요. 내 MCP 는 공기계도일 때만 써요. 제한이면 노트, 말하기, 조명만 써요.",
};
function renderDeviceTalk(options, s) {
  for (const [key, choices] of Object.entries(options)) {
    $(key).replaceChildren(...choices.map((c) => {
      const l = document.createElement("label");
      l.innerHTML = `<input type="radio" name="${key}">`;
      l.append(c.name);
      const input = l.querySelector("input");
      input.checked = c.id === s[key];
      input.addEventListener("change", async () => {
        await saveSettings({ [key]: c.id });
        showDeviceTalk(saved);
      });
      return l;
    }));
  }
  showDeviceTalk(s);
}
function showDeviceTalk(s) {
  const shared = s.deviceSession === "all"; // Kkachi Home's session: its tools, and it never starts over
  $("device-own-session").hidden = shared;
  $("device-talk-note").textContent = shared ? DEVICE_TALK_NOTE.all : DEVICE_TALK_NOTE.own;
}

async function openSettings() {
  renderTextSize();
  renderDevicePrefs();
  fetch("/api/device/list").then((r) => r.json()).then((j) => renderDevices(j.devices)).catch(() => {});
  const r = await fetch("/api/settings");
  if (!r.ok) { toast("설정을 불러오지 못했어요"); return; }
  const { settings: s, voices, thinking, models, fallbacks, deviceOptions } = await r.json();
  saved = s;

  $("voices").replaceChildren(...voices.map((v) => {
    const row = document.createElement("label");
    row.className = "voice";
    row.innerHTML = `<input type="radio" name="voice" value="${v.id}"><span><span class="name"></span><span class="sub"></span></span><button type="button" class="play">들어보기</button>`;
    row.querySelector(".name").textContent = v.name;
    row.querySelector(".sub").textContent = v.note;
    const input = row.querySelector("input");
    input.checked = v.id === s.voice;
    input.addEventListener("change", () => saveSettings({ voice: v.id }));
    row.querySelector(".play").addEventListener("click", (e) => { e.preventDefault(); preview(v.id); });
    return row;
  }));

  const rate = $("rate");
  rate.value = s.rate; $("rate-out").textContent = rateLabel(s.rate);
  rate.oninput = () => ($("rate-out").textContent = rateLabel(Number(rate.value)));
  rate.onchange = () => saveSettings({ rate: Number(rate.value) });

  renderDeviceTalk(deviceOptions, s);

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
  $("fallbacks").textContent = others.length ? `이 모델이 막히면 ${others.map((m) => m.split("/").pop()).join(", ")} 순서로 넘어가요.` : "";
}

async function preview(voice) {
  audioOut();
  stopPlayback();
  if (voice === "device") { sayBuiltIn("안녕하세요, 까치예요. 오늘도 반가운 소식 전해 드릴게요.", Number($("rate").value)); return; }
  try {
    const r = await fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "안녕하세요, 까치예요. 오늘도 반가운 소식 전해 드릴게요.", voice, rate: Number($("rate").value) }) });
    if (!r.ok) throw new Error("tts " + r.status);
    play(await ctx.decodeAudioData(await r.arrayBuffer()));
  } catch (e) { toast("목소리를 불러오지 못했어요"); }
}

// ---- screens, switched in the bar at the bottom: 입력, 출력, 연결 (opens first), 에이전트 (talk to it, what it
// was used for, its MCP servers) and 설정 ----
const chatting = () => document.body.dataset.tab === "agent" && document.body.dataset.pane === "chat";
// Motion (DESIGN.md, Motion): what a screen does when it is arrived at. tab: it fades in; forward and
// back: it also comes 12px from the side it was opened from. Reduced motion keeps the fade only (CSS).
function enter(node, how) {
  node.classList.remove("in-tab", "in-forward", "in-back");
  void node.offsetWidth; // start again, also when the last one has not finished
  node.classList.add(`in-${how}`);
}
const SETTLE = 160; // a switch finishes moving before its list is drawn again
function show(tab, pane = document.body.dataset.pane) {
  const moved = document.body.dataset.tab !== tab || document.body.dataset.pane !== pane;
  document.body.dataset.tab = tab; document.body.dataset.pane = pane;
  $("nav").style.setProperty("--tab", [...$("nav").children].findIndex((b) => b.dataset.tab === tab)); // where the bar's pill slides to
  for (const b of $("nav").children) { if (b.dataset.tab === tab) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current"); }
  for (const i of document.querySelectorAll("input[name=pane]")) i.checked = i.value === pane;
  if (tab === "settings") openSettings();
  else if (tab !== "agent") { renderHome(); loadHome(); }
  else if (pane === "chat") scrollDown(true);
  else if (pane === "history") loadHistory();
  else if (pane === "resources") { loadResources(); openSettings(); } // the settings about answering devices live on this screen too
  else loadMcp();
  if (moved) enter(tab in view ? $(`${tab}-body`) : tab === "settings" ? $("settings").firstElementChild : pane === "chat" ? $("log") : $(pane === "mcp" ? "mcp-pane" : pane).firstElementChild, "tab");
}
for (const b of $("nav").children) b.addEventListener("click", () => {
  const tab = b.dataset.tab;
  if (document.body.dataset.tab === tab && view[tab]) openView(tab, null); // the same tab again: back to its grid
  show(tab);
});
for (const i of document.querySelectorAll("input[name=pane]")) i.addEventListener("change", () => show("agent", i.value));

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
  return d.toLocaleString("ko-KR", today ? { hour: "numeric", minute: "2-digit" } : { month: "long", day: "numeric", hour: "numeric", minute: "2-digit" });
};

// ---- 입력, 출력, 연결: what is joined to Kkachi, read again every few seconds while one is on screen ----
const INPUTS = ["talk", "dial", "click", "photo", "sound level", "motion sensors", "location"], OUTPUTS = ["speak", "lamp"];
const KINDS = { inputs: INPUTS, outputs: OUTPUTS }, TAB_NAME = { inputs: "입력", outputs: "출력", links: "연결" };
let devices = [], links = [], listed = true; // as last read; listed: the device list came
// What can be joined straight to an output: what it does there, and which output that is (a lamp, or a
// speaker that plays what was said as it was recorded, like a walkie-talkie).
const JOINS = { talk: "스피커", dial: "조명 밝기", click: "조명 켜고 끄기" };
const OUT = { talk: { output: "speak", can: "speak", pic: "speak" }, dial: { output: "light", can: "lamp", pic: "lamp" }, click: { output: "light", can: "lamp", pic: "lamp" } };
// What is open on each screen. 입력 and 출력: a device's id (null: the grid). 연결: the link being made,
// { from, kind } (null: the cards).
const view = { inputs: null, outputs: null, links: null };
function openView(tab, what) { view[tab] = what; renderHome(); $(tab).scrollTop = 0; enter($(`${tab}-body`), what ? "forward" : "back"); }

const text = (tag, cls, s) => { const n = el(tag, cls); n.textContent = s; return n; }; // names come from devices: never as HTML
const icon = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${d}"/></svg>`;
const grid = (tiles) => { const g = el("div", "tiles"); g.append(...tiles); return g; };
// The round picture of a thing: what kind of device it is (a phone, a tablet, and a lamp or a switch
// once such devices are joined), what an input or output is, or the agent's mark ("kkachi").
const PIC = {
  phone: "M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM11 18h2",
  tablet: "M6 3h12a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM11 18h2",
  switch: "M7 3h10a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM10 8h4v8h-4zM10 12h4",
  talk: "M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM5 11a7 7 0 0 0 14 0M12 18v3",
  dial: "M12 4a8 8 0 1 0 0 16a8 8 0 0 0 0-16zM12 12l3.5-3.5",
  click: "M12 4a8 8 0 1 0 0 16a8 8 0 0 0 0-16zM12 9a3 3 0 1 0 0 6a3 3 0 0 0 0-6z",
  lamp: "M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z",
};
Object.assign(PIC, {
  light: PIC.lamp, // a device that is a lamp
  speak: "M4 10v4h4l5 4V6L8 10H4zM16.5 8.5a5 5 0 0 1 0 7",
  photo: "M4 8h3l2-3h6l2 3h3v11H4zM12 9.5a3.5 3.5 0 1 0 0 7a3.5 3.5 0 0 0 0-7z",
  "sound level": "M3 12h2M7 8v8M11 5v14M15 9v6M19 11v2",
  "motion sensors": "M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18zM15.5 8.5l-2 5-5 2 2-5z",
  location: "M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21zM12 7a2.5 2.5 0 1 0 0 5a2.5 2.5 0 0 0 0-5z",
});
PIC.agent = "M4 5h16v11H9l-5 4z"; // the agent: the same mark as its tab in the bar at the bottom
const picture = (pic) => el("span", "pic", icon(PIC[pic] ?? PIC.phone));
function tile(pic, name, sub, click, off) {
  const b = el("button", off ? "tile off" : "tile");
  b.type = "button"; b.append(picture(pic), text("span", "name", name), text("span", "sub", sub));
  b.addEventListener("click", click);
  return b;
}
function back(tab) {
  const b = el("button", "back", icon("M15 6l-6 6 6 6"));
  b.type = "button"; b.append(TAB_NAME[tab]);
  b.addEventListener("click", () => openView(tab, null));
  return b;
}

// A spare device: a tile on 입력 and on 출력, opening what it can send or take right now. This app is not
// one of them: it is where they are looked after.
// One light for whether something can be used, the same everywhere: green (ok) it can, red (no) it
// cannot, grey (off) it is not switched on. The words are for screen readers and a long press.
function light(level, words) {
  const s = el("span", `dot ${level}`);
  s.setAttribute("role", "img"); s.setAttribute("aria-label", words); s.title = words;
  return s;
}
function capState(d, c) { // [ok | no | off, words]
  if (!d.online) return ["off", "기기가 꺼져 있어요"];
  if (d.can.includes(c)) return ["ok", "쓸 수 있어요"];
  if (!d.armed && ["speak", "talk", "sound level"].includes(c)) return ["no", "쓸 수 없어요. 기기 화면을 한 번 눌러야 해요"];
  return ["no", "쓸 수 없어요. 권한이 없거나 이 기기가 지원하지 않아요"];
}
// What a device has, of these. A phone is not a lamp: a lit lamp is the whole screen, and on a phone it
// lay over the pads and took their touches. A tablet can be one.
const has = (d, caps) => caps.filter((c) => c !== "lamp" || d.kind !== "phone");
function capRow(pic, name, level, words) { // a title and its light: no description
  const r = row(name, "");
  r.classList.add("cap"); if (level !== "ok") r.classList.add("off");
  r.prepend(picture(pic));
  r.append(light(level, words));
  return r;
}
function renderGrid(tab) {
  const body = $(`${tab}-body`), kinds = KINDS[tab], d = devices.find((x) => x.id === view[tab]);
  if (!d) {
    view[tab] = null;
    const count = (x) => x.can.filter((c) => kinds.includes(c)).length;
    const sub = (x) => (!x.allowed ? "허용을 기다려요" : !x.online ? "꺼져 있어요" : count(x) ? `${count(x)}개 쓸 수 있어요` : "지금 쓸 수 있는 게 없어요");
    body.replaceChildren(
      text("h1", "", TAB_NAME[tab]),
      grid(devices.map((x) => {
        const t = tile(x.kind, x.name, sub(x), () => openView(tab, x.id), !x.online || !x.allowed);
        t.append(light(!x.allowed ? "no" : x.online && count(x) ? "ok" : "off", sub(x)));
        return t;
      })),
      ...(!listed ? [text("p", "note", "기기 목록을 불러오지 못했어요.")]
        : devices.length ? [] : [text("p", "note", `아직 기기가 없어요. 안 쓰는 폰이나 태블릿에서 ${location.origin}/device 를 열면 여기에 나타나요.`)]));
    return;
  }
  const group = el("div", "group");
  group.append(...has(d, kinds).map((c) => capRow(c, CAN[c] ?? c, ...capState(d, c))));
  const parts = [back(tab), text("h1", "", d.name), text("p", "lede", !d.allowed ? "아직 허용하지 않은 기기예요. 허용해야 쓸 수 있어요."
    : d.online ? "켜져 있어요." : "꺼져 있어요. 그 기기에서 기기 페이지를 열어 두면 다시 켜져요.")];
  if (!d.allowed) {
    const allow = text("button", "play allow", "이 기기 허용");
    allow.type = "button";
    allow.addEventListener("click", async () => { const r = await fetch(`/api/device/${d.id}/allow`, { method: "POST" }); if (r.ok) loadHome(); else toast("바꾸지 못했어요"); });
    parts.push(allow);
  }
  const legend = el("p", "legend");
  for (const [level, words] of [["ok", "쓸 수 있어요"], ["no", "쓸 수 없어요"], ["off", "꺼져 있어요"]]) { const item = el("span"); item.append(el("span", `dot ${level}`), words); legend.append(item); }
  parts.push(group, legend, text("p", "note", "기기를 지우려면 설정으로 가세요."));
  body.replaceChildren(...parts);
}

// Open one of a device's inputs or outputs to the agent, or close it. Its voice to the agent shows as a
// connection; the outputs the agent may use are on the agent screen (자원).
// after: what is moving on screen meanwhile (a switch, a row leaving); the list is drawn again once it has.
async function setAgent(d, cap, open, after) {
  const r = await fetch(`/api/device/${d.id}/agent`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cap, open }) });
  await after;
  if (!r.ok) { toast("바꾸지 못했어요"); drawn = ""; renderHome(); return false; } // drawn again: the switch goes back
  devices = (await r.json()).devices;
  renderHome();
  return true;
}
async function setLink(l, action, after) { // on | off | remove
  const r = await fetch(`/api/routes/${l.id}/${action}`, { method: "POST" });
  await after;
  if (!r.ok) { toast("바꾸지 못했어요"); drawn = ""; renderHome(); return; }
  links = (await r.json()).routes; renderHome();
}
// How a connection is doing, as words: [words, class].
function linkWords(it, last) {
  if (!it.on) return ["꺼 두었어요", ""];
  if (it.gone) return ["받는 기기가 꺼져 있어요", ""];
  if (last?.error) return ["전달하지 못했어요", "down"];
  if (!last) return [{ dial: "값을 기다려요", click: "누르기를 기다려요", talk: "말하기를 기다려요" }[it.kind], ""];
  return [it.kind === "dial" ? `마지막 값 ${last.value}` : `${clock(last.at)}에 ${it.kind === "click" ? "눌렀어요" : it.agent ? "들었어요" : "전했어요"}`, ""];
}
// What goes through the connections, as it happens (GET /api/flow, server-sent events; core's
// src/flow.ts): the row's words change and a dot runs along its arrow. Listened to while the app is on
// screen; on opening, the latest of each comes first, marked old (nothing moves for those).
const keptOff = new Set(JSON.parse(localStorage.getItem("kkachi.agentOff") || "[]")); // devices whose voice-to-agent row stays listed while off
const saveKept = () => localStorage.setItem("kkachi.agentOff", JSON.stringify([...keptOff]));
const flowLast = new Map(), flowRows = new Map(); // by key (a link's id, or agent:<device id>): the latest flow; the row drawn now
let flow = null, editing = false; // editing: the rows show remove in place of their switches
let swapped = false, shownLinks = null, homeLoaded = false; // 편집 was just pressed; the connections listed last time (null: not yet); the lists have come once
const calm = matchMedia("(prefers-reduced-motion: reduce)");
function openFlow() {
  if (flow || demo || document.visibilityState !== "visible") return;
  flow = new EventSource("/api/flow");
  flow.onmessage = (e) => {
    const f = JSON.parse(e.data), row = flowRows.get(f.key);
    flowLast.set(f.key, f);
    if (!row) return;
    const [words, cls] = linkWords(row.it, f);
    row.state.textContent = words; row.state.className = `sub ${cls}`;
    if (f.old || !row.it.on) return;
    row.wire.classList.remove("flow", "failed");
    void row.wire.offsetWidth; // start the run again, also when the last one has not finished
    row.wire.classList.add(f.error ? "failed" : "flow");
  };
}
function closeFlow() { flow?.close(); flow = null; }
function renderLinks() {
  const body = $("links-body");
  if (view.links) { renderNewLink(body); return; }

  // A routing table, grouped by input, because one input can go to several places. Each input is
  // written once; under it, every place it goes to, joined to it by a wire that branches: the agent (a
  // voice only: it is so on a new device, and it is what makes the agent answer) or an output of another
  // device (a voice to a speaker, a dial or a button to a lamp). Each place has how it is doing under its
  // name and a switch; 편집 turns the switches into remove.
  const byId = new Map(devices.map((d) => [d.id, d]));
  const newer = (a, b) => (!a ? b : !b ? a : a.at > b.at ? a : b); // the latest of what the list and the live stream said
  const groups = new Map(); // by "<device id>:<kind>"
  const group = (id, kind) => {
    const k = `${id}:${kind}`;
    if (!groups.has(k)) groups.set(k, { key: k, d: byId.get(id), kind, dests: [] });
    return groups.get(k);
  };
  for (const d of devices.filter((x) => x.allowed && (x.agent?.talk || keptOff.has(x.id)))) group(d.id, "talk").dests.push({
    key: `agent:${d.id}`, kind: "talk", agent: true, on: !!d.agent?.talk, last: flowLast.get(`agent:${d.id}`),
    pic: "agent", name: "에이전트", what: `${d.name} 음성에서 에이전트로 가는 연결`,
    // Switched off, the row stays (remembered by this app) so it can be switched back on; removed, it goes.
    toggle: (on, after) => { if (on) keptOff.delete(d.id); else keptOff.add(d.id); saveKept(); setAgent(d, "talk", on, after); },
    remove: (after) => { keptOff.delete(d.id); saveKept(); if (d.agent?.talk) setAgent(d, "talk", false, after); else after.then(() => { drawn = ""; renderHome(); }); },
  });
  for (const l of links) {
    const kind = l.from.kind, to = byId.get(l.to.device), name = `${to?.name ?? "없는 기기"} ${JOINS[kind]}`;
    group(l.from.device, kind).dests.push({
      key: l.id, kind, on: l.on !== false, last: newer(flowLast.get(l.id), l.last), gone: !to?.online,
      pic: OUT[kind].pic, name, what: `${byId.get(l.from.device)?.name ?? "없는 기기"} ${CAN[kind]}에서 ${name}로 가는 연결`, // every JOINS name ends in a vowel
      toggle: (on, after) => setLink(l, on ? "on" : "off", after), remove: (after) => setLink(l, "remove", after),
    });
  }
  const ORDER = ["talk", "dial", "click"];
  const sorted = [...groups.values()].sort((a, b) => (a.d?.name ?? "").localeCompare(b.d?.name ?? "", "ko") || ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));

  // What moves here (DESIGN.md, Motion). A connection that was not listed last time has its wire drawn;
  // with 편집 the controls come in one after another; and what was already on screen slides to where it
  // is now (after one is removed, or one is added above it) instead of jumping.
  const listed = homeLoaded ? shownLinks : null, was = new Map(); // where each group and row was, by key
  if (!calm.matches) for (const n of body.querySelectorAll("[data-key]")) { const r = n.getBoundingClientRect(); if (r.height) was.set(n.dataset.key, r.top); }
  if (homeLoaded) shownLinks = new Set(sorted.flatMap((g) => g.dests.map((it) => it.key)));
  let nth = 0;

  flowRows.clear();
  const list = el("div", "routes");
  list.append(...sorted.map((g) => {
    const route = el("section", "route"), src = el("div", g.d?.online && g.d.can.includes(g.kind) ? "src" : "src off"), dests = el("ul", "dests");
    src.append(el("span", "ico", icon(PIC[g.kind])), text("span", "name", g.d?.name ?? "없는 기기"), text("span", "kind", g.d && !g.d.online ? `${CAN[g.kind]}, 꺼져 있어요` : CAN[g.kind]));
    dests.append(...g.dests.map((it) => {
      const li = el("li", it.on ? "dest" : "dest off"), [w, cls] = linkWords(it, it.last), words = el("span", "words"), state = text("span", `sub ${cls}`, w);
      words.append(text("span", "name", it.name), state);
      const control = editing ? el("button", "play", icon("M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5")) : el("button", "switch", "<i></i>"); // a bin
      control.type = "button";
      li.dataset.key = it.key;
      if (listed && !listed.has(it.key)) li.classList.add("fresh");
      if (swapped) { control.classList.add("pop"); control.style.animationDelay = `${Math.min(nth++, 6) * 20}ms`; }
      if (editing) {
        control.setAttribute("aria-label", `${it.what} 삭제`);
        control.addEventListener("click", () => {
          if (!confirm(`${it.what}을 삭제할까요?`)) return;
          (g.dests.length === 1 ? route : li).classList.add("leaving"); // the last one takes its group with it
          it.remove(sleep(SETTLE));
        });
      } else {
        control.setAttribute("role", "switch"); control.setAttribute("aria-checked", String(it.on)); control.setAttribute("aria-label", it.what);
        control.addEventListener("click", () => { // shown at once, here, so the switch is seen to move; the list is drawn again after
          it.on = !it.on;
          control.setAttribute("aria-checked", String(it.on)); li.classList.toggle("off", !it.on);
          const [w2, cls2] = linkWords(it, newer(flowLast.get(it.key), it.last));
          state.textContent = w2; state.className = `sub ${cls2}`;
          it.toggle(it.on, sleep(SETTLE));
        });
      }
      li.append(el("span", "branch", "<i></i>"), el("span", "ico", icon(PIC[it.pic])), words, control); // <i>: the dot that runs along the wire
      flowRows.set(it.key, { it, state, wire: li.querySelector(".branch") });
      return li;
    }));
    route.dataset.key = g.key;
    route.append(src, dests);
    return route;
  }));
  swapped = false;

  const head = el("div", "title-row"), tools = el("div", "tools"), add = el("button", "icon-btn", icon("M12 5v14M5 12h14"));
  if (!sorted.length) editing = false;
  else {
    const edit = text("button", "text-btn", editing ? "완료" : "편집");
    edit.type = "button"; edit.setAttribute("aria-pressed", String(editing));
    edit.addEventListener("click", () => { editing = !editing; swapped = true; renderHome(); });
    tools.append(edit);
  }
  add.type = "button"; add.setAttribute("aria-label", "새 연결");
  add.addEventListener("click", () => { editing = false; openView("links", { from: null, kind: null }); });
  tools.append(add);
  head.append(text("h1", "", "연결"), tools);
  body.replaceChildren(head, sorted.length ? list : text("p", "lede", "아직 없어요. 위의 + 로 입력을 에이전트나 다른 기기의 출력에 이어요."));
  const slide = (n, dy) => { if (Math.abs(dy) > 1) n.animate([{ transform: `translateY(${dy}px)` }, { transform: "none" }], { duration: 260, easing: "cubic-bezier(.22, 1, .36, 1)" }); };
  if (was.size) for (const route of list.children) {
    const dy = was.has(route.dataset.key) ? was.get(route.dataset.key) - route.getBoundingClientRect().top : 0;
    const rows = [...route.querySelectorAll(".dest")].filter((li) => was.has(li.dataset.key)).map((li) => [li, was.get(li.dataset.key) - li.getBoundingClientRect().top - dy]); // within its group
    slide(route, dy);
    for (const [li, d] of rows) slide(li, d);
  }
}
// Making a link, one choice at a time: the input it starts from, then the output it goes to.
function renderNewLink(body) {
  const inputs = devices.filter((d) => d.allowed).flatMap((d) => Object.keys(JOINS).map((kind) => ({ d, kind })));
  const from = inputs.find((i) => i.d.id === view.links.from && i.kind === view.links.kind);
  const parts = [back("links"), text("h1", "", "새 연결"), text("h2", "", "어떤 입력에서 시작할까요?")];
  if (!inputs.length) parts.push(text("p", "note", "아직 기기가 없어요."));
  else parts.push(grid(inputs.map((i) => {
    const t = tile(i.kind, i.d.name, CAN[i.kind], () => { view.links = { from: i.d.id, kind: i.kind }; renderHome(); }, !i.d.can.includes(i.kind));
    t.setAttribute("aria-pressed", String(i === from));
    return t;
  })));
  const join = async (to) => {
    const r = await fetch("/api/routes", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from: { device: from.d.id, kind: from.kind }, to }) });
    if (!r.ok) { toast("잇지 못했어요"); return; }
    links = (await r.json()).routes; toast("이었어요"); openView("links", null);
  };
  if (from) {
    // A voice goes to the agent or to another device's speaker; a dial or a button to a lamp.
    const talk = from.kind === "talk", out = OUT[from.kind];
    const ends = devices.filter((d) => d.allowed && !(talk && d.id === from.d.id) && has(d, [out.can]).length).map((d) =>
      tile(out.pic, d.name, d.online ? JOINS[from.kind] : "꺼져 있어요", () => join({ device: d.id, output: out.output }), !d.online));
    if (talk && !from.d.agent?.talk) ends.unshift(tile("agent", "에이전트", "대화", async () => { if (await setAgent(from.d, "talk", true)) { toast("이었어요"); openView("links", null); } }));
    parts.push(text("h2", "", "어디로 보낼까요?"), ends.length ? grid(ends) : text("p", "note", talk ? "보낼 다른 기기가 아직 없어요." : "조명으로 쓸 수 있는 기기가 아직 없어요. 태블릿만 조명이 될 수 있어요."));
  }
  body.replaceChildren(...parts);
}

// Draw the screen that is showing, unless nothing it shows has changed: redrawing under a finger loses the tap.
let drawn = "";
function renderHome() {
  const tab = document.body.dataset.tab;
  if (!(tab in view)) return;
  const key = JSON.stringify([tab, view[tab], devices, links, listed, editing]);
  if (key === drawn) return;
  drawn = key;
  if (tab === "links") renderLinks(); else renderGrid(tab);
}
async function loadHome() {
  const json = (url) => fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const [list, routes] = await Promise.all([json("/api/device/list"), json("/api/routes")]);
  listed = !!list;
  if (list) devices = list.devices;
  if (routes) links = routes.routes;
  if (list && routes && !homeLoaded) { homeLoaded = true; drawn = ""; } // drawn once more, to note what is listed: nothing is new yet
  renderHome();
}
setInterval(() => { if (document.body.dataset.tab in view && document.visibilityState === "visible") loadHome(); }, 5000);
show("links");

// 에이전트 › 자원: the outputs the agent may use, device by device (its speaker, its lamp), each with a
// switch. Chosen here and nowhere else (POST /api/device/<id>/agent); a new device starts with them open.
// What reaches the agent (a voice) is a connection, on the 연결 screen.
async function loadResources() {
  const r = await fetch("/api/device/list").then((x) => (x.ok ? x.json() : null)).catch(() => null);
  if (r) devices = r.devices;
  renderResources(!!r);
}
function renderResources(got = true) {
  const mine = devices.filter((d) => d.allowed);
  if (!mine.length) { $("resource-list").replaceChildren(text("p", "note", got ? "아직 기기가 없어요." : "기기 목록을 불러오지 못했어요.")); return; }
  const group = (d, caps) => {
    const g = el("div", "group");
    g.append(...caps.map((c) => {
      const open = !!d.agent?.[c], r = row(CAN[c] ?? c, ""), sw = el("button", "switch", "<i></i>");
      r.classList.add("cap"); if (!open) r.classList.add("off");
      r.prepend(picture(c));
      sw.type = "button"; sw.setAttribute("role", "switch"); sw.setAttribute("aria-checked", String(open)); sw.setAttribute("aria-label", `에이전트가 ${d.name} ${CAN[c] ?? c}을(를) 쓰기`);
      sw.addEventListener("click", async () => { // shown at once, so the switch is seen to move
        sw.setAttribute("aria-checked", String(!open)); r.classList.toggle("off", open);
        await setAgent(d, c, !open, sleep(SETTLE));
        renderResources();
      });
      r.append(sw);
      return r;
    }));
    return g;
  };
  $("resource-list").replaceChildren(text("h2", "", "에이전트가 쓰는 출력"), ...mine.flatMap((d) => [text("h3", "", d.name), group(d, has(d, OUTPUTS))]));
}

// What the agent was used for (GET /api/agent): the latest turns, from this app and the spare devices.
async function loadHistory() {
  try {
    const r = await fetch("/api/agent");
    if (!r.ok) throw new Error("agent " + r.status);
    const { uses, model } = await r.json();
    $("model-note").textContent = `모델 ${model}`;
    $("uses").replaceChildren(...(uses.length ? uses.map((u) => {
      const how = u.error ? "답하지 못했어요" : u.aborted ? "중간에 멈췄어요" : `${(u.ms / 1000).toFixed(1)}초 걸렸어요${u.tools ? `. 도구를 ${u.tools}번 썼어요` : ""}`;
      const r = row(u.text || "(말 없이 사진만)", `${clock(u.t)}, ${u.from ?? "까치 홈"}. ${how}`);
      r.classList.add("use");
      if (u.error) r.querySelector(".sub").classList.add("down");
      return r;
    }) : [el("div", "loading", "아직 없어요")]));
  } catch {
    $("uses").replaceChildren(el("div", "loading", "불러오지 못했어요"));
  }
}

// The MCP servers Kkachi can use (GET /api/mcp): its own, with whether each answers now, and the ones
// registered in the user's Pi.
const MCP_NAME = { devices: "기기", memory: "노트", ha: "Home Assistant" };
async function loadMcp() {
  const rows = (list, sub) => (list.length ? list.map((s) => {
    const r = row(MCP_NAME[s.name] ?? s.name, sub(s));
    if (s.ok === false) r.querySelector(".sub").classList.add("down");
    return r;
  }) : [el("div", "loading", "없어요")]);
  try {
    const r = await fetch("/api/mcp");
    if (!r.ok) throw new Error("mcp " + r.status);
    const { servers } = await r.json();
    $("mcp-kkachi").replaceChildren(...rows(servers.filter((s) => s.source === "kkachi"), (s) => (s.ok ? `연결됨. 도구 ${s.tools}개` : "응답이 없어요")));
    $("mcp-pi").replaceChildren(...rows(servers.filter((s) => s.source === "pi"), () => "등록됨"));
  } catch {
    for (const id of ["mcp-kkachi", "mcp-pi"]) $(id).replaceChildren(el("div", "loading", "불러오지 못했어요"));
  }
}

$("new-conversation").addEventListener("click", async () => {
  const r = await fetch("/api/new-conversation", { method: "POST" });
  if (!r.ok) { toast("새 대화를 시작하지 못했어요"); return; }
  turnId++; stopPlayback();
  clearTranscript();
  show("agent", "chat");
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
  say.style.height = `${Math.min(say.scrollHeight + border, 160)}px`;
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
    const im = new Image(); im.src = dataUrl(img); im.alt = `첨부한 사진 ${i + 1}`;
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
  if (picked.length > files.length) toast(`사진은 ${MAX_PHOTOS}장까지 보낼 수 있어요`);
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
// - the on-screen keyboard (it covers more than 80px): the bar at the bottom goes and the text box sits
//   on the keyboard. iOS reports the keyboard only once it has come up, so the height it had last time is
//   remembered and the text box goes up with it, not after it;
// - a keyboard joined to an iPhone or iPad: no keyboard comes up, but iOS floats a pill (previous, next,
//   done) over the bottom 58px of the screen, right where the bar is. The bar goes here too, and the
//   text box keeps clear of the pill;
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
    // The on-screen keyboard is up: the bar at the bottom goes, so the text box sits on the keyboard.
    // With an external keyboard iOS only floats a short bar over the bottom of the screen, without
    // shrinking the visible area: the bar at the bottom stays, and it is what ends up under that bar.
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
if (demo === "settings") show("settings");
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

// ---- the feed (docs/bus.md): conversations on spare devices and messages sent to the phone ----
// Listened to while the app is open. The last event id is kept, so reopening shows what came
// meanwhile; only fresh items are read aloud.
let feed = null;
function openFeed() {
  if (feed || demo || document.visibilityState !== "visible") return;
  const last = localStorage.getItem("kkachi.feed");
  openFlow();
  feed = new EventSource(`/api/feed${last ? `?last=${encodeURIComponent(last)}` : ""}`);
  feed.onmessage = (e) => {
    if (e.lastEventId) localStorage.setItem("kkachi.feed", e.lastEventId);
    const item = JSON.parse(e.data);
    if (item.kind !== "hello") showFeedItem(item);
  };
}
function closeFeed() { feed?.close(); feed = null; closeFlow(); }
function showFeedItem(item) {
  const v = item.kind === "turn" ? addTurn(item.heard, [], `${item.from}에서`) : addTurn("", [], "까치가 보냈어요", true);
  v.stream(item.text || "");
  v.finish();
  const fresh = Date.now() - Date.parse(item.at) < 15_000;
  if (item.speak && fresh && readAloud() && ctx && item.text) spoken(item.text).then((buf) => buf && (buf.say ? sayBuiltIn(buf.say) : play(buf)));
}
openFeed();
// The voice setting decides how replies are read aloud, so it is needed before the first one.
fetch("/api/settings").then((r) => r.json()).then((j) => { saved ??= j.settings; renderHome(); }).catch(() => {});

document.addEventListener("visibilitychange", () => {
  diag("visibility " + document.visibilityState);
  if (document.visibilityState === "hidden") { stopRecording(); resetAudio(); closeFeed(); } // iOS will cut the mic anyway; keep what was said
  // Back in the app: the turn stream may be dead without having errored yet. Restart it now; it
  // resumes from the last event received (see followTurn).
  else { liveStream?.abort(); openFeed(); }
});
