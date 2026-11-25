// Kkachi UI. One composer: type, or tap the mic and speak. Spoken words land in the text box to check
// and fix before sending. Replies render as Markdown and can be read aloud. See DESIGN.md.
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
      else if (e.type === "sentence") { if (speak && !e.silent) queue.push(ttsBuffer(e.text)); } // speak as soon as a sentence is complete
      else if (e.type === "aside") { view.aside(); if (speak) { skipBefore = queue.length; stopPlayback(); } }
      else if (e.type === "activity") view.working(activityLabel(e.tool, e.path));
      else if (e.type === "photo") view.photo(e);
      else if (e.type === "done") { view.finish(); showChips(view.chips, e.sources, e.changed, e.titles); }
      else if (e.type === "error") { view.fail(e.message); if (speak) queue.push(ttsBuffer(e.message)); earcon.error(); }
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
function scrollDown() { const log = $("log"); log.scrollTop = log.scrollHeight; }

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
function addTurn(text, images = []) {
  $("intro")?.remove();
  const turn = el("article", "turn");
  const you = el("div", "you");
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
  scrollDown();
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

// Empty transcript shows real things to say (first-run guidance), from the HTML template.
function clearTranscript() {
  $("log").replaceChildren($("intro-template").content.cloneNode(true));
}

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

function stopPlayback() { try { currentSource?.stop(); } catch {} currentSource = null; }

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

// ---- top bar: refresh (a home-screen web app has no reload button) and settings ----
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
const CAN = { speak: "말하기", lamp: "조명", talk: "말 걸기", photo: "사진", "sound level": "소리 크기", "motion sensors": "센서", location: "위치" };
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

async function openSettings() {
  const dlg = $("settings");
  renderTextSize();
  renderDevicePrefs();
  dlg.showModal();
  fetch("/api/device/list").then((r) => r.json()).then((j) => renderDevices(j.devices)).catch(() => {});
  const r = await fetch("/api/settings");
  if (!r.ok) { toast("설정을 불러오지 못했어요"); return; }
  const { settings: s, voices, thinking, models, fallbacks } = await r.json();
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
  try {
    const r = await fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "안녕하세요, 까치예요. 오늘도 반가운 소식 전해 드릴게요.", voice, rate: Number($("rate").value) }) });
    if (!r.ok) throw new Error("tts " + r.status);
    play(await ctx.decodeAudioData(await r.arrayBuffer()));
  } catch (e) { toast("목소리를 불러오지 못했어요"); }
}

$("open-settings").addEventListener("click", openSettings);
$("new-conversation").addEventListener("click", async () => {
  const r = await fetch("/api/new-conversation", { method: "POST" });
  if (!r.ok) { toast("새 대화를 시작하지 못했어요"); return; }
  turnId++; stopPlayback();
  clearTranscript();
  $("settings").close();
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
  if (e.code !== "Space" || e.repeat || typing(e.target)) return;
  e.preventDefault(); startRecording();
});
document.addEventListener("keyup", (e) => {
  if (e.code !== "Space" || typing(e.target)) return;
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
const vv = window.visualViewport;
if (vv) {
  const root = document.documentElement.style;
  const fit = () => {
    root.setProperty("--vv-height", `${vv.height}px`);
    root.setProperty("--vv-top", `${vv.offsetTop}px`);
  };
  vv.addEventListener("resize", () => { fit(); scrollDown(); }); // keyboard in or out: keep the latest message in view
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
if (demo === "settings") openSettings();
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

document.addEventListener("visibilitychange", () => {
  diag("visibility " + document.visibilityState);
  if (document.visibilityState === "hidden") { stopRecording(); resetAudio(); } // iOS will cut the mic anyway; keep what was said
  // Back in the app: the turn stream may be dead without having errored yet. Restart it now; it
  // resumes from the last event received (see followTurn).
  else liveStream?.abort();
});
