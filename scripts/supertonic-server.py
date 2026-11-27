# /// script
# requires-python = ">=3.10"
# dependencies = ["supertonic"]
# ///
"""A voice made on this computer: Supertonic 3 (Supertone's on-device TTS, ONNX on the CPU) behind
OpenAI's speech API, for KKACHI_TTS_PROVIDER=supertonic (lib/tts.ts, docs/design.md).

    uv run scripts/supertonic-server.py          # http://127.0.0.1:8093/v1/audio/speech

The model (about 400 MB) is fetched from Hugging Face the first time; after that nothing leaves the
computer. It answers with a 16-bit mono WAVE.

SUPERTONIC_PORT   8093
SUPERTONIC_STEPS  3    more steps sound better and take longer: on a laptop CPU (i5-10210U) a 5 s
                       sentence takes 1.3 s with 2, 1.6 s with 3, 2.2 s with 5 and 3.5 s with 8
SUPERTONIC_LANG   ko
"""
import json
import os
import struct
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np
from supertonic import TTS

PORT = int(os.environ.get("SUPERTONIC_PORT", "8093"))
STEPS = int(os.environ.get("SUPERTONIC_STEPS", "3"))
LANG = os.environ.get("SUPERTONIC_LANG", "ko")
DEFAULT_VOICE = "F1"

tts = TTS(auto_download=True)
RATE = int(getattr(tts, "sample_rate", 44100))
styles = {name: tts.get_voice_style(voice_name=name) for name in tts.voice_style_names}
one_at_a_time = threading.Lock()  # one model: requests take turns


def wave(samples: np.ndarray) -> bytes:
    pcm = (np.clip(samples.reshape(-1), -1.0, 1.0) * 32767).astype("<i2").tobytes()
    header = b"RIFF" + struct.pack("<I", 36 + len(pcm)) + b"WAVEfmt " + struct.pack("<IHHIIHH", 16, 1, 1, RATE, RATE * 2, 2, 16)
    return header + b"data" + struct.pack("<I", len(pcm)) + pcm


class Handler(BaseHTTPRequestHandler):
    def reply(self, status: int, body: bytes, kind: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def fail(self, status: int, message: str) -> None:
        self.reply(status, json.dumps({"error": {"message": message}}).encode(), "application/json")

    def do_GET(self) -> None:
        if self.path == "/health":
            self.reply(200, json.dumps({"status": "ok", "voices": sorted(styles), "steps": STEPS}).encode(), "application/json")
        else:
            self.fail(404, "not found")

    def do_POST(self) -> None:
        if self.path != "/v1/audio/speech":
            return self.fail(404, "not found")
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
            text = str(body.get("input", "")).strip()
            if not text:
                return self.fail(400, "input is empty")
            style = styles.get(str(body.get("voice", "")), styles[DEFAULT_VOICE])
            speed = max(0.7, min(2.0, 1.05 * float(body.get("speed", 1))))  # 1.05 is the model's own default
            with one_at_a_time:
                samples, _ = tts.synthesize(text, voice_style=style, lang=LANG, total_steps=STEPS, speed=speed)
            self.reply(200, wave(samples), "audio/wav")
        except Exception as err:  # the caller falls back to the device's own voice
            self.fail(500, str(err))

    def log_message(self, *args) -> None:  # one line a request is noise in Kkachi's log
        pass


if __name__ == "__main__":
    print(f"supertonic listening on http://127.0.0.1:{PORT}/v1 ({len(styles)} voices, {STEPS} steps, {RATE} Hz)", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
