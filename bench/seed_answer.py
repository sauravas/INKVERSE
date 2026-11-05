"""Insert a solved question so the answer sheet can be rendered and looked at.

The step/segment shape here is exactly what the SSE parser emits, so this also
checks that the persisted format round-trips into the UI.
"""
import json
import sys

import httpx

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
BASE = "http://127.0.0.1:8000/api/study"


def t(v):
    return {"kind": "text", "value": v, "display": False}


def m(v, display=False):
    return {"kind": "math", "value": v, "display": display}


BREAK = {"kind": "break", "value": "", "display": False}

STEPS = [
    {"index": 1, "title": "Choose the parts", "final": False, "segments": [
        t("Integration by parts states "), m(r"\int u\,dv = uv - \int v\,du"),
        t(". Take\n"), BREAK,
        m(r"u = x^2 \quad\text{and}\quad dv = e^{3x}\,dx"), t("\n"),
        t("so that differentiating "), m("u"),
        t(" lowers the power of "), m("x"), t(".\n"),
    ]},
    {"index": 2, "title": "Differentiate and integrate", "final": False, "segments": [
        t("This gives "), m(r"du = 2x\,dx"), t(" and "),
        m(r"v = \tfrac{1}{3}e^{3x}"), t(".\n"),
    ]},
    {"index": 3, "title": "Apply the formula", "final": False, "segments": [
        m(r"I = \frac{x^2 e^{3x}}{3} - \frac{2}{3}\int x e^{3x}\,dx", True),
        t("The remaining integral is simpler, so repeat the process.\n"),
    ]},
    {"index": 4, "title": "Second application", "final": False, "segments": [
        t("With "), m("u = x"), t(" and "), m(r"dv = e^{3x}dx"), t(":\n"), BREAK,
        m(r"\int x e^{3x}\,dx = \frac{x e^{3x}}{3} - \frac{1}{9}e^{3x}", True),
    ]},
    {"index": 5, "title": "Final answer", "final": True, "segments": [
        m(r"I = \frac{e^{3x}}{27}\left(9x^2 - 6x + 2\right) + C", True),
        t("Check by differentiating: the "), m("e^{3x}"),
        t(" terms recombine to "), m("x^2 e^{3x}"), t(".\n"),
    ]},
]


def main():
    c = httpx.Client(base_url=BASE, timeout=30)
    subs = c.get("/subjects").json()
    sub = next((s for s in subs if "Mathematics" in s["name"]), subs[0] if subs else None)
    mod = sub["modules"][0]["id"] if sub and sub["modules"] else None

    text = (r"Evaluate the integral $I=\int x^2 e^{3x}\,dx$ using "
            r"integration by parts. Show all steps.")
    q = c.post("/questions", json={
        "text": text, "module_id": mod,
        "subject_id": sub["id"] if sub else None,
        "answer_json": json.dumps(STEPS),
        "answer_md": "(rendered from structured steps)",
        "important": True,
    }).json()
    print("created question", q["id"])
    print("steps:", len(STEPS),
          "math segments:", sum(1 for s in STEPS for x in s["segments"]
                                if x["kind"] == "math"))
    return q["id"]


if __name__ == "__main__":
    main()
