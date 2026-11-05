"""Question-bank practice: work through a module one question at a time.

Each question keeps one canonical attempt - the student's own handwritten
answer, any hint they asked for, and how it went. Together with the stored AI
answer and annotations, that is the module's reference notes.

Progress changes here are rule-based (constraint 3): finishing a question
moves it to Studied (or Revised if it was already studied) and logs one
recall attempt from the outcome the student chose. Nothing is inferred by AI.
"""
from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .. import agents, db, imaging, obs
from ..ai.base import ProviderError
from ..ai.prompts import parse_marking
from .ai import SSE_HEADERS, _consent_step, _label, _resolve, _sse, _stream_events

router = APIRouter(prefix="/api/practice", tags=["practice"])

OUTCOMES = ("knew", "hint", "answer")

# An examiner mark at or above this counts as having recalled the question.
# Matches the default recall requirement a subject is held to.
RECALLED_AT = 0.7


class AttemptIn(BaseModel):
    strokes: list = []
    image: str | None = None
    hint_steps: list | None = None


class FinishIn(BaseModel):
    outcome: str


def _attempt(qid: str) -> dict | None:
    a = db.one("SELECT * FROM attempts WHERE question_id=? "
               "ORDER BY updated_at DESC LIMIT 1", (qid,))
    if a:
        a["strokes"] = json.loads(a["strokes"] or "[]")
        a["hint_steps"] = json.loads(a["hint_json"]) if a["hint_json"] else None
    return a


@router.get("/module/{module_id}")
async def module_session(module_id: str):
    """The ordered question list for a module, with where the student is."""
    mod = db.one("SELECT m.*, s.name subject_name FROM modules m "
                 "JOIN subjects s ON s.id = m.subject_id WHERE m.id=?", (module_id,))
    if not mod:
        raise HTTPException(404, "No such module")
    qs = db.rows(
        "SELECT q.id, q.text, q.marks, q.important, q.status, q.recall_correct, "
        "q.recall_total, (q.answer_json IS NOT NULL AND q.answer_json != '[]') has_answer, "
        "(SELECT a.outcome FROM attempts a WHERE a.question_id = q.id "
        " ORDER BY a.updated_at DESC LIMIT 1) outcome, "
        "(SELECT COUNT(*) FROM attempts a WHERE a.question_id = q.id) attempts "
        "FROM questions q WHERE q.module_id=? ORDER BY q.position, q.created_at",
        (module_id,))
    # resume at the first question not yet finished
    resume = next((i for i, q in enumerate(qs) if not q["outcome"]), 0)
    return {"module": mod, "questions": qs, "resume_index": resume,
            "done": sum(1 for q in qs if q["outcome"])}


@router.get("/question/{qid}")
async def question(qid: str):
    q = db.one("SELECT * FROM questions WHERE id=?", (qid,))
    if not q:
        raise HTTPException(404, "No such question")
    q["answer_steps"] = json.loads(q["answer_json"]) if q["answer_json"] else []
    q["attempt"] = _attempt(qid)
    q["explanations"] = [
        {**e, "steps": json.loads(e["answer_json"]) if e["answer_json"] else []}
        for e in db.rows("SELECT * FROM explanations WHERE question_id=? "
                         "ORDER BY created_at", (qid,))]
    return q


@router.put("/question/{qid}/attempt")
async def save_attempt(qid: str, body: AttemptIn):
    """Upsert the student's answer for this question. Safe to call often."""
    if not db.one("SELECT 1 FROM questions WHERE id=?", (qid,)):
        raise HTTPException(404, "No such question")
    existing = db.one("SELECT id, hint_json FROM attempts WHERE question_id=? "
                      "ORDER BY updated_at DESC LIMIT 1", (qid,))
    strokes = json.dumps(body.strokes)
    hint = json.dumps(body.hint_steps) if body.hint_steps is not None else None
    t = db.now()
    if existing:
        db.run("UPDATE attempts SET strokes=?, image=COALESCE(?, image), "
               "hint_json=COALESCE(?, hint_json), updated_at=? WHERE id=?",
               (strokes, body.image, hint, t, existing["id"]))
        aid = existing["id"]
    else:
        aid = db.nid()
        db.run("INSERT INTO attempts (id,question_id,strokes,image,hint_json,"
               "created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
               (aid, qid, strokes, body.image, hint, t, t))
    return {"id": aid, "saved_at": t}


@router.post("/question/{qid}/finish")
async def finish(qid: str, body: FinishIn):
    """Record how the attempt went and advance progress by fixed rules."""
    if body.outcome not in OUTCOMES:
        raise HTTPException(400, f"outcome must be one of {OUTCOMES}")
    q = db.one("SELECT * FROM questions WHERE id=?", (qid,))
    if not q:
        raise HTTPException(404, "No such question")

    t = db.now()
    a = db.one("SELECT id FROM attempts WHERE question_id=? "
               "ORDER BY updated_at DESC LIMIT 1", (qid,))
    if a:
        db.run("UPDATE attempts SET outcome=?, updated_at=? WHERE id=?",
               (body.outcome, t, a["id"]))
    else:
        db.run("INSERT INTO attempts (id,question_id,outcome,created_at,updated_at) "
               "VALUES (?,?,?,?,?)", (db.nid(), qid, body.outcome, t, t))

    # rules, not judgement: first pass -> studied; any later pass -> revised.
    # Mastered stays the student's own call on the dashboard.
    status, revisions = q["status"], q["revisions"]
    if status == "pending":
        status = "studied"
    elif status in ("studied", "revised"):
        status, revisions = "revised", revisions + 1
    correct = 1 if body.outcome == "knew" else 0
    db.run("UPDATE questions SET status=?, revisions=?, recall_total=recall_total+1, "
           "recall_correct=recall_correct+?, last_reviewed=?, updated_at=? WHERE id=?",
           (status, revisions, correct, t, t, qid))
    return db.one("SELECT id, status, revisions, recall_correct, recall_total "
                  "FROM questions WHERE id=?", (qid,))


# --------------------------------------------------------------------------
class MarkIn(BaseModel):
    image: str | None = None        # the page as written, if not already stored
    provider: str | None = None
    consent_cloud: bool = False
    marks: float | None = None      # marks available, if the paper says


@router.post("/question/{qid}/mark")
async def mark(qid: str, body: MarkIn):
    """Mark the student's own handwritten attempt against the stored answer.

    Orchestration: consent -> Reader (transcribe the working, mistakes intact)
    -> Examiner (mark it) -> the marks are parsed out by code and recorded as
    one recall attempt.

    The examiner judges the answer; it does not decide progress. The score it
    gives becomes a recall attempt like any other, and readiness is still
    computed from those records by rule (constraint 3).
    """
    q = db.one("SELECT * FROM questions WHERE id=?", (qid,))
    if not q:
        raise HTTPException(404, "No such question")
    if not (q.get("answer_md") or q.get("answer_json")):
        raise HTTPException(409, "Solve this question first - there is nothing "
                                 "to mark the attempt against yet.")

    attempt_row = db.one("SELECT * FROM attempts WHERE question_id=? "
                         "ORDER BY updated_at DESC LIMIT 1", (qid,))
    image = body.image or (attempt_row or {}).get("image")
    if not image:
        raise HTTPException(400, "No handwritten attempt to mark.")

    p = _resolve(body.provider, body.consent_cloud)
    marks = body.marks
    if marks is None and q.get("marks"):
        try:
            marks = float(str(q["marks"]).strip())
        except (TypeError, ValueError):
            marks = None

    async def gen():
        with obs.trace("mark", f"Mark the attempt at \u201c{obs.preview(q['text'], 50)}\u201d",
                       provider=_label(p)) as run:
            _consent_step(p)
            try:
                b64, _info = imaging.prepare_b64(image)
                obs.emit("route", "Examiner needs the working read first",
                         to="reader")
                working = await agents.read_working(p, b64)
            except ProviderError as e:
                run.fail(str(e))
                yield _sse({"type": "error", "message": str(e)})
                return
            except Exception as e:
                run.fail(f"Bad image: {e}")
                yield _sse({"type": "error", "message": f"Bad image: {e}"})
                return

            if not working.strip():
                obs.emit("step", "Nothing written on the page", step="examiner",
                         skipped=True)
                yield _sse({"type": "marked", "awarded": 0.0,
                            "available": marks or 10.0, "ratio": 0.0,
                            "verdict": "blank",
                            "next": "Write your attempt on the page first."})
                yield _sse({"type": "done", "steps": 0})
                return

            yield _sse({"type": "transcript", "value": working})

            def persist(text, steps):
                verdict = parse_marking(text)
                # One recall attempt, scored by the examiner but recorded by
                # the same rule as every other: readiness never asks a model.
                # The bar is the same 0.7 a student would call "I knew it" -
                # a bare pass is not recall, and subjects require 0.75 average
                # accuracy to be exam ready, so counting 60% as known would
                # quietly inflate readiness.
                correct = 1 if verdict["ratio"] >= RECALLED_AT else 0
                t = db.now()
                status = q["status"]
                revisions = q["revisions"]
                if status == "pending":
                    status = "studied"
                elif status in ("studied", "revised"):
                    status, revisions = "revised", revisions + 1
                db.run("UPDATE questions SET status=?, revisions=?, "
                       "recall_total=recall_total+1, recall_correct=recall_correct+?, "
                       "last_reviewed=?, updated_at=? WHERE id=?",
                       (status, revisions, correct, t, t, qid))
                payload = json.dumps({**verdict, "steps": steps})
                if attempt_row:
                    db.run("UPDATE attempts SET marking_json=?, updated_at=? "
                           "WHERE id=?", (payload, t, attempt_row["id"]))
                else:
                    # marked straight from the page without the attempt having
                    # been saved first - keep both, or the marking is lost
                    db.run("INSERT INTO attempts (id,question_id,strokes,image,"
                           "marking_json,created_at,updated_at) "
                           "VALUES (?,?,'[]',?,?,?,?)",
                           (db.nid(), qid, image, payload, t, t))
                obs.emit("step",
                         f"{verdict['awarded']:g}/{verdict['available']:g} "
                         f"recorded as one recall attempt", step="save",
                         awarded=verdict["awarded"], available=verdict["available"])
                persist.verdict = verdict

            obs.emit("route", "Routing the working to the Examiner", to="examiner")
            model_answer = q.get("answer_md") or ""
            async for chunk in _stream_events(
                    agents.examiner(p, q["text"], model_answer, working, marks),
                    run=run, on_done=persist):
                yield chunk
            v = getattr(persist, "verdict", None)
            if v:
                yield _sse({"type": "marked", **v})

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers=SSE_HEADERS)


@router.get("/question/{qid}/marking")
async def marking(qid: str):
    """The last marking for a question, if it has been marked."""
    a = db.one("SELECT marking_json FROM attempts WHERE question_id=? "
               "AND marking_json IS NOT NULL ORDER BY updated_at DESC LIMIT 1",
               (qid,))
    if not a:
        return {"marked": False}
    try:
        return {"marked": True, **json.loads(a["marking_json"])}
    except (TypeError, ValueError):
        return {"marked": False}
