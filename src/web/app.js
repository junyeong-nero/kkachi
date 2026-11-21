// Kkachi voice UI. Tap once, then talk: listen → think → speak → listen again. See docs/design.md.
"use strict";

// ---- tuning ----
const TARGET_RATE = 16000;
const END_SILENCE_MS = 800;
const MIN_SPEECH_MS = 250;
const MAX_UTTER_MS = 15000;
const PREROLL_FRAMES = 4;
const RESUME_DELAY_MS = 300;

const DEBUG = new URLSearchParams(location.search).has("debug");
const $ = (id) => document.getElementById(id);

// ---- state ----
let ctx, stream, frameMs = 0, wakeLock = null;
let state = "idle";
let noiseFloor = 0.003, calibFrames = 0;
let inSpeech = false, speechFrames = [], preroll = [], silentMs = 0, speechMs = 0;
let turnId = 0, currentSource = null;

if (DEBUG) document.body.classList.add("debug");
const diagLines = [];
function diag(msg, data) {
  if (!DEBUG) return;
  const line = `${new Date().toISOString().slice(11, 23)} ${msg}${data ? " " + JSON.stringify(data) : ""}`;
  diagLines.unshift(line); diagLines.length = Math.min(diagLines.length, 60);
  $("diag").textContent = diagLines.join("\n");
  fetch("/api/log", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ msg, ...data }) }).catch(() => {});
}

function setState(s, hint = "") {
  state = s; document.body.dataset.state = s; $("hint").textContent = hint;
  if (s !== "listening") $("orb").style.transform = "";
  diag("state", { s });
}

// ---- sounds ----
function tone(freq, ms, vol = 0.12) {
  const o = ctx.createOscillator(), g = ctx.createGain();
  o.frequency.value = freq; g.gain.setValueAtTime(vol, ctx.currentTime); g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + ms / 1000);
  o.connect(g).connect(ctx.destination); o.start(); o.stop(ctx.currentTime + ms / 1000);
}
const earcon = {
  start: () => tone(660, 90),
  heard: () => tone(880, 70, 0.08),
  error: () => tone(220, 260),
};


// ---- start: must run inside the tap gesture (iOS needs it for audio output and mic) ----
async function start() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (navigator.audioSession) { try { navigator.audioSession.type = "play-and-record"; } catch {} }
    earcon.start();
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      setState("error", "마이크를 쓸 수 없어요. 설정에서 마이크를 허용해 주세요.");
      return;
    }
    const track = stream.getAudioTracks()[0];
    for (const ev of ["mute", "unmute", "ended"]) track.addEventListener(ev, () => diag("track " + ev));
    const source = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    frameMs = (4096 / ctx.sampleRate) * 1000;
    const sink = ctx.createGain(); sink.gain.value = 0;
    source.connect(proc); proc.connect(sink); sink.connect(ctx.destination);
    proc.onaudioprocess = (e) => onFrame(new Float32Array(e.inputBuffer.getChannelData(0)));
    diag("env", { standalone: matchMedia("(display-mode: standalone)").matches || !!navigator.standalone, rate: ctx.sampleRate });
  } else {
    await ctx.resume();
    earcon.start();
  }
  keepScreenOn();
  listen();
}

async function keepScreenOn() {
  try { if ("wakeLock" in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request("screen"); wakeLock.addEventListener("release", () => (wakeLock = null)); } } catch {}
}

function goIdle() {
  turnId++; stopPlayback();
  wakeLock?.release().catch(() => {});
  setState("idle", "탭해서 시작");
}

function listen() {
  inSpeech = false; speechFrames = []; preroll = []; silentMs = 0; speechMs = 0;
  setState("listening", "듣고 있어요 · 탭하면 쉬어요");
}

// ---- VAD: energy against a calibrated noise floor ----
function onFrame(f) {
  if (state !== "listening") return;
  let sum = 0; for (let i = 0; i < f.length; i++) sum += f[i] * f[i];
  const rms = Math.sqrt(sum / f.length);
  if (calibFrames < 12) { noiseFloor = calibFrames === 0 ? rms : noiseFloor * 0.8 + rms * 0.2; calibFrames++; return; }
  const th = Math.max(noiseFloor * 3, 0.012);
  $("orb").style.transform = `scale(${1 + Math.min(rms / th, 4) * 0.08})`;

  if (!inSpeech) {
    preroll.push(f); if (preroll.length > PREROLL_FRAMES) preroll.shift();
    if (rms > th) { inSpeech = true; speechFrames = [...preroll]; speechMs = 0; silentMs = 0; }
    else noiseFloor = noiseFloor * 0.95 + rms * 0.05;
    return;
  }
  speechFrames.push(f); speechMs += frameMs;
  silentMs = rms > th ? 0 : silentMs + frameMs;
  if (silentMs >= END_SILENCE_MS || speechMs >= MAX_UTTER_MS) {
    if (speechMs - silentMs < MIN_SPEECH_MS) { listen(); return; }
    handleUtterance(speechFrames);
  }
}

// ---- one turn ----
async function handleUtterance(frames) {
  const my = ++turnId;
  const t0 = performance.now();
  earcon.heard();
  setState("thinking");
  let text;
  try {
    const r = await fetch("/api/stt", { method: "POST", headers: { "Content-Type": "audio/wav" }, body: encodeWav(frames, ctx.sampleRate, TARGET_RATE) });
    const body = await r.json();
    if (!r.ok) throw new Error(body.error);
    text = body.text;
  } catch (e) {
    return turnError(my, "잘 못 들었어요. 다시 말해 주세요.", e);
  }
  if (my !== turnId) return;
  if (!text) { listen(); return; }
  $("heard").textContent = `“${text}”`;
  $("reply").textContent = ""; $("chips").replaceChildren();
  diag("stt", { text, ms: Math.round(performance.now() - t0) });

  const queue = [];       // Promise<AudioBuffer|null>, in play order
  const spoken = [];
  let streamDone = false, end = false, firstSound = 0;
  const say = (s) => { spoken.push(s); $("reply").textContent = spoken.join(" "); queue.push(ttsBuffer(s)); };

  const player = (async () => {
    for (let i = 0; ; ) {
      if (my !== turnId) return;
      if (i < queue.length) {
        const buf = await queue[i++];
        if (my !== turnId) return;
        if (!buf) continue;
        if (!firstSound) { firstSound = performance.now(); diag("first sound", { ms: Math.round(firstSound - t0) }); }
        setState("speaking", "탭하면 멈춰요");
        await play(buf);
      } else if (streamDone) return;
      else await new Promise((r) => setTimeout(r, 40));
    }
  })();

  try {
    await readEvents("/api/turn", { text }, (e) => {
      if (my !== turnId) return;
      if (e.type === "sentence") say(e.text);
      else if (e.type === "activity") {
        const writing = e.tool === "edit" || e.tool === "write";
        if (state === "thinking") $("hint").textContent = writing ? "기억하는 중…" : "찾는 중…";
      }
      else if (e.type === "end") end = true;
      else if (e.type === "done") showChips(e.sources, e.changed);
      else if (e.type === "error") { say(e.message); earcon.error(); }
    });
  } catch (e) {
    streamDone = true;
    return turnError(my, "연결이 끊겼어요. 다시 말해 주세요.", e);
  }
  streamDone = true;
  await player;
  if (my !== turnId) return;
  if (end) return goIdle();
  setTimeout(() => { if (my === turnId) listen(); }, RESUME_DELAY_MS);
}

async function turnError(my, message, err) {
  diag("turn error", { err: String(err) });
  if (my !== turnId) return;
  setState("error", message);
  earcon.error();
  const buf = await ttsBuffer(message);
  if (buf && my === turnId) await play(buf);
  if (my === turnId) setTimeout(listen, 600);
}

function showChips(sources, changed) {
  const chips = sources.map((p) => {
    const el = document.createElement("span");
    el.className = "chip" + (changed.includes(p) ? " changed" : "");
    el.textContent = (changed.includes(p) ? "✎ " : "📄 ") + p.replace(/\/index\.md$|\.md$/, "");
    return el;
  });
  $("chips").replaceChildren(...chips);
}

// ---- audio out ----
async function ttsBuffer(text) {
  try {
    const r = await fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }) });
    if (!r.ok) throw new Error("tts " + r.status);
    return await ctx.decodeAudioData(await r.arrayBuffer());
  } catch (e) { diag("tts error", { err: String(e) }); return null; }
}

function play(buf) {
  return new Promise((resolve) => {
    const src = ctx.createBufferSource(); src.buffer = buf; src.connect(ctx.destination);
    src.onended = () => { if (currentSource === src) currentSource = null; resolve(); };
    currentSource = src; src.start();
  });
}

function stopPlayback() { try { currentSource?.stop(); } catch {} currentSource = null; }

// ---- server-sent events over POST ----
async function readEvents(url, body, onEvent) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok || !r.body) throw new Error("turn " + r.status);
  const reader = r.body.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
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

// ---- input: tap to start; tap while listening rests; tap while thinking/speaking interrupts ----
$("stage").addEventListener("click", () => {
  if (state === "idle" || state === "error") start();
  else if (state === "listening") goIdle();
  else if (state === "speaking" || state === "thinking") { turnId++; stopPlayback(); listen(); }
});
document.addEventListener("visibilitychange", () => {
  diag("visibility " + document.visibilityState);
  if (document.visibilityState === "visible" && state !== "idle") keepScreenOn();
});
