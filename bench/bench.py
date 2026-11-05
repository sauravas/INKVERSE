"""Benchmark gemma4:26b on handwriting extraction + solving through local Ollama.

Measures: extraction accuracy (manual-readable output), latency, tokens/sec,
and resident RAM / GPU split reported by `ollama ps`.
"""
import base64, io, json, subprocess, sys, time
from pathlib import Path

import httpx
from PIL import Image

HERE = Path(__file__).parent
OLLAMA = "http://127.0.0.1:11434"
MODEL = "gemma4:26b"

EXTRACT_PROMPT = (
    "You are reading a photo of a student's handwritten notebook page.\n"
    "Transcribe ONLY the question the student has written.\n"
    "Rules:\n"
    "- Convert mathematics to LaTeX inside $...$ (inline) or $$...$$ (display).\n"
    "- Ignore ruled lines, margins and blank space.\n"
    "- Do not solve it. Do not add commentary.\n"
    "Reply with JSON only: "
    '{"question":"...","subject_guess":"...","has_diagram":true|false,"confidence":0.0-1.0}'
)


def crop_ink(path, pad=40):
    """Crop to the inked bounding box, ignoring the pale ruled background."""
    im = Image.open(path).convert("RGB")
    g = im.convert("L")
    # ink is dark; ruled lines are pale -> threshold well below them
    bw = g.point(lambda v: 0 if v < 150 else 255, "L")
    bbox = bw.point(lambda v: 255 if v == 0 else 0, "L").getbbox()
    if not bbox:
        return im
    l, t, r, b = bbox
    return im.crop((max(0, l - pad), max(0, t - pad),
                    min(im.width, r + pad), min(im.height, b + pad)))


def b64(im, max_side=1400):
    if max(im.size) > max_side:
        s = max_side / max(im.size)
        im = im.resize((int(im.width * s), int(im.height * s)), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, format="PNG", optimize=True)
    return base64.b64encode(buf.getvalue()).decode(), im.size


def ollama_ps():
    try:
        out = subprocess.run(["ollama", "ps"], capture_output=True, text=True, timeout=20).stdout
        return [l for l in out.splitlines() if l.strip()]
    except Exception as e:
        return [f"ollama ps failed: {e}"]


def chat(messages, think=False, num_ctx=8192, num_predict=1024, timeout=1800):
    body = {
        "model": MODEL, "messages": messages, "stream": True, "think": think,
        "options": {"num_ctx": num_ctx, "num_predict": num_predict, "temperature": 0.2},
    }
    t0 = time.perf_counter()
    first = None
    text, thinking = [], []
    final = {}
    with httpx.stream("POST", f"{OLLAMA}/api/chat", json=body, timeout=timeout) as r:
        r.raise_for_status()
        for line in r.iter_lines():
            if not line.strip():
                continue
            d = json.loads(line)
            msg = d.get("message") or {}
            if msg.get("thinking"):
                thinking.append(msg["thinking"])
            c = msg.get("content")
            if c:
                if first is None:
                    first = time.perf_counter() - t0
                text.append(c)
            if d.get("done"):
                final = d
    total = time.perf_counter() - t0
    ec = final.get("eval_count") or 0
    ed = (final.get("eval_duration") or 0) / 1e9
    pc = final.get("prompt_eval_count") or 0
    pd = (final.get("prompt_eval_duration") or 0) / 1e9
    return {
        "text": "".join(text), "thinking": "".join(thinking),
        "total_s": round(total, 2), "ttft_s": round(first, 2) if first else None,
        "prompt_tokens": pc, "prompt_eval_s": round(pd, 2),
        "gen_tokens": ec, "gen_s": round(ed, 2),
        "tok_per_s": round(ec / ed, 2) if ed else None,
    }


def main():
    results = {"model": MODEL, "runs": []}
    imgs = sorted((HERE / "images").glob("*.png"))

    print(f"== warming {MODEL} ==", flush=True)
    w = chat([{"role": "user", "content": "Say READY."}], num_predict=8)
    print("warm:", w["total_s"], "s |", w["text"].strip()[:40], flush=True)
    results["warm"] = w
    results["ps_after_load"] = ollama_ps()
    print("\n".join(results["ps_after_load"]), flush=True)

    for p in imgs:
        name = p.stem
        for mode in ("full", "cropped"):
            im = Image.open(p).convert("RGB") if mode == "full" else crop_ink(p)
            enc, size = b64(im)
            print(f"\n== EXTRACT {name} [{mode}] {size} ==", flush=True)
            r = chat([{"role": "user", "content": EXTRACT_PROMPT, "images": [enc]}],
                     think=False, num_predict=512)
            print(f"  ttft={r['ttft_s']}s total={r['total_s']}s "
                  f"prompt={r['prompt_tokens']}tok/{r['prompt_eval_s']}s "
                  f"gen={r['gen_tokens']}tok@{r['tok_per_s']}tok/s", flush=True)
            print("  ->", r["text"].strip()[:400].replace("\n", " "), flush=True)
            results["runs"].append({"image": name, "stage": "extract", "mode": mode,
                                    "img_size": size, **r})
            (HERE / "results.json").write_text(json.dumps(results, indent=2))

    # Solve pass on one extracted question, streaming, think off then on
    q = "Evaluate the integral $I=\int x^2 e^{3x}\,dx$ using integration by parts. Show all steps."
    for think in (False, True):
        print(f"\n== SOLVE (think={think}) ==", flush=True)
        r = chat([{"role": "user", "content":
                   "Solve this exam question with numbered steps and LaTeX math.\n\n" + q}],
                 think=think, num_predict=900)
        print(f"  ttft={r['ttft_s']}s total={r['total_s']}s "
              f"gen={r['gen_tokens']}tok@{r['tok_per_s']}tok/s "
              f"thinking_chars={len(r['thinking'])}", flush=True)
        results["runs"].append({"image": "-", "stage": f"solve_think_{think}", **r})
        (HERE / "results.json").write_text(json.dumps(results, indent=2))

    results["ps_final"] = ollama_ps()
    print("\n".join(results["ps_final"]), flush=True)
    (HERE / "results.json").write_text(json.dumps(results, indent=2))
    print("\nDONE -> bench/results.json", flush=True)


if __name__ == "__main__":
    main()
