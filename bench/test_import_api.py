"""End-to-end import over HTTP: extract -> commit -> retrieve -> clean up.

Uses a throwaway subject so the student's real data is left untouched.
"""
import io
import sys
import time

import httpx
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, "bench")
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
from test_ingest import QUESTION_BANK, SYLLABUS  # noqa: E402

BASE = "http://127.0.0.1:8000/api"
SUBJECT = f"__import_test_{int(time.time())}"


def check(name, cond, detail=""):
    print(f"{'PASS' if cond else 'FAIL'}  {name}{('  ' + detail) if detail else ''}")
    return cond


def main():
    c = httpx.Client(base_url=BASE, timeout=600)
    ok = True

    st = c.get("/import/status").json()
    ok &= check("OCR available", st["ocr"]["available"], st["ocr"].get("version", ""))

    # 1. a typed question bank
    r = c.post("/import/extract", files={"file": ("bank.txt", QUESTION_BANK.encode())},
               data={"kind": "auto"})
    r.raise_for_status()
    ex = r.json()
    ok &= check("extract proposes structure without saving",
                ex["summary"]["questions"] == 9 and ex["kind"] == "questions",
                str(ex["summary"]))

    commit = c.post("/import/commit", json={
        "subject_name": SUBJECT, "filename": "bank.txt", "kind": ex["kind"],
        "method": ex["method"], "pages": ex["pages"], "text": ex["text"],
        "modules": ex["modules"]}).json()
    sid = commit["subject_id"]
    ok &= check("commit creates modules and questions",
                commit["modules_created"] == 2 and commit["questions_created"] == 9,
                str(commit))

    again = c.post("/import/commit", json={
        "subject_id": sid, "filename": "bank.txt", "kind": ex["kind"],
        "text": ex["text"], "modules": ex["modules"]}).json()
    ok &= check("re-importing the same paper does not duplicate anything",
                again["modules_created"] == 0 and again["questions_created"] == 0
                and again["chunks_indexed"] == 0
                and again["source_id"] == commit["source_id"], str(again))

    # 2. a scanned syllabus page, via OCR, into the same subject
    img = Image.new("RGB", (1240, 520), "white")
    d = ImageDraw.Draw(img)
    font = ImageFont.truetype(r"C:\Windows\Fonts\times.ttf", 32)
    lines = ["Module 1: Laplace Transform",
             "Definition, existence conditions, linearity property,",
             "first shifting theorem, change of scale property,",
             "Laplace transform of periodic functions and the unit step function."]
    for i, line in enumerate(lines):
        d.text((60, 60 + i * 64), line, fill="black", font=font)
    buf = io.BytesIO()
    img.save(buf, "PNG")
    ex2 = c.post("/import/extract", files={"file": ("syllabus.png", buf.getvalue())},
                 data={"kind": "syllabus"}).json()
    ok &= check("scanned syllabus goes through OCR", ex2["method"] == "ocr")
    commit2 = c.post("/import/commit", json={
        "subject_id": sid, "filename": "syllabus.png", "kind": "syllabus",
        "method": ex2["method"], "text": ex2["text"], "modules": ex2["modules"]}).json()
    ok &= check("syllabus attaches to the existing module, not a duplicate",
                commit2["modules_created"] == 0 and commit2["chunks_indexed"] >= 1,
                str(commit2))

    # 3. retrieval finds the right material
    subj = next(s for s in c.get("/study/subjects").json() if s["id"] == sid)
    laplace = next(m for m in subj["modules"] if "Laplace" in m["name"])
    hits = c.get("/import/search", params={
        "q": "Prove the first shifting theorem for Laplace transforms",
        "subject_id": sid, "module_id": laplace["id"]}).json()
    top = hits["sources"][0]["snippet"] if hits["sources"] else ""
    ok &= check("retrieval returns the syllabus passage on shifting",
                "shifting" in top.lower(), repr(top[:80]))

    other = c.get("/import/search", params={
        "q": "Explain demand paging and page faults", "subject_id": sid}).json()
    ok &= check("unrelated question gets no false grounding",
                len(other["sources"]) == 0, f"{len(other['sources'])} hits")

    sources = c.get("/import/sources", params={"subject_id": sid}).json()
    ok &= check("each distinct document recorded once", len(sources) == 2,
                f"{len(sources)} rows")

    # 4. clean up the throwaway subject
    for s in sources:
        c.delete(f"/import/sources/{s['id']}")
    c.delete(f"/study/subjects/{sid}")
    left = [s for s in c.get("/study/subjects").json() if s["id"] == sid]
    ok &= check("test data removed", not left)

    print("\nIMPORT API RESULT:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
