"""How long does reading a page actually take, and why?

Reading is the slowest thing the app does and the first thing a student waits
on, so the cost is broken out rather than guessed at: loading the vision model
(which on a shared GPU means evicting the text model first), the reading
itself, and the second opinion when one is taken.

    .venv\\Scripts\\python.exe bench\\read_speed.py
"""
from __future__ import annotations

import base64
import io
import json
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from PIL import Image, ImageDraw, ImageFont  # noqa: E402

BASE = "http://127.0.0.1:8000"
OLLAMA = "http://127.0.0.1:11434"


def page(text="Integrate the function x^2 + 2 wrt x") -> str:
    """A page with a question on it, close to what a student writes."""
    im = Image.new("RGB", (1400, 500), "white")
    d = ImageDraw.Draw(im)
    try:
        f = ImageFont.truetype("segoesc.ttf", 64)       # a script face
    except OSError:
        f = ImageFont.load_default()
    d.text((70, 120), text, font=f, fill=(20, 24, 50))
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def post(url, body, timeout=900):
    req = urllib.request.Request(url, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    return json.load(urllib.request.urlopen(req, timeout=timeout))


def unload(model):
    try:
        urllib.request.urlopen(urllib.request.Request(
            OLLAMA + "/api/generate",
            data=json.dumps({"model": model, "keep_alive": 0}).encode(),
            headers={"Content-Type": "application/json"}), timeout=60).read()
    except Exception:
        pass


def loaded():
    try:
        d = json.load(urllib.request.urlopen(OLLAMA + "/api/ps", timeout=5))
        return sorted(m["name"] for m in d.get("models", []))
    except Exception:
        return []


def read(img, label):
    t0 = time.perf_counter()
    out = post(f"{BASE}/api/ai/extract", {"image": img, "provider": "local"})
    dt = time.perf_counter() - t0
    print(f"  {label:38s} {dt:5.1f}s   "
          f"confidence {out.get('confidence', 0):.2f}   "
          f"{'read twice' if out.get('verified') and out.get('alternative') is not None else ''}"
          f"{'' if out.get('question') else '  (nothing read!)'}")
    print(f"      -> {str(out.get('question'))[:72]}")
    return dt, out


def main() -> int:
    try:
        urllib.request.urlopen(BASE + "/api/status", timeout=5).read()
    except Exception:
        print("INKWISE is not running.")
        return 2

    img = page()
    print("what the student waits for, start to finish:\n")

    # the realistic worst case: the text model is warm from the last answer,
    # so the vision model has to evict it and load
    post(f"{BASE}/api/ai/unload", {})
    print(f"  (nothing loaded: {loaded()})")
    cold, _ = read(img, "cold - nothing in memory")

    warm, _ = read(img, "warm - straight after")

    print(f"\n  resident now: {loaded()}")
    print(f"\n  cold {cold:.1f}s, warm {warm:.1f}s, "
          f"the difference is the model load ({cold - warm:.1f}s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
