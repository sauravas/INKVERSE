"""The INKWISE agents and the orchestrator that routes between them.

INKWISE runs FIVE agents. Each has one job, one backing resource, and is
invoked only by the orchestrator (or, for delegation, by another agent the
orchestrator started):

    Reader     vision model   transcribe a handwritten page into a question
    Verifier   vision model   re-read any numeric question independently and
                              flag disagreement (misread digits are invisible)
    Tutor      text model     stream a step-by-step solution
    Explainer  text model     explain ONE selected step; delegates to Reader
                              when the follow-up question is handwritten
    Mentor     rules + SQLite exam-readiness verdict and named blockers;
                              deliberately never asks a model (ARCHITECTURE.md #3)

    Examiner   (planned)      mark a student's own handwritten attempt

Orchestration is deterministic code, not a model deciding what to call. The
orchestrator owns: the cloud-consent gate, blank-page and crop checks, routing
to agents, delegation, and - through the provider - model scheduling (one stage
resident at a time, RAM guard, crash retry). Every hop is emitted to `obs` so
the UI can show which agent is running, live.
"""
from __future__ import annotations

import contextlib

from . import config, obs, readiness
from .ai import prompts

ORCHESTRATOR = {
    "id": "orchestrator", "name": "Orchestrator", "kind": "code",
    "role": "Routes each request to agents, enforces consent, schedules models",
}

AGENTS = [
    {"id": "reader", "name": "Reader Agent", "kind": "llm", "stage": "vision",
     "status": "active",
     "role": "Transcribes the handwritten page into an editable question",
     "invoked_by": "POST /api/ai/extract · Explainer (handwritten follow-up)"},
    {"id": "verifier", "name": "Verifier Agent", "kind": "llm", "stage": "vision",
     "status": "active",
     "role": "Reads numeric questions a second time and flags disagreement",
     "invoked_by": "Reader output contains digits or maths"},
    {"id": "tutor", "name": "Tutor Agent", "kind": "llm", "stage": "text",
     "status": "active",
     "role": "Streams a step-by-step solution as typed events",
     "invoked_by": "POST /api/ai/solve"},
    {"id": "explainer", "name": "Explainer Agent", "kind": "llm", "stage": "text",
     "status": "active",
     "role": "Explains one selected step without regenerating the answer",
     "invoked_by": "POST /api/ai/explain"},
    {"id": "mentor", "name": "Mentor Agent", "kind": "rules", "stage": "db",
     "status": "active",
     "role": "Computes exam readiness and blockers from real question rows",
     "invoked_by": "GET /api/study/dashboard"},
    {"id": "examiner", "name": "Examiner Agent", "kind": "llm", "stage": "text",
     "status": "planned",
     "role": "Will mark a student's own handwritten attempt against a rubric",
     "invoked_by": "not built yet"},
]

# (from, to, label, kind) - kind: route | delegate | uses
EDGES = [
    ("student", "orchestrator", "page / question / follow-up", "route"),
    ("orchestrator", "reader", "read page", "route"),
    ("reader", "verifier", "digits found", "delegate"),
    ("orchestrator", "tutor", "solve confirmed question", "route"),
    ("orchestrator", "explainer", "explain one step", "route"),
    ("explainer", "reader", "handwritten ask", "delegate"),
    ("orchestrator", "mentor", "dashboard", "route"),
    ("orchestrator", "examiner", "planned", "route"),
    ("reader", "vision", "", "uses"),
    ("verifier", "vision", "", "uses"),
    ("tutor", "text", "", "uses"),
    ("explainer", "text", "", "uses"),
    ("examiner", "text", "", "uses"),
    ("mentor", "db", "", "uses"),
]

# Every step id below is either an agent id (its span drives the state) or an
# orchestrator step emitted as a "step" event with data.step = id.
FLOWS = [
    {"id": "read", "name": "Read a page", "steps": [
        {"id": "consent", "agent": "orchestrator", "label": "Consent gate"},
        {"id": "crop", "agent": "orchestrator", "label": "Blank check, crop to ink"},
        {"id": "reader", "agent": "reader", "label": "Reader transcribes"},
        {"id": "verifier", "agent": "verifier", "label": "Verifier re-reads digits"},
        {"id": "review", "agent": "orchestrator", "label": "Student confirms question"},
    ]},
    {"id": "solve", "name": "Solve", "steps": [
        {"id": "consent", "agent": "orchestrator", "label": "Consent gate"},
        {"id": "tutor", "agent": "tutor", "label": "Tutor streams the solution"},
        {"id": "parse", "agent": "orchestrator", "label": "Parser makes typed steps"},
        {"id": "save", "agent": "orchestrator", "label": "Answer saved if filed"},
    ]},
    {"id": "explain", "name": "Ask about a step", "steps": [
        {"id": "consent", "agent": "orchestrator", "label": "Consent gate"},
        {"id": "reader", "agent": "reader", "label": "Reader reads handwritten ask"},
        {"id": "explainer", "agent": "explainer", "label": "Explainer answers one step"},
        {"id": "parse", "agent": "orchestrator", "label": "Parser makes typed steps"},
        {"id": "save", "agent": "orchestrator", "label": "Explanation saved if filed"},
    ]},
    {"id": "dashboard", "name": "Readiness", "steps": [
        {"id": "mentor", "agent": "mentor", "label": "Mentor checks each subject"},
        {"id": "verdict", "agent": "orchestrator", "label": "Readiness + blockers returned"},
    ]},
]


def topology(provider) -> dict:
    """Agents, edges and the concrete models behind them for one provider."""
    vision = getattr(provider, "vision_model", None) or getattr(provider, "model", "")
    text = getattr(provider, "text_model", None) or getattr(provider, "model", "")
    label = getattr(provider, "label", None) or getattr(provider, "name", "")
    return {
        "provider": label,
        "orchestrator": ORCHESTRATOR,
        "agents": AGENTS,
        "resources": [
            {"id": "student", "name": "Student", "detail": "laptop canvas · phone pen"},
            {"id": "vision", "name": "Vision model", "detail": vision},
            {"id": "text", "name": "Text model", "detail": text},
            {"id": "db", "name": "SQLite", "detail": "questions · recall · modules"},
        ],
        "edges": [{"from": a, "to": b, "label": l, "kind": k} for a, b, l, k in EDGES],
        "flows": FLOWS,
        "scheduler": {
            "exclusive_stages": config.EXCLUSIVE_MODELS,
            "ram_guard": config.RAM_GUARD,
            "min_free_gb": config.MIN_FREE_RAM_GB,
            "verify_math": config.VERIFY_MATH,
        },
        "counts": {"active": sum(a["status"] == "active" for a in AGENTS),
                   "planned": sum(a["status"] == "planned" for a in AGENTS)},
    }


def _model(provider, stage: str) -> str:
    if stage == "vision":
        return getattr(provider, "vision_model", None) or getattr(provider, "model", "?")
    return getattr(provider, "text_model", None) or getattr(provider, "model", "?")


# ---------------------------------------------------------------- agents
async def reader(provider, image_b64: str, hint: str = "",
                 caller: str | None = None) -> dict:
    model = _model(provider, "vision")
    with obs.span("reader", f"Transcribing handwriting with {model}", model=model,
                  caller=caller):
        out = await provider.extract(image_b64, hint, verify=False)
        obs.emit("agent.output",
                 f"Read “{obs.preview(out.get('question'))}” "
                 f"({out.get('confidence', 0):.0%} confident)",
                 confidence=out.get("confidence"),
                 subject=out.get("subject_guess"))
    return out


async def verifier(provider, image_b64: str, first: dict) -> dict:
    model = _model(provider, "vision")
    with obs.span("verifier", f"Independent second reading with {model}",
                  model=model, caller="reader"):
        second = await provider.reread(image_b64)
        merged = prompts.merge_readings(first, second)
        if merged.get("disagreement"):
            obs.emit("agent.output",
                     "Readings disagree - confidence capped, student must choose",
                     level="warn", alternative=obs.preview(merged.get("alternative")))
        else:
            obs.emit("agent.output", "Both readings agree")
    return merged


async def read_page(provider, image_b64: str, hint: str = "") -> dict:
    """Reader, then Verifier when a misread digit could change the answer."""
    out = await reader(provider, image_b64, hint)
    if config.VERIFY_MATH and prompts.looks_mathematical(out.get("question", "")):
        obs.emit("route", "Digits found - delegating to Verifier",
                 agent="reader", to="verifier")
        out = await verifier(provider, image_b64, out)
    else:
        obs.emit("step", "No digits - verification not needed",
                 agent="orchestrator", step="verifier", skipped=True)
    return out


async def tutor(provider, question: str, subject: str = ""):
    """Async generator of raw model text; parsing stays in the router."""
    model = _model(provider, "text")
    with obs.span("tutor", f"Solving “{obs.preview(question, 50)}” with {model}",
                  model=model):
        n = 0
        async with contextlib.aclosing(provider.solve(question, subject)) as st:
            async for chunk in st:
                if n == 0:
                    obs.emit("model.first_token", "First tokens streaming",
                             model=model)
                n += 1
                yield chunk
        obs.emit("agent.output", f"Solution streamed ({n} chunks)", chunks=n)


async def explainer(provider, question: str, answer: str, step: str, ask: str):
    model = _model(provider, "text")
    with obs.span("explainer", f"Explaining one step: “{obs.preview(ask, 50)}”",
                  model=model):
        n = 0
        async with contextlib.aclosing(
                provider.explain(question, answer, step, ask)) as st:
            async for chunk in st:
                if n == 0:
                    obs.emit("model.first_token", "First tokens streaming",
                             model=model)
                n += 1
                yield chunk
        obs.emit("agent.output", f"Explanation streamed ({n} chunks)", chunks=n)


async def read_followup(provider, image_b64: str) -> str:
    """Explainer delegating a handwritten follow-up to the Reader."""
    obs.emit("route", "Follow-up is handwritten - delegating to Reader",
             agent="explainer", to="reader")
    out = await reader(provider, image_b64,
                       hint="This is a short follow-up question.",
                       caller="explainer")
    return out.get("question", "").strip()


def mentor(subject: dict, modules: list[dict], questions: list[dict]) -> dict:
    with obs.span("mentor", f"Readiness for {subject.get('name', '?')}",
                  questions=len(questions)):
        rep = readiness.subject_report(subject, modules, questions)
        if rep["exam_ready"]:
            obs.emit("agent.output", "EXAM READY - all requirements met")
        else:
            obs.emit("agent.output",
                     f"Not ready: {len(rep['blockers'])} blocker(s) - "
                     f"{obs.preview(rep['blockers'][0], 60)}",
                     blockers=len(rep["blockers"]))
    return rep
