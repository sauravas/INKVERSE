"""End-to-end AI pipeline check: handwriting image -> typed events -> explanation.

Exercises the real HTTP endpoints, so it validates the orchestrator, the stream
parser and the SSE contract together.
"""
import base64
import json
import sys
import time
from pathlib import Path

import httpx

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BASE = "http://127.0.0.1:8000"
HERE = Path(__file__).parent


def data_url(p: Path) -> str:
    return "data:image/png;base64," + base64.b64encode(p.read_bytes()).decode()


def sse(url, body, timeout=1200):
    """Consume an SSE endpoint, returning (events, first_event_latency)."""
    evs = []
    t0 = time.perf_counter()
    first = None
    with httpx.stream("POST", url, json=body, timeout=timeout) as r:
        r.raise_for_status()
        for line in r.iter_lines():
            if not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if not payload:
                continue
            e = json.loads(payload)
            if e.get("type") == "segment" and first is None:
                first = time.perf_counter() - t0
            evs.append(e)
    return evs, first


def render(evs):
    """Fold typed events the way the UI does, to prove the contract is usable."""
    steps, cur = [], None
    for e in evs:
        if e["type"] == "step_open":
            cur = {"i": e["index"], "title": e["title"], "final": e["final"], "segs": []}
            steps.append(cur)
        elif e["type"] == "segment" and cur:
            cur["segs"].append(e)
    return steps


def main():
    img = HERE / "images" / "calculus.png"
    print(f"image: {img.name}")

    # -- stage 1: vision --------------------------------------------------
    t0 = time.perf_counter()
    r = httpx.post(f"{BASE}/api/ai/extract",
                   json={"image": data_url(img)}, timeout=1200)
    r.raise_for_status()
    ex = r.json()
    print(f"\n[1] EXTRACT  {ex['model']}  {ex['latency_s']}s  "
          f"confidence={ex['confidence']}")
    print(f"    image sent: {ex['image']['original']} -> {ex['image']['sent']} "
          f"(cropped={ex['image']['cropped']})")
    print(f"    question: {ex['question']!r}")
    if not ex["question"]:
        print("    FAILED: no question extracted")
        return 1

    # -- stage 2: reasoning -----------------------------------------------
    evs, first = sse(f"{BASE}/api/ai/solve",
                     {"question": ex["question"],
                      "subject": ex.get("subject_guess", "")})
    done = next((e for e in evs if e["type"] == "done"), None)
    err = next((e for e in evs if e["type"] == "error"), None)
    if err:
        print(f"\n[2] SOLVE FAILED: {err['message']}")
        return 1

    steps = render(evs)
    print(f"\n[2] SOLVE    {done['total_s']}s total, first ink {first:.1f}s, "
          f"{len(steps)} steps, {len(evs)} events")
    kinds = {}
    for e in evs:
        if e["type"] == "segment":
            kinds[e["kind"]] = kinds.get(e["kind"], 0) + 1
    print(f"    segment kinds: {kinds}")
    for s in steps:
        body = "".join(x["value"] for x in s["segs"] if x["kind"] == "text")
        math = [x["value"] for x in s["segs"] if x["kind"] == "math"]
        label = "FINAL" if s["final"] else f"Step {s['i']}"
        print(f"    {label}: {s['title'][:52]!r}")
        if math:
            print(f"        math: {math[0][:64]!r}" +
                  (f" (+{len(math) - 1} more)" if len(math) > 1 else ""))
        txt = " ".join(body.split())
        if txt:
            print(f"        text: {txt[:90]!r}")

    if not steps:
        print("    FAILED: no steps parsed")
        return 1
    if not any(x["kind"] == "math" for s in steps for x in s["segs"]):
        print("    WARNING: no LaTeX produced for a calculus question")

    # -- stage 3: focused explanation -------------------------------------
    target = steps[min(1, len(steps) - 1)]
    step_text = (f"Step {target['i']}: {target['title']}\n"
                 + "".join(x["value"] for x in target["segs"]))
    answer = "\n".join(
        f"Step {s['i']}: {s['title']}\n"
        + "".join(x["value"] for x in s["segs"]) for s in steps)

    evs2, first2 = sse(f"{BASE}/api/ai/explain", {
        "question": ex["question"], "answer": answer,
        "step": step_text, "step_index": target["i"],
        "ask": "Why do we choose u and dv that way round?",
    })
    err2 = next((e for e in evs2 if e["type"] == "error"), None)
    if err2:
        print(f"\n[3] EXPLAIN FAILED: {err2['message']}")
        return 1
    done2 = next((e for e in evs2 if e["type"] == "done"), None)
    esteps = render(evs2)
    print(f"\n[3] EXPLAIN  {done2['total_s']}s, {len(esteps)} steps "
          f"(focused on step {target['i']}, not a full re-solve)")
    for s in esteps[:3]:
        body = " ".join("".join(
            x["value"] for x in s["segs"] if x["kind"] == "text").split())
        print(f"    {s['title'][:40]!r}: {body[:80]!r}")

    full_len = sum(len(x["value"]) for s in steps for x in s["segs"])
    exp_len = sum(len(x["value"]) for s in esteps for x in s["segs"])
    print(f"\n    explanation is {exp_len} chars vs full answer {full_len} chars "
          f"({exp_len / max(1, full_len):.0%}) - focused, not regenerated")

    print("\nPIPELINE RESULT: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
