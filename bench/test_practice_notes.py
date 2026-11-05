"""Practice flow, notes, sharing and the friend-import round trip, over HTTP.

Creates a throwaway subject, plays through a module the way the UI does, and
removes everything it created at the end.
"""
import asyncio
import json
import sys
import time

import httpx
import websockets

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
BASE = "http://127.0.0.1:8000"
TAG = f"__practice_test_{int(time.time())}"

STEPS = [{"index": 1, "title": "Power rule", "final": False,
          "segments": [{"kind": "math", "value": r"\frac{d}{dx}x^n = nx^{n-1}",
                        "display": True}]},
         {"index": 2, "title": "Final answer", "final": True,
          "segments": [{"kind": "math", "value": "8x", "display": True}]}]
HINT = [{"index": 1, "title": "Hint", "final": False,
         "segments": [{"kind": "text", "value": "Use the power rule.", "display": False}]}]
PNG = ("data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4"
       "2mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==")


def check(name, cond, detail=""):
    print(f"{'PASS' if cond else 'FAIL'}  {name}{('  ' + detail) if detail else ''}")
    return cond


async def page_open_check():
    """Laptop opens a per-question page; a phone in the room must follow it."""
    room = TAG[-10:]
    async with websockets.connect(f"ws://127.0.0.1:8000/ws/{room}?role=laptop") as lap, \
               websockets.connect(f"ws://127.0.0.1:8000/ws/{room}?role=phone") as ph:
        await lap.recv(); await ph.recv()
        seed = [{"id": "s1", "tool": "pen", "color": "#000", "size": 2, "pts": [[1, 2, .5, 0]]}]
        await lap.send(json.dumps({"t": "page_open", "id": "q-abc", "title": "Q1",
                                   "strokes": seed}))
        snap = None
        for _ in range(6):
            m = json.loads(await asyncio.wait_for(ph.recv(), 5))
            if m.get("t") == "pages":
                snap = m["snapshot"]
                break
        active = snap["pages"][snap["active"]] if snap else {}
        ok = check("phone follows the laptop onto the question's page",
                   active.get("id") == "q-abc")
        ok &= check("saved answer strokes are seeded onto that page",
                    len(active.get("strokes", [])) == 1
                    and active["strokes"][0]["pageId"] == "q-abc")
        # opening the same page again must not duplicate it
        await lap.send(json.dumps({"t": "page_open", "id": "q-abc", "title": "Q1"}))
        for _ in range(6):
            m = json.loads(await asyncio.wait_for(ph.recv(), 5))
            if m.get("t") == "pages":
                snap = m["snapshot"]
                break
        ok &= check("re-opening a question page does not duplicate it",
                    sum(1 for p in snap["pages"] if p["id"] == "q-abc") == 1)
        return ok


def main():
    c = httpx.Client(base_url=BASE, timeout=60)
    ok = True

    sub = c.post("/api/study/subjects", json={"name": TAG}).json()
    mod = c.post("/api/study/modules", json={"subject_id": sub["id"],
                                             "name": "Differentiation"}).json()
    q1 = c.post("/api/study/questions", json={"module_id": mod["id"],
                "text": "Differentiate $4x^2$", "important": True}).json()
    q2 = c.post("/api/study/questions", json={"module_id": mod["id"],
                "text": "Differentiate $\\sin x$"}).json()

    s = c.get(f"/api/practice/module/{mod['id']}").json()
    ok &= check("session lists the module's questions in order",
                [q["id"] for q in s["questions"]] == [q1["id"], q2["id"]])
    ok &= check("session starts at the first unfinished question", s["resume_index"] == 0)

    # Q1: student writes, asks for a hint, still stuck, sees the answer
    strokes = [{"id": "a1", "tool": "pen", "color": "#16213a", "size": 2.4,
                "pts": [[10, 20, .5, 0], [30, 40, .5, 9]]}]
    c.put(f"/api/practice/question/{q1['id']}/attempt",
          json={"strokes": strokes, "image": PNG, "hint_steps": HINT})
    c.patch(f"/api/study/questions/{q1['id']}",
            json={"answer_json": json.dumps(STEPS)})
    c.put(f"/api/practice/question/{q1['id']}/attempt", json={"strokes": strokes})
    detail = c.get(f"/api/practice/question/{q1['id']}").json()
    ok &= check("attempt saved once and updated in place",
                detail["attempt"]["strokes"] == strokes
                and detail["attempt"]["hint_steps"] == HINT
                and detail["attempt"]["image"] == PNG,
                "(a later save without hint/image keeps both)")
    r = c.post(f"/api/practice/question/{q1['id']}/finish",
               json={"outcome": "answer"}).json()
    ok &= check("needing the answer -> studied, recall logged as missed",
                r["status"] == "studied" and r["recall_total"] == 1
                and r["recall_correct"] == 0, str(r))

    s = c.get(f"/api/practice/module/{mod['id']}").json()
    ok &= check("session resumes at question 2", s["resume_index"] == 1)

    # Q2: knew it straight away
    r = c.post(f"/api/practice/question/{q2['id']}/finish",
               json={"outcome": "knew"}).json()
    ok &= check("knowing it -> studied, recall logged as correct",
                r["status"] == "studied" and r["recall_correct"] == 1)
    r = c.post(f"/api/practice/question/{q2['id']}/finish",
               json={"outcome": "knew"}).json()
    ok &= check("practising again -> revised, revision counted",
                r["status"] == "revised" and r["revisions"] == 1, str(r))
    bad = c.post(f"/api/practice/question/{q2['id']}/finish", json={"outcome": "maybe"})
    ok &= check("unknown outcome rejected", bad.status_code == 400)

    # notes
    n = c.get("/api/notes", params={"module_id": mod["id"]}).json()
    nq = n["modules"][0]["questions"][0]
    ok &= check("notes carry attempt image, hint, answer",
                nq["attempt"]["image"] == PNG and nq["attempt"]["hint_steps"] == HINT
                and nq["answer_steps"] == STEPS)
    ok &= check("notes counts", n["counts"] == {"questions": 2, "attempted": 2,
                                                "answered": 1}, str(n["counts"]))

    # share link
    sh = c.post("/api/share", json={"module_id": mod["id"]}).json()
    ok &= check("share link has a LAN URL and QR", sh["url"].startswith("http://")
                and "/notes/" in sh["url"] and sh["svg"].startswith("<svg"), sh["url"])
    pub = c.get(f"/api/share/{sh['token']}")
    ok &= check("friend can open the shared notes", pub.status_code == 200
                and pub.json()["modules"][0]["questions"][0]["attempt"]["image"] == PNG)
    c.delete(f"/api/share/{sh['token']}")
    ok &= check("revoked link stops working",
                c.get(f"/api/share/{sh['token']}").status_code == 404)
    ok &= check("unknown token is a 404", c.get("/api/share/nope").status_code == 404)

    # bundle round trip: export, then import as if on a friend's machine
    ex = c.get("/api/notes/export", params={"module_id": mod["id"],
                                            "shared_by": "Saurav"})
    ok &= check("export is a downloadable file",
                "attachment" in ex.headers.get("content-disposition", ""))
    imp = c.post("/api/notes/import", json={"bundle": ex.json()}).json()
    ok &= check("friend import creates a separate, labelled subject",
                imp["questions"] == 2 and imp["origin"] == "Shared by Saurav", str(imp))
    fn = c.get("/api/notes", params={"subject_id": imp["subject_id"]}).json()
    fq = fn["modules"][0]["questions"][0]
    ok &= check("imported notes keep the handwriting image and answer",
                fq["attempt"]["image"] == PNG and fq["answer_steps"] == STEPS)
    dash = c.get("/api/study/dashboard",
                 params={"subject_id": imp["subject_id"]}).json()["subjects"][0]
    ok &= check("friend's progress is not counted as yours",
                dash["totals"]["counts"]["pending"] == 2
                and dash["totals"]["recall_total"] == 0, str(dash["totals"]["counts"]))
    ok &= check("garbage file rejected",
                c.post("/api/notes/import", json={"bundle": {"x": 1}}).status_code == 400)

    ok &= asyncio.run(page_open_check())

    # clean up everything this test created
    for sid in (sub["id"], imp["subject_id"]):
        c.delete(f"/api/study/subjects/{sid}")
    left = [x for x in c.get("/api/study/subjects").json()
            if x["id"] in (sub["id"], imp["subject_id"])]
    ok &= check("test data removed", not left)

    print("\nPRACTICE/NOTES RESULT:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
