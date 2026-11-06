"""Where the seconds go when the app answers a question - with its real prompt.

where_time_goes.py measures the model on a bare question. That is not what the
app sends: every answer carries the whole output-format rules block, the
subject, any retrieved context and the session so far. Prefill is charged on
all of it, every time, so it has to be measured as the app actually sends it
or the numbers are about a different program.

Reports, per question, the three costs that look identical from the outside:

    prefill   reading the prompt      (tokens in  / tok/s)
    write     writing the answer      (tokens out / tok/s)
    load      bringing the model in   (0 when it is already resident)

    .venv\\Scripts\\python.exe bench\\answer_speed.py
    .venv\\Scripts\\python.exe bench\\answer_speed.py --options num_ctx=4096
"""
from __future__ import annotations

import json
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from app import config  # noqa: E402
from app.ai import prompts  # noqa: E402

URL = "http://127.0.0.1:11434"
NS = 1_000_000_000

# what students actually ask, at the two lengths that behave differently
QUESTIONS = [
    ("numerical", "Differentiate 4x^2 + 3x with respect to x. Show every step."),
    ("theory", "Explain the difference between a process and a thread, "
               "with a comparison table."),
    ("diagram", "Draw a labelled diagram of the human heart and explain each part."),
]


def post(path: str, body: dict, timeout=900):
    req = urllib.request.Request(URL + path, data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json"})
    return urllib.request.urlopen(req, timeout=timeout)


def messages(question: str) -> list[dict]:
    """Exactly what OllamaProvider.solve() builds."""
    return [
        {"role": "system", "content": prompts.SOLVE_SYSTEM},
        {"role": "user", "content": prompts.SOLVE_USER.format(
            question=question, subject_line="",
            context_block=prompts.context_block(""),
            figure_block=prompts.figure_block(question),
            session_block=prompts.session_block([]))},
    ]


def run(model: str, question: str, options: dict) -> dict:
    body = {"model": model, "stream": True, "keep_alive": config.OLLAMA_KEEP_ALIVE,
            "messages": messages(question), "options": options}
    first = None
    t0 = time.perf_counter()
    stats = {}
    with post("/api/chat", body) as r:
        for raw in r:
            line = raw.decode("utf-8", "replace").strip()
            if not line:
                continue
            d = json.loads(line)
            if first is None and d.get("message", {}).get("content"):
                first = time.perf_counter() - t0
            if d.get("done"):
                stats = d
    wall = time.perf_counter() - t0
    return {
        "wall": wall,
        "first": first or wall,
        "load": stats.get("load_duration", 0) / NS,
        "in_tok": stats.get("prompt_eval_count", 0),
        "in_s": stats.get("prompt_eval_duration", 0) / NS,
        "out_tok": stats.get("eval_count", 0),
        "out_s": stats.get("eval_duration", 0) / NS,
    }


def show(label: str, r: dict) -> None:
    rate = (r["out_tok"] / r["out_s"]) if r["out_s"] else 0
    prate = (r["in_tok"] / r["in_s"]) if r["in_s"] else 0
    print(f"  {label:10s} {r['wall']:6.1f}s total   "
          f"first token {r['first']:5.1f}s   "
          f"load {r['load']:4.1f}s   "
          f"prefill {r['in_tok']:5d} tok in {r['in_s']:5.1f}s ({prate:6.1f}/s)   "
          f"write {r['out_tok']:5d} tok in {r['out_s']:5.1f}s ({rate:5.1f}/s)")


def main() -> int:
    opts = {"num_ctx": config.OLLAMA_NUM_CTX, "num_predict": 1400,
            "temperature": 0.3}
    for arg in sys.argv[1:]:
        if arg.startswith("num_") or arg.startswith("temp"):
            k, _, v = arg.partition("=")
            opts[k] = float(v) if "." in v else int(v)
    model = config.TEXT_MODEL
    print(f"{model}  options {opts}")
    print(f"system prompt {len(prompts.SOLVE_SYSTEM)} chars\n")

    # one throwaway pass so the model is resident and the numbers are about
    # answering rather than loading
    run(model, "What is 2 + 2?", {**opts, "num_predict": 8})

    totals = []
    for name, q in QUESTIONS:
        r = run(model, q, opts)
        show(name, r)
        totals.append(r)

    out = sum(t["out_tok"] for t in totals)
    sec = sum(t["wall"] for t in totals)
    inn = sum(t["in_tok"] for t in totals)
    pre = sum(t["in_s"] for t in totals)
    print(f"\n  {sec:.1f}s for {out} tokens of answer; "
          f"{pre:.1f}s of that was reading {inn} tokens of prompt "
          f"({100 * pre / sec:.0f}% of the wait)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
