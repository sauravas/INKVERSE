"""Where do the seconds actually go?

Before tuning anything, separate the three costs that look identical from the
outside: loading the model into memory, reading the prompt (prefill), and
writing the answer. They have completely different fixes, and guessing wrong
is how you end up shortening answers to cure a loading problem.

    .venv\\Scripts\\python.exe bench\\where_time_goes.py
"""
from __future__ import annotations

import json
import sys
import time
import urllib.request

URL = "http://127.0.0.1:11434"
QUESTION = "Differentiate 4x^2 + 3x with respect to x. Show every step."


def post(path: str, body: dict, timeout=900):
    req = urllib.request.Request(URL + path, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    return urllib.request.urlopen(req, timeout=timeout)


def unload(model: str):
    try:
        post("/api/generate", {"model": model, "keep_alive": 0}, timeout=60).read()
    except Exception:
        pass
    time.sleep(1.5)


def run(model: str, num_ctx: int, num_predict: int, cold: bool, prompt=QUESTION):
    if cold:
        unload(model)
    body = {"model": model, "stream": True, "keep_alive": "10m",
            "messages": [{"role": "user", "content": prompt}],
            "options": {"num_ctx": num_ctx, "num_predict": num_predict,
                        "temperature": 0.3, "top_p": 0.95}}
    t0 = time.perf_counter()
    first = None
    text = []
    stats = {}
    for raw in post("/api/chat", body):
        line = raw.decode().strip()
        if not line:
            continue
        d = json.loads(line)
        piece = (d.get("message") or {}).get("content")
        if piece:
            if first is None:
                first = time.perf_counter() - t0
            text.append(piece)
        if d.get("done"):
            stats = d
    total = time.perf_counter() - t0
    ns = 1e9
    load = stats.get("load_duration", 0) / ns
    prefill = stats.get("prompt_eval_duration", 0) / ns
    gen = stats.get("eval_duration", 0) / ns
    out_tokens = stats.get("eval_count", 0)
    return {
        "total": round(total, 1), "ttft": round(first or 0, 1),
        "load": round(load, 1), "prefill": round(prefill, 2),
        "generate": round(gen, 1), "tokens": out_tokens,
        "tok_s": round(out_tokens / gen, 1) if gen else 0,
        "chars": len("".join(text)),
    }


def show(label, r):
    print(f"{label:34s} total {r['total']:6.1f}s = load {r['load']:5.1f}s "
          f"+ prefill {r['prefill']:5.2f}s + write {r['generate']:5.1f}s   "
          f"({r['tokens']:4d} tokens at {r['tok_s']:4.1f}/s, ttft {r['ttft']:.1f}s)")


def main() -> int:
    try:
        urllib.request.urlopen(URL + "/api/version", timeout=5).read()
    except Exception:
        print("Ollama is not running.")
        return 2

    print("Each row is one real request. 'load' is the model being read into\n"
          "memory, 'prefill' is it reading the prompt, 'write' is it producing\n"
          "the answer.\n")

    show("14b cold, ctx 8192", run("qwen2.5:14b", 8192, 2048, cold=True))
    show("14b warm, ctx 8192", run("qwen2.5:14b", 8192, 2048, cold=False))
    show("14b warm, ctx 4096", run("qwen2.5:14b", 4096, 2048, cold=False))
    show("14b cold, ctx 4096", run("qwen2.5:14b", 4096, 2048, cold=True))
    show("14b warm, ctx 2048", run("qwen2.5:14b", 2048, 2048, cold=False))
    show("14b warm, cap 600 tokens", run("qwen2.5:14b", 4096, 600, cold=False))
    print()
    show("4b  cold, ctx 4096", run("gemma3:4b", 4096, 2048, cold=True))
    show("4b  warm, ctx 4096", run("gemma3:4b", 4096, 2048, cold=False))

    print("\nSwapping stages (what a handwritten question costs):")
    unload("qwen2.5:14b")
    unload("gemma3:4b")
    t0 = time.perf_counter()
    run("gemma3:4b", 4096, 300, cold=False)
    t1 = time.perf_counter()
    unload("gemma3:4b")                      # what EXCLUSIVE_MODELS does
    run("qwen2.5:14b", 4096, 2048, cold=False)
    t2 = time.perf_counter()
    print(f"  read the page with 4b: {t1 - t0:.1f}s, then evict it and load "
          f"14b to answer: {t2 - t1:.1f}s  (total {t2 - t0:.1f}s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
