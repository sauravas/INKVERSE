"""Measure handwritten-maths transcription accuracy under different preprocessing.

The reported failure was "4x^2" being read as "2x^2": a coefficient error that
silently invalidates the whole solution. Small crops are the suspect - the
vision encoder works at a fixed tile size, so a 594x377 crop is effectively
upsampled by the model rather than by us, losing stroke detail.
"""
import base64
import io
import json
import sys
import time
from pathlib import Path

import httpx
from PIL import Image, ImageEnhance, ImageOps

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from app.ai import prompts  # noqa: E402

HERE = Path(__file__).parent
OLLAMA = "http://127.0.0.1:11434"
MODEL = "gemma3:4b"

EXPECT = {
    "deriv4x2": ["4x^2", "4x"],
    "deriv7x3": ["7x^3", "7x"],
    "integ3x2": ["3x^2", "3x"],
    "quad": ["2x^2", "7x", "3"],
    "frac": ["8x^4", "2x^2"],
}


def crop_ink(im, pad=36, threshold=170):
    mask = im.convert("L").point(lambda v: 255 if v < threshold else 0, "L")
    box = mask.getbbox()
    if not box:
        return im
    l, t, r, b = box
    return im.crop((max(0, l - pad), max(0, t - pad),
                    min(im.width, r + pad), min(im.height, b + pad)))


def variant_baseline(im):
    return crop_ink(im)


def variant_upscaled(im, target=1120):
    im = crop_ink(im)
    if max(im.size) < target:
        s = target / max(im.size)
        im = im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS)
    return im


def variant_sharpened(im, target=1120):
    im = variant_upscaled(im, target)
    im = ImageOps.autocontrast(im.convert("L"), cutoff=1).convert("RGB")
    return ImageEnhance.Sharpness(im).enhance(1.8)


VARIANTS = {"baseline": variant_baseline,
            "upscaled": variant_upscaled,
            "upscaled+sharp": variant_sharpened}


def b64(im):
    buf = io.BytesIO()
    im.save(buf, "PNG", optimize=True)
    return base64.b64encode(buf.getvalue()).decode()


def ask(image_b64, prompt_text, temp=0.0):
    body = {"model": MODEL, "stream": False,
            "messages": [{"role": "system", "content": prompts.EXTRACT_SYSTEM},
                         {"role": "user", "content": prompt_text,
                          "images": [image_b64]}],
            "options": {"num_ctx": 8192, "num_predict": 400, "temperature": temp}}
    r = httpx.post(f"{OLLAMA}/api/chat", json=body, timeout=900)
    if r.status_code != 200:
        return f"<HTTP {r.status_code}>"
    return (r.json().get("message") or {}).get("content") or ""


def norm(s):
    return (s.replace(" ", "").replace("\\cdot", "").replace("{", "")
            .replace("}", "").replace("\\", "").replace("$", "").lower())


def score(text, expect):
    n = norm(text)
    return sum(1 for e in expect if norm(e) in n), len(expect)


def main():
    use_prompt = prompts.EXTRACT_USER
    results = {}
    for vname, fn in VARIANTS.items():
        got = hit = tot = 0
        print(f"\n=== {vname} ===")
        for name, expect in EXPECT.items():
            im = Image.open(HERE / "math_images" / f"{name}.png").convert("RGB")
            prepped = fn(im)
            t0 = time.perf_counter()
            raw = ask(b64(prepped), use_prompt)
            q = prompts.parse_extraction(raw)["question"]
            h, t = score(q, expect)
            hit += h
            tot += t
            got += 1
            flag = "OK " if h == t else "MISS"
            print(f"  {flag} {name:10} {prepped.size} {time.perf_counter()-t0:5.1f}s "
                  f"{h}/{t}  {q[:70]!r}")
        results[vname] = (hit, tot)
    print("\n--- summary (tokens correctly transcribed) ---")
    for v, (h, t) in results.items():
        print(f"  {v:16} {h}/{t}  ({h/t:.0%})")
    best = max(results, key=lambda k: results[k][0])
    print(f"\nbest: {best}")
    (HERE / "math_ocr.json").write_text(json.dumps(
        {k: {"hit": v[0], "total": v[1]} for k, v in results.items()}, indent=2))


if __name__ == "__main__":
    main()
