"""Live model check: the hint must help without giving the answer away, and
both hint and solve must be grounded in imported material when it exists.

Needs Ollama. Uses a throwaway subject and removes it afterwards.
"""
import json
import re
import sys
import time

import httpx

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
BASE = "http://127.0.0.1:8000/api"

NOTES = """Module 2: Laplace Transform
Definition: L{f(t)} = integral from 0 to infinity of e^(-st) f(t) dt.
First shifting theorem: if L{f(t)} = F(s) then L{e^(at) f(t)} = F(s - a).
Standard results: L{t^n} = n!/s^(n+1), L{sin bt} = b/(s^2 + b^2).
"""
QUESTION = "Find the Laplace transform of $e^{3t} t^2$."
# the full answer is 2/(s-3)^3; a hint must not state it
ANSWER_PATTERNS = [r"2\s*/\s*\(?\s*s\s*-\s*3\s*\)?\s*\^?\s*\{?3",
                   r"\\frac\{2\}\{\(s\s*-\s*3\)\^\{?3"]


def stream(c, path, body):
    events, t0 = [], time.perf_counter()
    with c.stream("POST", path, json=body, timeout=1200) as r:
        r.raise_for_status()
        for line in r.iter_lines():
            if line.startswith("data:") and line[5:].strip():
                events.append(json.loads(line[5:]))
    return events, time.perf_counter() - t0


def text_of(events):
    return "".join(e["value"] for e in events if e["type"] == "segment")


def check(name, cond, detail=""):
    print(f"{'PASS' if cond else 'FAIL'}  {name}{('  ' + detail) if detail else ''}")
    return cond


def main():
    c = httpx.Client(base_url=BASE, timeout=120)
    ok = True
    tag = f"__hint_test_{int(time.time())}"
    commit = c.post("/import/commit", json={
        "subject_name": tag, "filename": "laplace-notes.txt", "kind": "syllabus",
        "text": NOTES, "modules": [{"name": "Module 2: Laplace Transform",
                                    "notes": NOTES, "questions": [{"text": QUESTION}]}]}).json()
    sid = commit["subject_id"]
    try:
        subj = next(s for s in c.get("/study/subjects").json() if s["id"] == sid)
        qid = c.get("/study/questions", params={"subject_id": sid}).json()[0]["id"]
        print(f"subject {tag}, question {qid}\n")

        ev, dt = stream(c, "/ai/hint", {"question": QUESTION, "question_id": qid})
        err = [e for e in ev if e["type"] == "error"]
        hint = text_of(ev)
        src = next((e["items"] for e in ev if e["type"] == "sources"), [])
        print(f"hint ({dt:.0f}s): {hint.strip()!r}\n")
        ok &= check("hint streamed without error", not err, err[0]["message"] if err else "")
        ok &= check("hint is short", 0 < len(hint) < 600, f"{len(hint)} chars")
        ok &= check("hint does not give the final answer",
                    not any(re.search(p, hint) for p in ANSWER_PATTERNS))
        ok &= check("hint points at the right idea",
                    re.search(r"shift|F\(s\s*-\s*3\)|s\s*-\s*3|t\^2|t\^n|n!", hint, re.I)
                    is not None)
        ok &= check("hint grounded in the imported notes",
                    any("Laplace" in (s.get("heading") or "") for s in src),
                    str([s.get("heading") for s in src]))
    finally:
        c.delete(f"/study/subjects/{sid}")
        for s in c.get("/import/sources").json():
            if s["subject_id"] == sid:
                c.delete(f"/import/sources/{s['id']}")
    print("\nLIVE HINT RESULT:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
