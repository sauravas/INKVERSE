"""What to revise next, and which topics are weakest.

Deliberately free of any model (ARCHITECTURE.md constraint 3). What a student
should revise is a scheduling question with a right answer, computable from
what they have actually done: how often they recalled a question, how long ago,
whether it is flagged important, and how far its module is from the subject's
own requirements. Asking a language model to guess that would make the one part
of the app a student has to trust the one part that can quietly be wrong.

The schedule is a simplified SM-2: each successful recall pushes the next due
date further out, a failure pulls it back to the start. The multipliers are
plain numbers in DUE_DAYS rather than a learned curve, so a student can be told
exactly why something is due today.
"""
from __future__ import annotations

import time

from . import db, readiness

DAY = 86400.0

# Interval after n consecutive successful recalls. The last value repeats.
DUE_DAYS = [0.0, 1.0, 3.0, 7.0, 16.0, 35.0]

# A question is only ever "due" if the exam has not already been and gone.
HORIZON_DAYS = 120


def _streak(q: dict) -> int:
    """How many recalls in a row went well, as far as the counters can say.

    Only totals are stored, not a per-attempt log, so this is an estimate: a
    question answered 4 times out of 5 is treated as being on a short streak
    rather than a long one. It errs toward revising sooner, which is the
    cheaper mistake.
    """
    total = q.get("recall_total") or 0
    correct = q.get("recall_correct") or 0
    if not total:
        return 0
    misses = total - correct
    return max(0, correct - misses)


def interval_days(q: dict) -> float:
    return DUE_DAYS[min(_streak(q), len(DUE_DAYS) - 1)]


def due_at(q: dict) -> float:
    """When this question should next be seen. Past = overdue."""
    last = q.get("last_reviewed") or q.get("updated_at") or 0.0
    if not last:
        return 0.0
    return last + interval_days(q) * DAY


def accuracy(q: dict) -> float | None:
    total = q.get("recall_total") or 0
    if not total:
        return None
    return (q.get("recall_correct") or 0) / total


def why_due(q: dict, now: float) -> str:
    """One sentence a student can argue with."""
    acc = accuracy(q)
    if not (q.get("recall_total") or 0):
        return ("Never tested yourself on this one"
                if q.get("status") != "pending" else "Not studied yet")
    if acc is not None and acc < 0.5:
        return f"Recalled {round(acc * 100)}% of the time - the weakest kind"
    days = max(0.0, (now - due_at(q)) / DAY)
    if days >= 1:
        return f"{int(days)} day{'s' if int(days) != 1 else ''} overdue"
    return "Due today"


def priority(q: dict, now: float, module_weakness: float = 0.0) -> float:
    """Higher comes first. Every term is something the student did or chose."""
    score = 0.0
    overdue = (now - due_at(q)) / DAY
    score += max(0.0, min(overdue, 30.0)) * 2.0        # overdue, capped
    acc = accuracy(q)
    if acc is None:
        # never recalled: worth seeing, but after things known to be failing
        score += 12.0 if q.get("status") in ("studied", "revised") else 4.0
    else:
        score += (1.0 - acc) * 40.0                    # failing beats stale
    if q.get("important"):
        score += 25.0                                  # the student flagged it
    if q.get("status") == "pending":
        score -= 10.0                                  # study it before revising
    if q.get("status") == "mastered":
        score -= 15.0
    score += module_weakness * 20.0
    return round(score, 3)


# --------------------------------------------------------------------------
def module_weakness(stats: dict) -> float:
    """0 (solid) to 1 (nothing done), from the same numbers the dashboard shows."""
    coverage = stats.get("coverage") or 0.0
    recall = stats.get("recall_accuracy")
    revision = stats.get("revision_rate") or 0.0
    # an untested module is not evidence of weakness, only of absence
    recall_gap = 1.0 - recall if recall is not None else 0.5
    return round(min(1.0, 0.45 * (1 - coverage) + 0.4 * recall_gap
                     + 0.15 * (1 - revision)), 4)


def weak_topics(limit: int = 3, subject_id: str | None = None) -> list[dict]:
    """The modules most worth a student's next hour, worst first."""
    out = []
    subs = db.rows("SELECT * FROM subjects"
                   + (" WHERE id = ?" if subject_id else ""),
                   (subject_id,) if subject_id else ())
    for s in subs:
        mods = db.rows("SELECT * FROM modules WHERE subject_id = ? "
                       "ORDER BY position, created_at", (s["id"],))
        qs = db.rows("SELECT * FROM questions WHERE subject_id = ?", (s["id"],))
        by_module: dict[str, list] = {}
        for q in qs:
            by_module.setdefault(q.get("module_id"), []).append(q)
        for m in mods:
            mine = by_module.get(m["id"], [])
            if not mine:
                continue                     # nothing to be weak at yet
            st = readiness.module_stats(m, mine)
            w = module_weakness(st)
            out.append({
                "module_id": m["id"], "module": m["name"],
                "subject_id": s["id"], "subject": s["name"],
                "weakness": w,
                "questions": len(mine),
                "coverage": st.get("coverage"),
                "recall_accuracy": st.get("recall_accuracy"),
                "revision_rate": st.get("revision_rate"),
                "reason": _weak_reason(st),
            })
    out.sort(key=lambda x: (-x["weakness"], x["module"]))
    return out[:limit]


def _weak_reason(st: dict) -> str:
    cov = st.get("coverage") or 0.0
    rec = st.get("recall_accuracy")
    rev = st.get("revision_rate") or 0.0
    bits = []
    if cov < 0.85:
        bits.append(f"{round(cov * 100)}% of its questions studied")
    if rec is None:
        bits.append("never tested from memory")
    elif rec < 0.75:
        bits.append(f"recalled {round(rec * 100)}% of the time")
    if rev < 0.5:
        bits.append(f"{round(rev * 100)}% revised at least once")
    return "; ".join(bits) or "close to solid"


def queue(limit: int = 12, subject_id: str | None = None,
          module_id: str | None = None) -> list[dict]:
    """The next questions to revise, most pressing first."""
    now = time.time()
    sql = ("SELECT q.*, m.name AS module_name, s.name AS subject_name "
           "FROM questions q LEFT JOIN modules m ON m.id = q.module_id "
           "LEFT JOIN subjects s ON s.id = q.subject_id WHERE 1=1")
    args: list = []
    if subject_id:
        sql += " AND q.subject_id = ?"
        args.append(subject_id)
    if module_id:
        sql += " AND q.module_id = ?"
        args.append(module_id)
    qs = db.rows(sql, tuple(args))

    weak = {w["module_id"]: w["weakness"]
            for w in weak_topics(limit=50, subject_id=subject_id)}

    scored = []
    for q in qs:
        if q.get("status") == "mastered" and due_at(q) > now:
            continue                         # known, and not yet stale
        if q.get("status") != "pending" and due_at(q) > now and accuracy(q) is not None:
            continue                         # scheduled for later
        scored.append({
            "id": q["id"], "text": q["text"],
            "module_id": q.get("module_id"), "module": q.get("module_name"),
            "subject_id": q.get("subject_id"), "subject": q.get("subject_name"),
            "status": q.get("status"), "important": bool(q.get("important")),
            "recall_total": q.get("recall_total") or 0,
            "recall_correct": q.get("recall_correct") or 0,
            "accuracy": accuracy(q),
            "due_at": due_at(q),
            "overdue_days": round(max(0.0, (now - due_at(q)) / DAY), 1),
            "interval_days": interval_days(q),
            "why": why_due(q, now),
            "priority": priority(q, now, weak.get(q.get("module_id"), 0.0)),
        })
    scored.sort(key=lambda x: (-x["priority"], x["text"][:40]))
    return scored[:limit]


def plan(limit: int = 12, subject_id: str | None = None) -> dict:
    """Everything the revision screen needs, in one deterministic answer."""
    q = queue(limit=limit, subject_id=subject_id)
    now = time.time()
    return {
        "generated_at": now,
        "queue": q,
        "weak_topics": weak_topics(limit=3, subject_id=subject_id),
        "counts": {
            "due": sum(1 for x in q if x["overdue_days"] > 0),
            "never_tested": sum(1 for x in q if x["recall_total"] == 0),
            "failing": sum(1 for x in q
                           if x["accuracy"] is not None and x["accuracy"] < 0.5),
            "important": sum(1 for x in q if x["important"]),
        },
        "method": ("Ordered by how overdue each question is, how often you have "
                   "recalled it, whether you flagged it important, and how weak "
                   "its module is. Calculated from your records - no model is "
                   "asked."),
    }
