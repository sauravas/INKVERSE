"""Deterministic study-progress and exam-readiness computation.

Pure functions over plain dicts: no DB handles, no network, no model calls.
Constraint 3 of ARCHITECTURE.md lives here. Every number shown on the dashboard
is traceable to question rows.
"""
from __future__ import annotations

STATUSES = ("pending", "studied", "revised", "mastered")
# How much each status counts toward "syllabus covered".
COVER = {"pending": 0.0, "studied": 1.0, "revised": 1.0, "mastered": 1.0}
# How much each status counts toward "depth of preparation".
DEPTH = {"pending": 0.0, "studied": 0.5, "revised": 0.8, "mastered": 1.0}

# A readiness verdict needs enough recall evidence to mean anything.
MIN_RECALL_ATTEMPTS = 5
MIN_RECALL_COVERAGE = 0.5


def _safe_div(a: float, b: float):
    return (a / b) if b else None


def module_stats(module: dict, questions: list[dict]) -> dict:
    n = len(questions)
    counts = {s: 0 for s in STATUSES}
    for q in questions:
        counts[q.get("status", "pending")] = counts.get(q.get("status", "pending"), 0) + 1

    cover = _safe_div(sum(COVER.get(q["status"], 0.0) for q in questions), n) or 0.0
    depth = _safe_div(sum(DEPTH.get(q["status"], 0.0) for q in questions), n) or 0.0

    important = [q for q in questions if q.get("important")]
    imp_done = _safe_div(
        sum(1 for q in important if q["status"] == "mastered"), len(important)
    )

    rc = sum(q.get("recall_correct", 0) for q in questions)
    rt = sum(q.get("recall_total", 0) for q in questions)
    attempted = sum(1 for q in questions if q.get("recall_total", 0) > 0)

    revised = sum(1 for q in questions if q.get("revisions", 0) > 0)

    return {
        "id": module["id"],
        "name": module["name"],
        "weight": float(module.get("weight", 1.0)),
        "total": n,
        "counts": counts,
        "coverage": round(cover, 4),
        "depth": round(depth, 4),
        "important_total": len(important),
        "important_mastered": sum(1 for q in important if q["status"] == "mastered"),
        "important_ratio": None if imp_done is None else round(imp_done, 4),
        "recall_correct": rc,
        "recall_total": rt,
        "recall_accuracy": None if not rt else round(rc / rt, 4),
        "recall_coverage": round(_safe_div(attempted, n) or 0.0, 4),
        "revision_rate": round(_safe_div(revised, n) or 0.0, 4),
    }


def subject_report(subject: dict, modules: list[dict], questions: list[dict]) -> dict:
    by_mod: dict[str, list[dict]] = {m["id"]: [] for m in modules}
    loose: list[dict] = []
    for q in questions:
        by_mod.get(q.get("module_id"), loose).append(q)

    mstats = [module_stats(m, by_mod[m["id"]]) for m in modules]
    # Unfiled questions still count, as an implicit unweighted module.
    if loose:
        mstats.append(module_stats(
            {"id": "__unfiled__", "name": "Unfiled", "weight": 1.0}, loose))

    graded = [m for m in mstats if m["total"] > 0]
    wsum = sum(m["weight"] for m in graded)

    def wavg(key):
        if not wsum:
            return 0.0
        return round(sum(m[key] * m["weight"] for m in graded) / wsum, 4)

    total_q = sum(m["total"] for m in mstats)
    imp_total = sum(m["important_total"] for m in mstats)
    imp_done = sum(m["important_mastered"] for m in mstats)
    rc = sum(m["recall_correct"] for m in mstats)
    rt = sum(m["recall_total"] for m in mstats)
    attempted_q = sum(round(m["recall_coverage"] * m["total"]) for m in mstats)

    counts = {s: sum(m["counts"].get(s, 0) for m in mstats) for s in STATUSES}

    coverage = wavg("coverage")
    depth = wavg("depth")
    important_ratio = _safe_div(imp_done, imp_total)
    recall_acc = _safe_div(rc, rt)
    recall_cov = _safe_div(attempted_q, total_q) or 0.0

    req_syl = float(subject.get("req_syllabus", 0.85))
    req_imp = float(subject.get("req_important", 1.0))
    req_rec = float(subject.get("req_recall", 0.75))

    blockers = []
    if total_q == 0:
        blockers.append("No questions added yet.")
    if coverage < req_syl:
        blockers.append(
            f"Syllabus coverage {coverage:.0%} is below the required {req_syl:.0%}.")
    if imp_total == 0:
        blockers.append("No questions are flagged important.")
    elif (important_ratio or 0) < req_imp:
        blockers.append(
            f"Important questions mastered {imp_done}/{imp_total} "
            f"(need {req_imp:.0%}).")
    if rt < MIN_RECALL_ATTEMPTS:
        blockers.append(
            f"Only {rt} active-recall attempts logged (need at least {MIN_RECALL_ATTEMPTS}).")
    elif recall_cov < MIN_RECALL_COVERAGE:
        blockers.append(
            f"Active recall tried on {recall_cov:.0%} of questions "
            f"(need {MIN_RECALL_COVERAGE:.0%}).")
    elif (recall_acc or 0) < req_rec:
        blockers.append(
            f"Recall accuracy {recall_acc:.0%} is below the required {req_rec:.0%}.")

    return {
        "subject": {"id": subject["id"], "name": subject["name"],
                    "exam_date": subject.get("exam_date")},
        "requirements": {"syllabus": req_syl, "important": req_imp, "recall": req_rec},
        "totals": {
            "questions": total_q, "counts": counts,
            "important_total": imp_total, "important_mastered": imp_done,
            "recall_correct": rc, "recall_total": rt,
        },
        "metrics": {
            "coverage": coverage,
            "depth": depth,
            "important_ratio": None if important_ratio is None else round(important_ratio, 4),
            "recall_accuracy": None if recall_acc is None else round(recall_acc, 4),
            "recall_coverage": round(recall_cov, 4),
            "revision_rate": wavg("revision_rate"),
        },
        "modules": mstats,
        "exam_ready": len(blockers) == 0,
        "blockers": blockers,
    }
