"""The revision queue is arithmetic, and has to behave like it.

Constraint 3 says progress is calculated, never generated. That is only worth
anything if the calculation is pinned down: a student who is told "revise this
first" should be able to ask why and get the same answer twice.

    .venv\\Scripts\\python.exe bench\\test_revision.py
"""
import os
import sys
import tempfile
import time
from pathlib import Path

os.environ.setdefault("INKWISE_DATA", tempfile.mkdtemp(prefix="inkwise-rev-"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from app import db, revision  # noqa: E402

DAY = 86400.0
fails = 0


def check(name, cond, detail=""):
    global fails
    print(("  ok   " if cond else "  FAIL ") + name
          + (f"  ({detail})" if detail and not cond else ""))
    fails += 0 if cond else 1


def q(**kw):
    base = {"status": "studied", "important": 0, "revisions": 1,
            "recall_correct": 0, "recall_total": 0,
            "last_reviewed": time.time(), "updated_at": time.time()}
    base.update(kw)
    return base


print("the schedule stretches as a question is recalled")
intervals = [revision.interval_days(q(recall_correct=n, recall_total=n))
             for n in range(6)]
check("each success pushes the next sighting further out",
      intervals == sorted(intervals) and intervals[0] < intervals[-1], intervals)
check("a never-tested question is due now",
      revision.interval_days(q()) == 0.0)
check("a failed question collapses back to the start",
      revision.interval_days(q(recall_correct=3, recall_total=7)) == 0.0,
      revision.interval_days(q(recall_correct=3, recall_total=7)))
check("the interval stops growing rather than running away",
      revision.interval_days(q(recall_correct=50, recall_total=50))
      == revision.interval_days(q(recall_correct=6, recall_total=6)))

print("priority puts the right question first")
now = time.time()
failing = q(recall_correct=1, recall_total=6, last_reviewed=now - 2 * DAY)
solid = q(recall_correct=6, recall_total=6, last_reviewed=now - 2 * DAY)
fresh = q(recall_correct=0, recall_total=0, status="pending")
flagged = q(recall_correct=3, recall_total=6, important=1,
            last_reviewed=now - 2 * DAY)
check("being forgotten beats being merely old",
      revision.priority(failing, now) > revision.priority(solid, now))
check("a question the student flagged important outranks one they did not",
      revision.priority(flagged, now)
      > revision.priority(q(recall_correct=3, recall_total=6,
                            last_reviewed=now - 2 * DAY), now))
check("something not studied yet is not top of a revision list",
      revision.priority(fresh, now) < revision.priority(failing, now))
check("overdue is capped so one ancient question cannot own the queue",
      revision.priority(q(recall_correct=4, recall_total=4,
                          last_reviewed=now - 4000 * DAY), now)
      < revision.priority(failing, now) + 200)

print("every item explains itself")
check("a failing question says so",
      "%" in revision.why_due(failing, now), revision.why_due(failing, now))
check("an untested question says so",
      "never" in revision.why_due(q(), now).lower(), revision.why_due(q(), now))

print("weakness comes from the same numbers the dashboard shows")
check("nothing done is maximally weak",
      revision.module_weakness({"coverage": 0.0, "recall_accuracy": 0.0,
                                "revision_rate": 0.0}) > 0.9)
check("everything done is not weak",
      revision.module_weakness({"coverage": 1.0, "recall_accuracy": 1.0,
                                "revision_rate": 1.0}) < 0.05)
check("an untested module is not called weak on no evidence",
      revision.module_weakness({"coverage": 1.0, "recall_accuracy": None,
                                "revision_rate": 1.0}) < 0.25)

print("against a real database")
db.init()
t = db.now()
sid, mid1, mid2 = db.nid(), db.nid(), db.nid()
db.run("INSERT INTO subjects (id,name,created_at) VALUES (?,?,?)", (sid, "DSP", t))
for mid, name in ((mid1, "Weak module"), (mid2, "Strong module")):
    db.run("INSERT INTO modules (id,subject_id,name,position,created_at) "
           "VALUES (?,?,?,0,?)", (mid, sid, name, t))
# weak: studied but repeatedly forgotten.  strong: mastered and recalled.
for i in range(4):
    db.run("INSERT INTO questions (id,module_id,subject_id,text,status,important,"
           "revisions,recall_correct,recall_total,last_reviewed,created_at,updated_at)"
           " VALUES (?,?,?,?,'studied',?,1,1,5,?,?,?)",
           (db.nid(), mid1, sid, f"Weak question {i}", 1 if i == 0 else 0,
            t - 9 * DAY, t, t))
for i in range(4):
    db.run("INSERT INTO questions (id,module_id,subject_id,text,status,important,"
           "revisions,recall_correct,recall_total,last_reviewed,created_at,updated_at)"
           " VALUES (?,?,?,?,'mastered',0,3,6,6,?,?,?)",
           (db.nid(), mid2, sid, f"Strong question {i}", t, t, t))

weak = revision.weak_topics(limit=2)
check("the weak module is named first",
      weak and weak[0]["module"] == "Weak module",
      str([w["module"] for w in weak]))
check("and it says why", "recalled" in (weak[0]["reason"] if weak else ""),
      weak[0]["reason"] if weak else "")

plan = revision.plan(limit=10)
texts = [x["text"] for x in plan["queue"]]
check("the queue is all from the weak module",
      texts and all(x.startswith("Weak") for x in texts), str(texts[:5]))
check("the important one is first",
      texts and texts[0] == "Weak question 0", str(texts[:2]))
check("mastered-and-fresh questions are not in the queue",
      not any(x.startswith("Strong") for x in texts))
check("it counts what is overdue", plan["counts"]["failing"] == 4,
      str(plan["counts"]))
check("it is reproducible",
      [x["id"] for x in revision.plan(limit=10)["queue"]]
      == [x["id"] for x in plan["queue"]])
check("it says it asked no model", "no model" in plan["method"])

print("\n" + ("ALL PASSED" if not fails else f"{fails} FAILED"))
sys.exit(1 if fails else 0)
