"""The Examiner marks the student's own working - and marking stays honest.

Two things have to hold. The marks a student sees must be the marks that get
recorded, which is why they are parsed out of the examiner's output by code
rather than inferred. And a mark must not become a verdict on exam readiness:
it is recorded as one recall attempt, and readiness is still computed from
those records by rule (ARCHITECTURE.md constraint 3).

    .venv\\Scripts\\python.exe bench\\test_examiner.py
"""
import base64
import io
import json
import os
import sys
import tempfile

os.environ.setdefault("INKWISE_DATA", tempfile.mkdtemp(prefix="inkwise-exam-"))
sys.path.insert(0, "backend")
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from fastapi.testclient import TestClient  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402

from app import db, obs  # noqa: E402
from app.ai import registry  # noqa: E402
from app.ai.prompts import parse_marking  # noqa: E402
from app.main import app  # noqa: E402

MARKING = """@@STEP What was right
You used the power rule correctly on the first term.
@@STEP What was wrong
You wrote $8x + 3x$; the derivative of $3x$ is $3$, not $3x$.
@@STEP Marks
Method 3/3, first term 2/2, second term 0/2, final answer 1/3.
@@FINAL
Close - the method is sound, you just carried the $x$ through.
@@MARK 6/10
@@VERDICT partly correct
@@NEXT Differentiate each term separately and check the powers.
"""


class FakeProvider:
    name = "fake"
    label = "fake"
    requires_consent = False
    vision_model = "fake-vision"
    text_model = "fake-text"

    def __init__(self):
        self.working = "$f(x) = 4x^2 + 3x$\n$f'(x) = 8x + 3x$"
        self.marking = MARKING
        self.saw = {}

    async def health(self):
        return {"ok": True}

    async def extract(self, image_b64, hint="", verify=None):
        return {"question": "q", "confidence": 0.9}

    async def read_attempt(self, image_b64):
        return self.working

    async def _gen(self, text):
        obs.emit("model.call", "fake-text warm", model="fake-text")
        for i in range(0, len(text), 11):
            yield text[i:i + 11]

    def examine(self, question, model_answer, attempt, marks=None):
        self.saw = {"question": question, "model_answer": model_answer,
                    "attempt": attempt, "marks": marks}
        return self._gen(self.marking)

    def solve(self, *a, **k):
        return self._gen("@@STEP x\n@@FINAL\ny\n")


def page_png(blank=False) -> str:
    im = Image.new("RGB", (700, 400), "white")
    if not blank:
        d = ImageDraw.Draw(im)
        for y in range(80, 220, 7):
            d.line((60, y, 520, y + 9), fill="black", width=4)
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


fake = FakeProvider()
registry._cache["local"] = fake
db.init()
c = TestClient(app)
fails = 0


def check(name, cond, detail=""):
    global fails
    print(("  ok   " if cond else "  FAIL ") + name
          + (f"  ({detail})" if detail and not cond else ""))
    fails += 0 if cond else 1


def frames(body):
    return [json.loads(l[5:]) for l in body.splitlines() if l.startswith("data:")]


print("the marks a student is shown are the marks that get recorded")
v = parse_marking(MARKING)
check("parsed off the examiner's own line", (v["awarded"], v["available"]) == (6.0, 10.0), v)
check("verdict carried through", v["verdict"] == "partly correct")
check("and the one thing to fix next", v["next"].startswith("Differentiate"))

print("setting up a question with an answer and an attempt")
sid = c.post("/api/study/subjects", json={"name": "Maths"}).json()["id"]
qid = c.post("/api/study/questions", json={
    "subject_id": sid, "text": "Differentiate $4x^2+3x$",
    "answer_md": "@@FINAL\n$8x+3$\n"}).json()["id"]

print("marking refuses when there is nothing to mark against")
bare = c.post("/api/study/questions", json={"subject_id": sid, "text": "Unsolved"}).json()["id"]
r = c.post(f"/api/practice/question/{bare}/mark", json={"image": page_png()})
check("unsolved question cannot be marked", r.status_code == 409, r.status_code)
r = c.post(f"/api/practice/question/{qid}/mark", json={})
check("no attempt, no marking", r.status_code == 400, r.status_code)

print("marking a real attempt")
before = c.get(f"/api/study/questions/{qid}").json()
body = c.post(f"/api/practice/question/{qid}/mark",
              json={"image": page_png(), "marks": 10}).text
evs = frames(body)
kinds = [e["type"] for e in evs]
check("the student sees the transcription of their own working",
      "transcript" in kinds)
transcript = next(e["value"] for e in evs if e["type"] == "transcript")
check("transcribed with the mistake intact", "8x + 3x" in transcript, transcript)
check("the marking arrives as typed steps", "step_open" in kinds)
marked = next((e for e in evs if e["type"] == "marked"), None)
check("a marked event closes it", marked is not None)
if marked:
    check("with the examiner's own numbers",
          (marked["awarded"], marked["available"]) == (6.0, 10.0), marked)
check("the examiner was given the model answer, not just the question",
      "8x+3" in fake.saw.get("model_answer", ""), fake.saw.get("model_answer"))
check("and the student's working", "8x + 3x" in fake.saw.get("attempt", ""))
check("and the marks available", fake.saw.get("marks") == 10)

print("a mark is recorded as a recall attempt, not as a verdict on readiness")
after = c.get(f"/api/study/questions/{qid}").json()
check("one recall attempt logged",
      after["recall_total"] == before["recall_total"] + 1,
      f"{before['recall_total']} -> {after['recall_total']}")
check("6/10 is not counted as recalled", after["recall_correct"] == 0,
      after["recall_correct"])
check("progress advanced by the same rule as any other attempt",
      after["status"] == "studied", after["status"])
check("readiness still comes from the records",
      "exam_ready" in c.get("/api/study/dashboard").json()["subjects"][0])

print("a good attempt counts as recalled")
fake.marking = MARKING.replace("@@MARK 6/10", "@@MARK 9/10")
c.post(f"/api/practice/question/{qid}/mark", json={"image": page_png(), "marks": 10})
after2 = c.get(f"/api/study/questions/{qid}").json()
check("9/10 counts as recalled", after2["recall_correct"] == 1, after2)
check("and it is now revised", after2["status"] == "revised", after2["status"])

print("a blank page is marked zero, without calling the examiner")
fake.working = "BLANK"
body = c.post(f"/api/practice/question/{qid}/mark", json={"image": page_png(True)}).text
m = next((e for e in frames(body) if e["type"] == "marked"), None)
check("zero, and said plainly", m and m["awarded"] == 0 and m["verdict"] == "blank", m)
fake.working = "$f(x) = 4x^2 + 3x$\n$f'(x) = 8x + 3x$"

print("the marking is kept and can be read back")
saved = c.get(f"/api/practice/question/{qid}/marking").json()
check("stored with the attempt", saved.get("marked") is True, saved)
check("with its steps", bool(saved.get("steps")), saved.get("verdict"))

print("the Examiner is a real agent now")
t = c.get("/api/obs/agents?provider=local").json()
ex = next(a for a in t["agents"] if a["id"] == "examiner")
check("declared active", ex["status"] == "active", ex["status"])
pl = next(a for a in t["agents"] if a["id"] == "planner")
check("the Planner is rules, not a model", pl["kind"] == "rules", pl["kind"])
evs = [e for e in obs.recent() if e.get("agent") == "examiner"]
check("its work shows up in the agent feed", any(e["kind"] == "agent.start" for e in evs))

print("\n" + ("ALL PASSED" if not fails else f"{fails} FAILED"))
sys.exit(1 if fails else 0)
