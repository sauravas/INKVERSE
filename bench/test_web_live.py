"""Live check of web-grounded solving. Needs Ollama and internet access.

- A factual question with web on is grounded in web sources and gets the
  facts right (the case that hallucinated before: "Who is Virat ...").
- A calculation with web on skips the web and says why.
- With web off, nothing leaves the machine: no web sources at all.
"""
import json
import sys
import time

import httpx

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
BASE = "http://127.0.0.1:8000/api/ai/solve"


def run(body, stop_after_notice=False):
    events, t0 = [], time.perf_counter()
    with httpx.stream("POST", BASE, json=body, timeout=1500) as r:
        r.raise_for_status()
        for line in r.iter_lines():
            if not line.startswith("data:") or not line[5:].strip():
                continue
            e = json.loads(line[5:])
            events.append(e)
            if stop_after_notice and e["type"] in ("notice", "segment"):
                break
    return events, time.perf_counter() - t0


def check(name, cond, detail=""):
    print(f"{'PASS' if cond else 'FAIL'}  {name}{('  ' + detail) if detail else ''}")
    return cond


def main():
    ok = True

    ev, dt = run({"question": "Who is Virat Kohli?", "web": True})
    src = next((e["items"] for e in ev if e["type"] == "sources"), [])
    web = [s for s in src if s.get("kind") == "web"]
    text = "".join(e["value"] for e in ev if e["type"] == "segment")
    err = [e["message"] for e in ev if e["type"] == "error"]
    print(f"\nanswer ({dt:.0f}s, {len(text)} chars): {text.strip()[:300]!r}...\n")
    ok &= check("solve with web on completed", not err, err[0] if err else "")
    ok &= check("answer grounded in web sources", len(web) >= 1,
                str([f"{s['site']}: {s['title']}" for s in web]))
    ok &= check("answer gets the facts right (cricketer, India)",
                "cricket" in text.lower() and "india" in text.lower())

    ev, _ = run({"question": "Find the derivative of $4x^2$", "web": True},
                stop_after_notice=True)
    notes = [e["message"] for e in ev if e["type"] == "notice"]
    src = next((e["items"] for e in ev if e["type"] == "sources"), [])
    ok &= check("calculation skips the web and says why",
                any("skipped" in n for n in notes) and not src, str(notes))

    ev, _ = run({"question": "Who is Virat Kohli?", "web": False},
                stop_after_notice=True)
    src = next((e["items"] for e in ev if e["type"] == "sources"), [])
    ok &= check("with web off, no web sources are used",
                not [s for s in src if s.get("kind") == "web"])

    print("\nLIVE WEB RESULT:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
