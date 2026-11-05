"""Live: does the real model use diagrams and tables where they help, and only
there? Needs Ollama. Prints what each answer contained and how long it took."""
import json
import sys
import time

import httpx

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
URL = "http://127.0.0.1:8000/api/ai/solve"

CASES = [
    ("Explain the five-state process model of an operating system with a diagram.",
     {"diagram"}, None),
    ("Write a flowchart to check whether a number is prime.", {"diagram"}, "flowchart"),
    ("Explain the PDCA (Plan-Do-Check-Act) cycle.", {"diagram"}, "cycle"),
    ("Label the main parts of a CPU and say what each part does.", {"diagram"}, "labelled"),
    ("Compare a process and a thread.", {"table"}, None),
    ("Find the derivative of $x^2 \\sin x$.", set(), None),
]


def solve(q):
    ev, t0 = [], time.perf_counter()
    with httpx.stream("POST", URL, json={"question": q}, timeout=1800) as r:
        r.raise_for_status()
        for line in r.iter_lines():
            if line.startswith("data:") and line[5:].strip():
                ev.append(json.loads(line[5:]))
    return ev, time.perf_counter() - t0


def main():
    results = []
    for q, want, want_kind in CASES:
        ev, dt = solve(q)
        err = [e["message"] for e in ev if e["type"] == "error"]
        fell_back = [e["message"] for e in ev if e["type"] == "notice"]
        segs = [e for e in ev if e["type"] == "segment"]
        blocks = [e["kind"] for e in segs if e["kind"] in ("diagram", "table")]
        kinds = [e["diagram"].get("kind") for e in segs if e["kind"] == "diagram"]
        got = set(blocks)
        if not want:
            ok = not got and not err
        else:
            ok = want <= got and not err and (want_kind is None or want_kind in kinds)
        detail = ", ".join(
            f"diagram/{e['diagram']['kind']} ({len(e['diagram']['nodes'])} blocks)"
            if e["kind"] == "diagram" else
            f"table {len(e['table']['header'])}x{len(e['table']['rows'])}"
            for e in segs if e["kind"] in ("diagram", "table")) or "text only"
        print(f"{'PASS' if ok else 'MISS'}  {dt:5.0f}s  {q[:58]:58}  -> {detail}"
              + (f"  ERROR {err[0][:80]}" if err else "")
              + ("  [small model fallback]" if fell_back else ""), flush=True)
        results.append(ok)
    print(f"\nLIVE BLOCKS: {sum(results)}/{len(results)} as expected")


if __name__ == "__main__":
    main()
