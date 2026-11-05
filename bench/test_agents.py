"""Orchestration + observability test with a fake provider (no Ollama needed).

Checks that every request becomes one traced run, that the right agents are
called in the right order, that delegation (Reader -> Verifier, Explainer ->
Reader) is visible, and that failures and cancellations end spans correctly.

    .venv\\Scripts\\python.exe bench\\test_agents.py
"""
import base64
import io
import json
import os
import sys
import tempfile

os.environ.setdefault("INKWISE_DATA", tempfile.mkdtemp(prefix="inkwise-test-"))
sys.path.insert(0, "backend")

from fastapi.testclient import TestClient  # noqa: E402
from PIL import Image, ImageDraw  # noqa: E402

from app import db, obs  # noqa: E402
from app.ai import registry  # noqa: E402
from app.ai.base import ProviderError  # noqa: E402
from app.main import app  # noqa: E402


class FakeProvider:
    name = "fake"
    label = "fake"
    requires_consent = False
    vision_model = "fake-vision"
    text_model = "fake-text"

    def __init__(self):
        self.first = "Solve $x^2 - 5x + 6 = 0$"
        self.second = self.first
        self.fail_solve = False
        self.last_context = ""

    async def health(self):
        return {"ok": True}

    async def extract(self, image_b64, hint="", verify=None):
        obs.emit("model.call", "fake-vision warm", model="fake-vision")
        return {"question": self.first, "confidence": 0.9, "subject_guess": "Maths"}

    async def reread(self, image_b64):
        return {"question": self.second, "confidence": 0.8}

    async def _gen(self, text):
        obs.emit("model.call", "fake-text warm", model="fake-text")
        if self.fail_solve:
            raise ProviderError("runner crashed")
        for i in range(0, len(text), 7):
            yield text[i:i + 7]

    def solve(self, question, subject="", context="", session=None):
        self.last_context = context
        return self._gen("@@STEP Factor\n$(x-2)(x-3)=0$\n@@FINAL\n$x=2,3$\n")

    def explain(self, question, answer, step, ask, context="", history=None,
                focus=""):
        self.last_context = context
        return self._gen("@@STEP Why\nProduct is zero.\n@@FINAL\nDone\n")

    def hint(self, question, context=""):
        return self._gen("@@STEP Try\nFactor it.\n@@FINAL\nTwo brackets.\n")

    def notes(self, subject, module, material="", questions=None):
        return self._gen("@@STEP Overview\nRoots.\n@@FINAL\nDone\n")


def page_png(text=True) -> str:
    im = Image.new("RGB", (600, 400), "white")
    if text:
        d = ImageDraw.Draw(im)
        for y in range(80, 200, 6):
            d.line((60, y, 420, y + 10), fill="black", width=4)
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def run_events(trace):
    return [e for e in obs.recent() if e["trace"] == trace]


def agents_started(evs):
    return [e["agent"] for e in evs if e["kind"] == "agent.start"]


def last_trace(flow):
    for e in reversed(obs.recent()):
        if e["kind"] == "run.start" and e["data"].get("flow") == flow:
            return e["trace"]
    raise AssertionError(f"no {flow} run")


fake = FakeProvider()
registry._cache["local"] = fake
db.init()
c = TestClient(app)
fails = 0


def check(name, cond, detail=""):
    global fails
    print(("  ok   " if cond else "  FAIL ") + name + (f"  ({detail})" if detail and not cond else ""))
    fails += 0 if cond else 1


print("topology")
t = c.get("/api/obs/agents?provider=local").json()
check("9 active agents + 1 planned", t["counts"] == {"active": 9, "planned": 1}, t["counts"])
check("models resolved from provider",
      {r["id"]: r["detail"] for r in t["resources"]}["vision"] == "fake-vision")

print("read: Reader -> Verifier (agree)")
r = c.post("/api/ai/extract", json={"image": page_png(), "provider": "local"}).json()
evs = run_events(r["trace"])
check("Reader then Verifier", agents_started(evs) == ["reader", "verifier"], agents_started(evs))
check("verifier caller is reader",
      [e["data"]["caller"] for e in evs if e["kind"] == "agent.start"][1] == "reader")
check("run ends ok", evs[-1]["kind"] == "run.end" and evs[-1]["data"]["status"] == "ok")
check("no disagreement", not r.get("disagreement"))

print("read: disagreement caps confidence")
fake.second = "Solve $x^2 - 3x + 6 = 0$"
r = c.post("/api/ai/extract", json={"image": page_png(), "provider": "local"}).json()
check("alternative offered", r.get("alternative") == fake.second)
check("confidence capped", r["confidence"] <= 0.45, r["confidence"])
check("warn event emitted", any(e["level"] == "warn" for e in run_events(r["trace"])))
fake.second = fake.first

print("read: no digits -> no Verifier")
fake.first = "Explain photosynthesis"
r = c.post("/api/ai/extract", json={"image": page_png(), "provider": "local"}).json()
check("only Reader", agents_started(run_events(r["trace"])) == ["reader"])
fake.first = "Solve $x^2 - 5x + 6 = 0$"

print("read: blank page -> no agent")
r = c.post("/api/ai/extract", json={"image": page_png(False), "provider": "local"}).json()
evs = run_events(last_trace("read"))
check("blank short-circuits", r.get("blank") and agents_started(evs) == [])

print("solve: Tutor streams typed steps")
body = c.post("/api/ai/solve", json={"question": "x^2-5x+6=0", "provider": "local"}).text
frames = [json.loads(l[5:]) for l in body.splitlines() if l.startswith("data:")]
evs = run_events(last_trace("solve"))
check("Librarian grounds, then Tutor",
      agents_started(evs) == ["librarian", "tutor"], agents_started(evs))
check("UI got typed steps", any(f["type"] == "step_open" for f in frames))
check("tutor span ok",
      [e["data"]["status"] for e in evs if e["kind"] == "agent.end"] == ["ok", "ok"])

print("solve: provider failure ends span + run as error")
fake.fail_solve = True
body = c.post("/api/ai/solve", json={"question": "x", "provider": "local"}).text
fake.fail_solve = False
evs = run_events(last_trace("solve"))
check("client got error event", '"type": "error"' in body)
check("tutor span error",
      [e["data"]["status"] for e in evs if e["kind"] == "agent.end"] == ["ok", "error"])
check("run error", evs[-1]["data"]["status"] == "error")

print("explain: handwritten ask delegates Explainer -> Reader")
body = c.post("/api/ai/explain", json={
    "question": "q", "answer": "a", "step": "s", "step_index": 1,
    "ask_image": page_png(), "provider": "local"}).text
evs = run_events(last_trace("explain"))
check("Reader then Explainer",
      agents_started(evs) == ["reader", "librarian", "explainer"],
      agents_started(evs))
check("reader called by explainer",
      [e["data"]["caller"] for e in evs if e["kind"] == "agent.start"][0] == "explainer")
check("delegation route event",
      any(e["kind"] == "route" and e["data"].get("to") == "reader" for e in evs))

print("dashboard: Mentor (rules, no model)")
sid = c.post("/api/study/subjects", json={"name": "DSP"}).json()["id"]
c.get("/api/study/dashboard")
evs = run_events(last_trace("dashboard"))
check("Mentor ran", agents_started(evs) == ["mentor"])
check("no model call", not any(e["kind"] == "model.call" for e in evs))

print("flow steps are tagged for the live tracker")


def steps_of(flow):
    return {(e["data"]["step"], bool(e["data"].get("skipped")))
            for e in run_events(last_trace(flow)) if e["kind"] == "step"}


r = c.post("/api/ai/extract", json={"image": page_png(), "provider": "local"}).json()
check("read: consent, crop, review",
      {("consent", False), ("crop", False), ("review", False)} <= steps_of("read"),
      steps_of("read"))
c.post("/api/ai/solve", json={"question": "x^2-5x+6=0", "provider": "local"})
check("solve: parse done, save skipped (not filed)",
      {("consent", False), ("parse", False), ("save", True)} <= steps_of("solve"),
      steps_of("solve"))
c.post("/api/ai/explain", json={"question": "q", "answer": "a", "step": "s",
                                "step_index": 1, "ask": "why?", "provider": "local"})
check("explain: typed ask skips reader",
      ("reader", True) in steps_of("explain"), steps_of("explain"))
c.get("/api/study/dashboard")
check("dashboard: verdict step", ("verdict", False) in steps_of("dashboard"))
flows = c.get("/api/obs/agents").json()["flows"]
check("flows are structured", all(isinstance(st, dict) and "id" in st
                                  for f in flows for st in f["steps"]))

print("hint: the Hint Agent answers without the Tutor")
body = c.post("/api/ai/hint", json={"question": "x^2-5x+6=0",
                                    "provider": "local"}).text
evs = run_events(last_trace("hint"))
check("Librarian then Hint Agent",
      agents_started(evs) == ["librarian", "hinter"], agents_started(evs))
check("hint streamed typed steps", '"type": "step_open"' in body)

print("stats")
s = c.get("/api/obs/agents").json()["stats"]
check("per-agent counters",
      s["reader"]["calls"] >= 4 and s["tutor"]["errors"] == 1
      and s["librarian"]["calls"] >= 3, s)

print("\n" + ("ALL PASSED" if not fails else f"{fails} FAILED"))
sys.exit(1 if fails else 0)
