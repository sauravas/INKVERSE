"""Ask the real model for a real diagram, and see what comes back.

Everything else about figures can be checked without a model: the library is
ours, the parser is ours, the drawing is ours. The one thing that cannot be is
whether the model, told which objects we can draw, actually answers in the
labelled form for them - or whether it writes prose, or invents a flowchart,
and the student gets no figure at all.

    .venv\\Scripts\\python.exe bench\\figure_live.py
"""
from __future__ import annotations

import json
import sys
import time
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

BASE = "http://127.0.0.1:8000"
QUESTIONS = [
    "Draw a labelled diagram of the human heart and explain each part.",
    "With a neat labelled diagram, describe the structure of a neuron.",
]

fails = 0


def check(name, cond, detail=""):
    global fails
    print(("  ok   " if cond else "  FAIL ") + name
          + (f"  ({detail})" if detail and not cond else ""))
    fails += 0 if cond else 1


def solve(question: str) -> tuple[list[dict], float]:
    """Run one answer through the real pipeline, collecting the typed events."""
    body = json.dumps({"question": question, "provider": "local",
                       "room": "figlive"}).encode()
    req = urllib.request.Request(BASE + "/api/ai/solve", data=body,
                                 headers={"Content-Type": "application/json"})
    events, t0 = [], time.perf_counter()
    with urllib.request.urlopen(req, timeout=900) as r:
        for raw in r:
            line = raw.decode("utf-8", "replace").strip()
            if line.startswith("data:"):
                try:
                    events.append(json.loads(line[5:].strip()))
                except json.JSONDecodeError:
                    pass
    return events, time.perf_counter() - t0


try:
    urllib.request.urlopen(BASE + "/api/status", timeout=5).read()
except Exception:
    print("INKWISE is not running.")
    raise SystemExit(2)

for q in QUESTIONS:
    print(f"\n{q}")
    events, dt = solve(q)
    figs = [e.get("diagram") for e in events
            if e.get("kind") == "diagram" and e.get("diagram")]
    drawn = [f for f in figs if f.get("kind") == "figure"]
    text = " ".join(str(e.get("value", "")) for e in events if e.get("kind") == "text")

    print(f"  {dt:.1f}s, {len(events)} events, {len(figs)} diagram(s)")
    check("the model drew a figure", bool(drawn),
          f"diagram kinds: {[f.get('kind') for f in figs]}")
    for f in figs:
        if f.get("kind") != "figure":
            # what it wrote instead, so the gap is readable rather than guessed
            label = {n["id"]: n["label"] for n in f["nodes"]}
            print(f"  not drawn ({f['kind']}) - {f['title']!r}")
            for e in f["edges"]:
                print(f"      {label[e['from']]} -> {label[e['to']]}"
                      + (f" : {e['label']}" if e["label"] else ""))
    if drawn:
        f = drawn[0]["figure"]
        print(f"  -> {f['title']}: " + ", ".join(p["label"] for p in f["parts"]))
        check("with several parts labelled", len(f["parts"]) >= 3, len(f["parts"]))
        check("each part says what it does",
              sum(1 for p in f["parts"] if p["note"]) >= len(f["parts"]) - 1)
        if f["dropped"]:
            print(f"  (named but not in the library: {', '.join(f['dropped'])})")
    # the drawing is the figure's job; the prose should not be describing it
    check("it did not try to describe the drawing in words",
          "@@" not in text and "draw a" not in text.lower())

print("\n" + (f"{fails} FAILED" if fails else "ALL PASSED"))
sys.exit(1 if fails else 0)
