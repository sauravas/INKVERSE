"""Subjects, modules, questions and the deterministic dashboard."""
from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import db
from ..readiness import STATUSES, subject_report

router = APIRouter(prefix="/api/study", tags=["study"])


class SubjectIn(BaseModel):
    name: str
    exam_date: str | None = None
    req_syllabus: float = 0.85
    req_important: float = 1.0
    req_recall: float = 0.75


class ModuleIn(BaseModel):
    subject_id: str
    name: str
    weight: float = 1.0
    position: int = 0


class QuestionIn(BaseModel):
    text: str
    subject_id: str | None = None
    module_id: str | None = None
    important: bool = False
    status: str = "pending"
    page_id: str | None = None
    answer_md: str | None = None
    answer_json: str | None = None


class QuestionPatch(BaseModel):
    text: str | None = None
    status: str | None = None
    important: bool | None = None
    module_id: str | None = None
    subject_id: str | None = None
    answer_md: str | None = None
    answer_json: str | None = None


class RecallIn(BaseModel):
    correct: bool


# -- subjects ---------------------------------------------------------------
@router.get("/subjects")
async def list_subjects():
    subs = db.rows("SELECT * FROM subjects ORDER BY created_at")
    for s in subs:
        s["modules"] = db.rows(
            "SELECT * FROM modules WHERE subject_id=? ORDER BY position, created_at",
            (s["id"],))
        s["question_count"] = db.one(
            "SELECT COUNT(*) n FROM questions WHERE subject_id=?", (s["id"],))["n"]
    return subs


@router.post("/subjects")
async def create_subject(body: SubjectIn):
    sid = db.nid()
    db.run("INSERT INTO subjects (id,name,exam_date,req_syllabus,req_important,"
           "req_recall,created_at) VALUES (?,?,?,?,?,?,?)",
           (sid, body.name.strip(), body.exam_date, body.req_syllabus,
            body.req_important, body.req_recall, db.now()))
    return db.one("SELECT * FROM subjects WHERE id=?", (sid,))


@router.patch("/subjects/{sid}")
async def update_subject(sid: str, body: SubjectIn):
    if not db.one("SELECT 1 FROM subjects WHERE id=?", (sid,)):
        raise HTTPException(404, "No such subject")
    db.run("UPDATE subjects SET name=?,exam_date=?,req_syllabus=?,req_important=?,"
           "req_recall=? WHERE id=?",
           (body.name.strip(), body.exam_date, body.req_syllabus,
            body.req_important, body.req_recall, sid))
    return db.one("SELECT * FROM subjects WHERE id=?", (sid,))


@router.delete("/subjects/{sid}")
async def delete_subject(sid: str):
    # the FTS index has no foreign keys, so its passages are removed by hand
    db.run("DELETE FROM chunks WHERE subject_id=?", (sid,))
    db.run("DELETE FROM subjects WHERE id=?", (sid,))
    return {"ok": True}


# -- modules ----------------------------------------------------------------
@router.post("/modules")
async def create_module(body: ModuleIn):
    if not db.one("SELECT 1 FROM subjects WHERE id=?", (body.subject_id,)):
        raise HTTPException(404, "No such subject")
    mid = db.nid()
    db.run("INSERT INTO modules (id,subject_id,name,weight,position,created_at) "
           "VALUES (?,?,?,?,?,?)",
           (mid, body.subject_id, body.name.strip(), body.weight, body.position,
            db.now()))
    return db.one("SELECT * FROM modules WHERE id=?", (mid,))


@router.patch("/modules/{mid}")
async def update_module(mid: str, body: ModuleIn):
    db.run("UPDATE modules SET name=?, weight=?, position=? WHERE id=?",
           (body.name.strip(), body.weight, body.position, mid))
    return db.one("SELECT * FROM modules WHERE id=?", (mid,))


@router.delete("/modules/{mid}")
async def delete_module(mid: str):
    db.run("DELETE FROM chunks WHERE module_id=?", (mid,))
    db.run("DELETE FROM modules WHERE id=?", (mid,))
    return {"ok": True}


# -- questions --------------------------------------------------------------
@router.get("/questions")
async def list_questions(subject_id: str | None = None,
                         module_id: str | None = None,
                         status: str | None = None):
    sql = "SELECT * FROM questions WHERE 1=1"
    args: list = []
    if subject_id:
        sql += " AND subject_id=?"
        args.append(subject_id)
    if module_id:
        sql += " AND module_id=?"
        args.append(module_id)
    if status:
        sql += " AND status=?"
        args.append(status)
    sql += " ORDER BY created_at DESC"
    return db.rows(sql, tuple(args))


@router.get("/questions/{qid}")
async def get_question(qid: str):
    q = db.one("SELECT * FROM questions WHERE id=?", (qid,))
    if not q:
        raise HTTPException(404, "No such question")
    q["explanations"] = db.rows(
        "SELECT * FROM explanations WHERE question_id=? ORDER BY created_at", (qid,))
    return q


@router.post("/questions")
async def create_question(body: QuestionIn):
    if body.status not in STATUSES:
        raise HTTPException(400, f"status must be one of {STATUSES}")
    qid = db.nid()
    sub = body.subject_id
    if body.module_id and not sub:
        m = db.one("SELECT subject_id FROM modules WHERE id=?", (body.module_id,))
        sub = m["subject_id"] if m else None
    t = db.now()
    db.run("INSERT INTO questions (id,module_id,subject_id,text,answer_md,"
           "answer_json,status,important,page_id,created_at,updated_at) "
           "VALUES (?,?,?,?,?,?,?,?,?,?,?)",
           (qid, body.module_id, sub, body.text.strip(), body.answer_md,
            body.answer_json, body.status, int(body.important), body.page_id, t, t))
    return db.one("SELECT * FROM questions WHERE id=?", (qid,))


@router.patch("/questions/{qid}")
async def update_question(qid: str, body: QuestionPatch):
    q = db.one("SELECT * FROM questions WHERE id=?", (qid,))
    if not q:
        raise HTTPException(404, "No such question")
    if body.status is not None and body.status not in STATUSES:
        raise HTTPException(400, f"status must be one of {STATUSES}")

    sets, args = [], []
    for col in ("text", "status", "module_id", "subject_id", "answer_md",
                "answer_json"):
        v = getattr(body, col)
        if v is not None:
            sets.append(f"{col}=?")
            args.append(v)
    if body.important is not None:
        sets.append("important=?")
        args.append(int(body.important))
    # moving to 'revised' is what counts a revision, not merely re-saving
    if body.status == "revised" and q["status"] != "revised":
        sets.append("revisions=revisions+1")
        sets.append("last_reviewed=?")
        args.append(db.now())
    if body.module_id and not body.subject_id:
        m = db.one("SELECT subject_id FROM modules WHERE id=?", (body.module_id,))
        if m:
            sets.append("subject_id=?")
            args.append(m["subject_id"])
    if not sets:
        return q
    sets.append("updated_at=?")
    args.append(db.now())
    args.append(qid)
    db.run(f"UPDATE questions SET {', '.join(sets)} WHERE id=?", tuple(args))
    return db.one("SELECT * FROM questions WHERE id=?", (qid,))


@router.delete("/questions/{qid}")
async def delete_question(qid: str):
    db.run("DELETE FROM questions WHERE id=?", (qid,))
    return {"ok": True}


@router.post("/questions/{qid}/recall")
async def log_recall(qid: str, body: RecallIn):
    """Log one active-recall attempt. Feeds the readiness calculation."""
    q = db.one("SELECT * FROM questions WHERE id=?", (qid,))
    if not q:
        raise HTTPException(404, "No such question")
    db.run("UPDATE questions SET recall_total=recall_total+1, "
           "recall_correct=recall_correct+?, last_reviewed=?, updated_at=? "
           "WHERE id=?", (1 if body.correct else 0, db.now(), db.now(), qid))
    return db.one("SELECT * FROM questions WHERE id=?", (qid,))


# -- dashboard --------------------------------------------------------------
@router.get("/dashboard")
async def dashboard(subject_id: str | None = None):
    subs = db.rows("SELECT * FROM subjects WHERE id=? ORDER BY created_at",
                   (subject_id,)) if subject_id else \
        db.rows("SELECT * FROM subjects ORDER BY created_at")

    reports = []
    for s in subs:
        mods = db.rows("SELECT * FROM modules WHERE subject_id=? "
                       "ORDER BY position, created_at", (s["id"],))
        qs = db.rows("SELECT * FROM questions WHERE subject_id=?", (s["id"],))
        reports.append(subject_report(s, mods, qs))

    unfiled = db.one("SELECT COUNT(*) n FROM questions WHERE subject_id IS NULL")["n"]
    overall = {
        "subjects": len(reports),
        "questions": db.one("SELECT COUNT(*) n FROM questions")["n"],
        "unfiled": unfiled,
        "ready": sum(1 for r in reports if r["exam_ready"]),
        "coverage": round(
            sum(r["metrics"]["coverage"] for r in reports) / len(reports), 4)
        if reports else 0.0,
    }
    return {"overall": overall, "subjects": reports}
