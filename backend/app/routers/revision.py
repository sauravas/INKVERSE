"""What to revise next. Rules and SQLite only - never a model.

See ARCHITECTURE.md constraint 3: the parts of the app a student has to trust
about their own progress are computed, not generated.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException

from .. import db, obs, revision

router = APIRouter(prefix="/api/revision", tags=["revision"])


@router.get("/plan")
async def plan(subject_id: str | None = None, limit: int = 12):
    with obs.trace("revision", "What should I revise next?") as run:
        obs.emit("route", "Routing to the Planner (rules, no model)", to="planner")
        with obs.span("planner", "Scoring every question against its schedule"):
            out = revision.plan(limit=max(1, min(limit, 50)), subject_id=subject_id)
            obs.emit("agent.output",
                     f"{len(out['queue'])} question(s) queued; "
                     f"{out['counts']['due']} overdue, "
                     f"{out['counts']['failing']} being forgotten")
        obs.emit("step", "Plan returned with its reasons", step="verdict")
        out["trace"] = run.id
    return out


@router.get("/queue")
async def queue(subject_id: str | None = None, module_id: str | None = None,
                limit: int = 12):
    return revision.queue(limit=max(1, min(limit, 50)), subject_id=subject_id,
                          module_id=module_id)


@router.get("/weak")
async def weak(subject_id: str | None = None, limit: int = 3):
    return revision.weak_topics(limit=max(1, min(limit, 20)),
                                subject_id=subject_id)


@router.get("/question/{qid}")
async def explain_due(qid: str):
    """Why this one question is where it is in the queue."""
    import time
    q = db.one("SELECT * FROM questions WHERE id = ?", (qid,))
    if not q:
        raise HTTPException(404, "No such question")
    now = time.time()
    return {
        "id": qid,
        "status": q["status"],
        "important": bool(q["important"]),
        "recall_correct": q["recall_correct"], "recall_total": q["recall_total"],
        "accuracy": revision.accuracy(q),
        "interval_days": revision.interval_days(q),
        "due_at": revision.due_at(q),
        "overdue_days": round(max(0.0, (now - revision.due_at(q)) / 86400.0), 2),
        "priority": revision.priority(q, now),
        "why": revision.why_due(q, now),
    }
