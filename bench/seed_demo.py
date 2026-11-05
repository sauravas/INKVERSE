"""Seed demo study data, and assert the readiness rules behave as specified."""
import sys

import httpx

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
BASE = "http://127.0.0.1:8000/api/study"
c = httpx.Client(base_url=BASE, timeout=30)


def subject(name, **kw):
    return c.post("/subjects", json={"name": name, **kw}).json()


def module(sid, name, weight=1.0):
    return c.post("/modules", json={"subject_id": sid, "name": name,
                                    "weight": weight}).json()["id"]


def question(mid, text, status="pending", important=False, recall=(0, 0),
             revise=False):
    r = c.post("/questions", json={"module_id": mid, "text": text,
                                   "important": important})
    r.raise_for_status()
    q = r.json()
    if revise:                       # pass through 'revised' to count a revision
        c.patch(f"/questions/{q['id']}", json={"status": "revised"})
    if status != "pending":
        c.patch(f"/questions/{q['id']}", json={"status": status})
    ok, total = recall
    for i in range(total):
        c.post(f"/questions/{q['id']}/recall", json={"correct": i < ok})
    return q


def main():
    # wipe any previous demo rows so the run is repeatable
    for s in c.get("/subjects").json():
        c.delete(f"/subjects/{s['id']}")

    # ---- subject 1: nearly there, blocked on one thing -------------------
    m = subject("Engineering Mathematics III", exam_date="2026-12-08")
    lap = module(m["id"], "Laplace Transforms", weight=2.0)
    fou = module(m["id"], "Fourier Series", weight=1.5)
    cvx = module(m["id"], "Complex Variables", weight=1.0)

    question(lap, "Find the Laplace transform of t^2 e^{-3t}", "mastered",
             True, (4, 4), True)
    question(lap, "Solve y'' + 4y = sin(2t) using Laplace transforms", "mastered",
             True, (3, 4), True)
    question(lap, "State and prove the first shifting theorem", "revised",
             False, (2, 3), True)
    question(lap, "Inverse Laplace of 1/(s^2+4s+13)", "studied", False, (1, 2))

    question(fou, "Expand f(x)=x on (-pi, pi) as a Fourier series", "mastered",
             True, (3, 3), True)
    question(fou, "Half-range cosine series for f(x)=x on (0,2)", "revised",
             False, (2, 2), True)
    question(fou, "State Dirichlet conditions", "studied", False, (1, 1))

    question(cvx, "Show that f(z)=z^2 is analytic everywhere", "mastered",
             False, (2, 2), True)
    # the one gap: an important question still unmastered
    question(cvx, "Evaluate contour integral of 1/(z^2+1) over |z|=2", "studied",
             True, (0, 2))

    # ---- subject 2: barely started --------------------------------------
    p = subject("Operating Systems", exam_date="2026-12-15")
    sch = module(p["id"], "Process Scheduling", weight=1.0)
    mem = module(p["id"], "Memory Management", weight=1.0)
    question(sch, "Compare SJF and Round Robin scheduling", "studied")
    question(sch, "What causes a context switch?", "pending", True)
    question(mem, "Explain demand paging and page faults", "pending", True)

    # ---- verify the rules ------------------------------------------------
    d = httpx.get(f"{BASE}/dashboard", timeout=30).json()
    print(f"overall: {d['overall']}\n")
    ok = True
    for r in d["subjects"]:
        met = r["metrics"]
        print(f"{r['subject']['name']}")
        print(f"  exam_ready = {r['exam_ready']}")
        print(f"  coverage {met['coverage']:.0%} | depth {met['depth']:.0%} | "
              f"recall {met['recall_accuracy']} | important {met['important_ratio']}")
        for b in r["blockers"]:
            print(f"  blocker: {b}")
        for m_ in r["modules"]:
            print(f"    {m_['name']:22} {m_['coverage']:.0%} of {m_['total']}q "
                  f"(weight {m_['weight']})")
        print()

    maths = d["subjects"][0]
    # it has high coverage but one important question unmastered -> NOT ready
    if maths["exam_ready"]:
        print("FAIL: subject with an unmastered important question was called ready")
        ok = False
    elif not any("Important" in b for b in maths["blockers"]):
        print("FAIL: the important-question gap was not reported as the blocker")
        ok = False
    else:
        print("PASS: high coverage did not override the important-question rule")

    os_sub = d["subjects"][1]
    if os_sub["exam_ready"]:
        print("FAIL: barely-started subject was called ready")
        ok = False
    else:
        print("PASS: barely-started subject is not ready "
              f"({len(os_sub['blockers'])} blockers)")

    # now master the blocking question and confirm the verdict flips
    qs = httpx.get(f"{BASE}/questions", params={"subject_id": maths["subject"]["id"]},
                   timeout=30).json()
    gap = next(q for q in qs if q["important"] and q["status"] != "mastered")
    c.patch(f"/questions/{gap['id']}", json={"status": "mastered"})
    c.post(f"/questions/{gap['id']}/recall", json={"correct": True})
    c.post(f"/questions/{gap['id']}/recall", json={"correct": True})
    again = httpx.get(f"{BASE}/dashboard",
                      params={"subject_id": maths["subject"]["id"]}, timeout=30).json()
    r2 = again["subjects"][0]
    print(f"\nafter mastering the gap: exam_ready = {r2['exam_ready']}")
    if r2["exam_ready"]:
        print("PASS: verdict flipped to EXAM READY once the rule was satisfied")
    else:
        print(f"FAIL: still not ready -> {r2['blockers']}")
        ok = False

    print("\nSEED RESULT:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
