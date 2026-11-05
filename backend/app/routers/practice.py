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
from pydantic import BaseModel

from .. import db

router = APIRouter(prefix="/api/practice", tags=["practice"])

OUTCOMES = ("knew", "hint", "answer")


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
