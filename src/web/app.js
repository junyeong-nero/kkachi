// Kkachi voice UI. Push to talk: hold the screen while speaking, release to send. See docs/design.md.
"use strict";

// ---- tuning ----
const TARGET_RATE = 16000;
const MIN_HOLD_MS = 300;     // shorter presses are accidental taps
const MAX_HOLD_MS = 60000;   // send automatically after a minute
const PREROLL_FRAMES = 2;    // ~170 ms before the press, so the first syllable is not cut
const READY_HINT = "누르고 있는 동안 말하세요";

const DEBUG = new URLSearchParams(location.search).has("debug");
const $ = (id) => document.getElementById(id);

// ---- state ----
let ctx, stream, frameMs = 0;
let state = "idle";
let recording = false, recordFrames = [], preroll = [], pressedAt = 0, holdTimer = null;
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
  state = s; document.body.dataset.state = s; $("hint").textContent = hint;
  if (s !== "recording") $("orb").style.transform = "";
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


// ---- audio setup: the first press is the user gesture iOS needs for mic and playback ----
async function ensureAudio() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (navigator.audioSession) { try { navigator.audioSession.type = "play-and-record"; } catch {} }
    diag("env", { standalone: matchMedia("(display-mode: standalone)").matches || !!navigator.standalone, rate: ctx.sampleRate });
  }
  if (ctx.state !== "running") await ctx.resume();
  // iOS drops the mic when the screen turns off or the app goes to the background; reopen it.
  const track = stream?.getAudioTracks()[0];
  if (track && track.readyState === "live" && !track.muted) return true;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  } catch (e) {
    diag("mic error", { err: String(e) });
    setState("error", "마이크를 쓸 수 없어요. 설정에서 마이크를 허용해 주세요.");
    return false;
  }
  const t = stream.getAudioTracks()[0];
  for (const ev of ["mute", "unmute", "ended"]) t.addEventListener(ev, () => diag("track " + ev));
  const source = ctx.createMediaStreamSource(stream);
  const proc = ctx.createScriptProcessor(4096, 1, 1);
  frameMs = (4096 / ctx.sampleRate) * 1000;
  const sink = ctx.createGain(); sink.gain.value = 0;
  source.connect(proc); proc.connect(sink); sink.connect(ctx.destination);
  proc.onaudioprocess = (e) => onFrame(new Float32Array(e.inputBuffer.getChannelData(0)));
  return true;
}

function ready(hint = READY_HINT) { setState("idle", hint); }

// ---- capture: keep a short pre-roll, record only while pressed ----
function onFrame(f) {
  if (!recording) {
    preroll.push(f); if (preroll.length > PREROLL_FRAMES) preroll.shift();
    return;
  }
  recordFrames.push(f);
  let sum = 0; for (let i = 0; i < f.length; i++) sum += f[i] * f[i];
  $("orb").style.transform = `scale(${1 + Math.min(Math.sqrt(sum / f.length) / 0.03, 4) * 0.08})`;
}

async function press() {
  if (recording) return;
  turnId++; stopPlayback(); // talking over Kkachi interrupts it
  pressedAt = performance.now();
  recording = true;
  recordFrames = [];
  const first = !ctx;
  if (!(await ensureAudio())) { recording = false; return; }
  if (first) { recording = false; ready("마이크 준비됐어요. 누른 채로 말하세요"); return; } // permission prompt ate this press
  if (!recording) { ready(); return; } // released while the mic was reopening
  recordFrames = [...preroll];
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
  handleUtterance(recordFrames);
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
  if (!text) { ready("잘 못 들었어요. 다시 눌러 말해 주세요"); return; }
  $("heard").textContent = `“${text}”`;
  $("reply").textContent = ""; $("chips").replaceChildren();
  diag("stt", { text, ms: Math.round(performance.now() - t0) });

  const queue = [];       // Promise<AudioBuffer|null>, in play order
  const spoken = [];
  let streamDone = false, end = false, firstSound = 0;
  // Every sentence is shown; only non-silent ones are spoken.
  const say = (s, silent = false) => { spoken.push(s); $("reply").textContent = spoken.join(" "); if (!silent) queue.push(ttsBuffer(s)); };

  const player = (async () => {
    for (let i = 0; ; ) {
      if (my !== turnId) return;
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
    await readEvents("/api/turn", { text }, (e) => {
      if (my !== turnId) return;
      if (e.type === "sentence") say(e.text, e.silent);
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
  ready(end ? "필요하면 다시 눌러 말을 걸어주세요" : READY_HINT);
}

async function turnError(my, message, err) {
  diag("turn error", { err: String(err) });
  if (my !== turnId) return;
  setState("error", message);
  earcon.error();
  const buf = await ttsBuffer(message);
  if (buf && my === turnId) await play(buf);
  if (my === turnId) ready();
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

// ---- input: press and hold anywhere to talk ----
const stage = $("stage");
stage.addEventListener("pointerdown", (e) => { e.preventDefault(); stage.setPointerCapture?.(e.pointerId); press(); });
for (const ev of ["pointerup", "pointercancel", "lostpointercapture"]) stage.addEventListener(ev, release);
stage.addEventListener("contextmenu", (e) => e.preventDefault()); // no iOS long-press menu
document.addEventListener("visibilitychange", () => {
  diag("visibility " + document.visibilityState);
  if (document.visibilityState === "hidden") release();
});
