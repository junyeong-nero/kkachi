// Kkachi UI. Voice (hold to talk, release to send) or keyboard input; replies render as Markdown and
// can be read aloud. See DESIGN.md.
"use strict";

// ---- tuning ----
const TARGET_RATE = 16000;
const MIN_HOLD_MS = 300;     // shorter presses are accidental taps
const MAX_HOLD_MS = 60000;   // send automatically after a minute
const PREROLL_FRAMES = 2;    // ~170 ms before the press, so the first syllable is not cut
const READY_HINT = "누르고 있는 동안 말하세요";

const DEBUG = new URLSearchParams(location.search).has("debug");
const $ = (id) => document.getElementById(id);

// Per-device preferences (a phone and a laptop want different ones), kept in localStorage.
const inputMode = () => (localStorage.getItem("kkachi.input") === "keyboard" ? "keyboard" : "voice");
const readAloud = () => localStorage.getItem("kkachi.speak") === "on";

// ---- state ----
let ctx, stream, frameMs = 0;
let state = "idle";
let recording = false, recordFrames = [], preroll = [], prerollCount = 0, pressedAt = 0, holdTimer = null;
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
    if (navigator.audioSession) { try { navigator.audioSession.type = inputMode() === "voice" ? "play-and-record" : "playback"; } catch {} }
  }
  if (ctx.state !== "running") ctx.resume();
}

// iOS stops the mic and leaves the AudioContext "interrupted" when the app is backgrounded or the
// screen locks. Reusing either records silence, so tear both down and rebuild on the next press.
function resetAudio() {
  try { stream?.getTracks().forEach((t) => t.stop()); } catch {}
  try { ctx?.close(); } catch {}
  stream = null; ctx = null; preroll = []; currentSource = null;
}

let micGranted = false; // after the first grant, a rebuilt mic records on the same press

async function ensureAudio() {
  if (ctx && ctx.state !== "running") { try { await ctx.resume(); } catch {} }
  if (ctx && ctx.state !== "running") resetAudio(); // could not wake it: start over
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (navigator.audioSession) { try { navigator.audioSession.type = "play-and-record"; } catch {} }
    diag("env", { standalone: matchMedia("(display-mode: standalone)").matches || !!navigator.standalone, rate: ctx.sampleRate, state: ctx.state });
  }
  const track = stream?.getAudioTracks()[0];
  if (track && track.readyState === "live" && !track.muted) return true;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (e) {
    diag("mic error", { err: String(e) });
    $("mic").disabled = true;
    setState("error", "마이크를 쓸 수 없어요. 설정에서 마이크를 허용해 주세요.");
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
  proc.onaudioprocess = (e) => onFrame(new Float32Array(e.inputBuffer.getChannelData(0)));
  return true;
}

function ready(hint = READY_HINT) { setState("idle", inputMode() === "voice" ? hint : ""); }

// ---- capture: keep a short pre-roll, record only while pressed ----
function onFrame(f) {
  if (!recording) {
    preroll.push(f); if (preroll.length > PREROLL_FRAMES) preroll.shift();
    return;
  }
  recordFrames.push(f);
  let sum = 0; for (let i = 0; i < f.length; i++) sum += f[i] * f[i];
  $("mic").style.setProperty("--level", Math.min(Math.sqrt(sum / f.length) / 0.08, 1).toFixed(2));
}

async function press() {
  if (recording) return;
  turnId++; stopPlayback(); // talking over Kkachi interrupts it
  pressedAt = performance.now();
  recording = true;
  recordFrames = [];
  const firstGrant = !micGranted;
  if (!(await ensureAudio())) { recording = false; return; }
  if (firstGrant) { recording = false; ready("마이크 준비됐어요. 누른 채로 말하세요"); return; } // the permission prompt ate this press
  if (!recording) { ready(); return; } // released while the mic was reopening
  recordFrames = [...preroll];
  prerollCount = recordFrames.length;
  earcon.start();
  setState("recording", "듣고 있어요 · 손을 떼면 보내요");
  clearTimeout(holdTimer);
  holdTimer = setTimeout(release, MAX_HOLD_MS);
}

function release() {
  if (!recording) return;
  recording = false;
  clearTimeout(holdTimer);
  if (state !== "recording") return;
  if (performance.now() - pressedAt < MIN_HOLD_MS) { ready(); return; }
  // No new audio while held: the audio pipeline is dead (iOS interruption). Do not send silence.
  if (recordFrames.length - prerollCount < 2) {
    diag("no audio while held", { frames: recordFrames.length, ctx: ctx?.state });
    resetAudio();
    ready("마이크를 다시 연결했어요. 다시 눌러 말해 주세요");
    return;
  }
  handleUtterance(recordFrames);
}

// ---- one turn ----
async function handleUtterance(frames) {
  const my = ++turnId;
  const t0 = performance.now();
  earcon.heard();
  setState("thinking", "받아적는 중…");
  const view = addTurn(); // shows up at once: your bubble is a placeholder until transcription returns
  let text, raw;
  try {
    const r = await fetch("/api/stt", { method: "POST", headers: { "Content-Type": "audio/wav" }, body: encodeWav(frames, ctx.sampleRate, TARGET_RATE) });
    const body = await r.json();
    if (!r.ok) throw new Error(body.error);
    text = body.text;
    raw = body.raw;
  } catch (e) {
    view.remove();
    return turnError(my, "잘 못 들었어요. 다시 말해 주세요.", e);
  }
  if (my !== turnId) { view.remove(); return; }
  if (!text) { view.remove(); ready("잘 못 들었어요. 다시 눌러 말해 주세요"); return; }
  view.setYou(text);
  setState("thinking", "생각하는 중 · 누르면 멈춰요");
  diag("stt", { text, ms: Math.round(performance.now() - t0) });
  await runTurn(my, view, { text, raw }, t0);
}

// A typed message: no transcription, straight to the turn.
function handleText(text) {
  const my = ++turnId;
  stopPlayback();
  if (readAloud()) audioOut(); // the send tap is the gesture iOS needs before it plays sound
  const view = addTurn();
  view.setYou(text);
  setState("thinking", "");
  runTurn(my, view, { text }, performance.now());
}

async function runTurn(my, view, body, t0) {
  const speak = readAloud();
  const queue = [];       // Promise<AudioBuffer|null>, in play order
  let skipBefore = 0;     // queue items before this index were narration before a tool call: not played
  let streamDone = false, end = false, firstSound = 0;

  const player = !speak ? Promise.resolve() : (async () => {
    for (let i = 0; ; ) {
      if (my !== turnId) return;
      if (i < skipBefore) { i = skipBefore; continue; }
      if (i < queue.length) {
        const buf = await queue[i++];
        if (my !== turnId) return;
        if (!buf) continue;
        if (!firstSound) { firstSound = performance.now(); diag("first sound", { ms: Math.round(firstSound - t0) }); }
        setState("speaking", "누르면 멈추고 다시 들어요");
        await play(buf);
      } else if (streamDone) return;
      else await new Promise((r) => setTimeout(r, 40));
    }
  })();

  try {
    await readEvents("/api/turn", body, (e) => {
      if (my !== turnId) return;
      if (e.type === "delta") view.stream(e.text);                       // live text on screen
      else if (e.type === "sentence") { if (speak && !e.silent) queue.push(ttsBuffer(e.text)); } // speak as soon as a sentence is complete
      else if (e.type === "aside") { view.aside(); if (speak) { skipBefore = queue.length; stopPlayback(); } }
      else if (e.type === "activity") {
        const label = activityLabel(e.tool, e.path);
        view.working(label);
        if (state === "thinking") $("status").textContent = `${label} · 누르면 멈춰요`;
      }
      else if (e.type === "end") end = true;
      else if (e.type === "done") { view.finish(); showChips(view.chips, e.sources, e.changed, e.titles); }
      else if (e.type === "error") { view.fail(e.message); if (speak) queue.push(ttsBuffer(e.message)); earcon.error(); }
    });
    view.finish();
  } catch (e) {
    streamDone = true;
    if (my === turnId) view.fail("연결이 끊겼어요. 다시 보내 주세요.");
    return turnError(my, "연결이 끊겼어요. 다시 말해 주세요.", e);
  }
  streamDone = true;
  await player;
  if (my !== turnId) return;
  ready(end ? "필요하면 다시 눌러 말을 걸어주세요" : READY_HINT);
}

async function turnError(my, message, err) {
  diag("turn error", { err: String(err) });
  if (my !== turnId) return;
  setState("error", message);
  earcon.error();
  const buf = readAloud() ? await ttsBuffer(message) : null;
  if (buf && my === turnId) await play(buf);
  if (my === turnId) ready();
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
function addTurn() {
  $("intro")?.remove();
  const turn = el("article", "turn");
  const you = el("div", "you pending", DOTS);
  you.setAttribute("aria-label", "받아적는 중");
  const reply = el("div", "kkachi");
  const work = el("div", "working", `${DOTS}<span class="label"></span>`);
  let block = el("div", "md"); // the message being written; earlier ones (narration before tool calls) are asides
  reply.hidden = true; // Kkachi's bubble appears once your words are known
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
    remove: () => turn.remove(),
    setYou(text) { you.classList.remove("pending"); you.removeAttribute("aria-label"); you.textContent = text; reply.hidden = false; work.hidden = false; scrollDown(); },
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
      if (!reply.querySelector(".md, .err")) reply.hidden = true; // only actions, no words: no empty bubble
    },
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

// ---- server-sent events over POST ----
// The server sends a heartbeat every 15 s; silence longer than this means the stream is dead
// (server restarted, network dropped) and the turn ends with an error instead of loading forever.
const STREAM_IDLE_MS = 45_000;

async function readEvents(url, body, onEvent) {
  const ctrl = new AbortController();
  let idle;
  const arm = () => { clearTimeout(idle); idle = setTimeout(() => ctrl.abort(), STREAM_IDLE_MS); };
  arm();
  try {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal });
    if (!r.ok || !r.body) throw new Error("turn " + r.status);
    await readStream(r.body, onEvent, arm);
  } finally {
    clearTimeout(idle);
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

// Input mode and read-aloud: radio groups in the sheet, stored on this device.
function renderDevicePrefs() {
  const bind = (name, current, apply) => {
    for (const input of document.querySelectorAll(`input[name=${name}]`)) {
      input.checked = input.value === current;
      input.onchange = () => { apply(input.value); toast("저장했어요"); };
    }
  };
  bind("input", inputMode(), (v) => { localStorage.setItem("kkachi.input", v); applyInputMode(); });
  bind("speak", readAloud() ? "on" : "off", (v) => { localStorage.setItem("kkachi.speak", v); applySpeak(); });
  applySpeak();
}

function applySpeak() {
  $("voice-settings").hidden = !readAloud();
  if (!readAloud()) stopPlayback();
}

function applyInputMode() {
  const mode = inputMode();
  document.body.dataset.input = mode;
  if (mode === "keyboard") { release(); resetAudio(); } // let go of the mic (iOS shows it as in use)
  if (state === "idle" || state === "error") ready();
}

async function openSettings() {
  const dlg = $("settings");
  renderTextSize();
  renderDevicePrefs();
  dlg.showModal();
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

// ---- input: press and hold anywhere to talk ----
// The whole bottom area (status + button) is the target, so it is easy to hit without looking.
const talk = $("talk");
talk.addEventListener("pointerdown", (e) => { e.preventDefault(); talk.setPointerCapture?.(e.pointerId); press(); });
for (const ev of ["pointerup", "pointercancel", "lostpointercapture"]) talk.addEventListener(ev, release);
talk.addEventListener("contextmenu", (e) => e.preventDefault()); // no iOS long-press menu

// Voice mode on a computer: hold Space to talk (not while typing in the settings sheet).
const typing = (el) => el?.closest?.("dialog[open], input, select, textarea");
document.addEventListener("keydown", (e) => {
  if (e.code !== "Space" || e.repeat || typing(e.target) || inputMode() !== "voice") return;
  e.preventDefault(); press();
});
document.addEventListener("keyup", (e) => {
  if (e.code !== "Space" || typing(e.target) || inputMode() !== "voice") return;
  e.preventDefault(); release();
});

// ---- input: keyboard ----
// Enter sends, Shift+Enter is a new line. Enter that ends a Korean IME composition is not a send.
const say = $("say"), send = $("send");
const grow = () => { say.style.height = "auto"; say.style.height = `${Math.min(say.scrollHeight, 160)}px`; send.disabled = !say.value.trim(); };
say.addEventListener("input", grow);
say.addEventListener("keydown", (e) => {
  if (e.key !== "Enter" || e.shiftKey || e.isComposing || e.keyCode === 229) return;
  e.preventDefault(); $("compose").requestSubmit();
});
$("compose").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = say.value.trim();
  if (!text) return;
  say.value = ""; grow();
  handleText(text);
});

applyInputMode();
clearTranscript();
// ?demo=<state> renders a sample screen for design review (no audio, no requests).
const demo = new URLSearchParams(location.search).get("demo");
if (new URLSearchParams(location.search).get("theme") === "light") document.documentElement.dataset.theme = "light";
if (new URLSearchParams(location.search).get("input") === "keyboard") document.body.dataset.input = "keyboard";
if (demo === "settings") openSettings();
else if (demo) {
  const hints = { recording: "듣고 있어요 · 손을 떼면 보내요", thinking: "노트 찾는 중 · 누르면 멈춰요", speaking: "누르면 멈추고 다시 들어요" };
  setState(demo, hints[demo] ?? "");
  $("mic").style.setProperty("--level", "0.7");
  const sample = (you, reply) => { const v = addTurn(); v.setYou(you); if (reply) { v.stream(reply); v.finish(); } return v; };
  if (demo === "speaking") {
    sample("오늘 서울 날씨 어때?", "서울은 지금 맑고 영하 1도예요.");
    const v = sample("친구 결혼식 언제였지?", "다다음 주 금요일, 12월 4일이에요. 축가는 성시경의 「거리에서」예요.");
    showChips(v.chips, ["a.md", "b.md"], ["b.md"], { "a.md": "친구 결혼식 축가", "b.md": "건강" });
  }
  if (demo === "thinking") {
    sample("오늘 서울 날씨 어때?", "서울은 지금 맑고 영하 1도예요.");
    sample("다음 주 일정 정리해줘").working("노트 찾는 중");
    addTurn(); // a turn whose words are still being transcribed
  }
  if (demo === "text") {
    const v = addTurn();
    v.setYou("이번 주 일정이랑 할 일 정리해줘");
    v.stream("노트에서 이번 주 일정을 찾아볼게요.");
    v.aside();
    v.stream("이번 주 일정이에요.\n\n| 날짜 | 일정 |\n|---|---|\n| 11월 24일 (화) 19:00 | 엄마 졸업 연주회 |\n| 11월 27일 (금) | 팀 회식 |\n\n**할 일**\n- 연주회 꽃다발 예약\n- `kkachi` 아이콘 수정\n\n연주회는 대경선으로 가면 돼요. 자세한 건 [노트](https://example.com)에 있어요.");
    v.finish();
    showChips(v.chips, ["a.md"], [], { "a.md": "엄마 졸업 연주회" });
  }
}

document.addEventListener("visibilitychange", () => {
  diag("visibility " + document.visibilityState);
  if (document.visibilityState === "hidden") { release(); resetAudio(); } // iOS will cut the mic anyway
});
