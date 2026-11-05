"""Parser and OCR checks for the import pipeline, against realistic documents."""
import io
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from app import ingest  # noqa: E402

QUESTION_BANK = """University of Mumbai
Engineering Mathematics III - Question Bank
Page 1 of 4

Module 1: Laplace Transform
Q1. Find the Laplace transform of t^2 e^-3t. [5]
Q2. State and prove the first shifting theorem. (5 marks)
Q3. Attempt any two of the following:
(a) Find L{sin 2t cos 3t}
(b) Evaluate the integral of e^-t sin t / t from 0 to infinity
using Laplace transforms. [6]
(c) Find the inverse Laplace transform of 1/(s^2+4s+13)

Module 2
Fourier Series
1. Expand f(x) = x in (-pi, pi) as a Fourier series.
2) Obtain the half range cosine series for f(x) = x in (0, 2). [8 M]
3. For the function f(x) = x^2 in (0, 2pi),
(a) find the Fourier series
(b) hence deduce that 1/1^2 + 1/2^2 + ... = pi^2/6
"""

SYLLABUS = """Course: Operating Systems (CSC502)
Unit I Introduction
Operating system objectives and functions, OS structure, system calls.
Unit II: Process Management
Process concept, process states, PCB, context switching, threads,
multithreading models. Scheduling: FCFS, SJF, Round Robin, priority.
Unit III - Memory Management
Paging, segmentation, virtual memory, demand paging, page replacement.
"""


def check(name, cond, detail=""):
    print(f"{'PASS' if cond else 'FAIL'}  {name}{('  ' + detail) if detail else ''}")
    return cond


def main():
    ok = True

    r = ingest.parse(QUESTION_BANK)
    mods = r["modules"]
    print(f"\nquestion bank -> kind={r['kind']}, {len(mods)} modules")
    for m in mods:
        print(f"  [{m['name']}]")
        for q in m["questions"]:
            print(f"     - {q['text'][:78]!r}  marks={q['marks']}")
    ok &= check("detected as a question bank", r["kind"] == "questions")
    ok &= check("two modules found", len(mods) == 2, str([m["name"] for m in mods]))
    ok &= check("module title on the following line is picked up",
                mods[1]["name"] == "Module 2: Fourier Series", mods[1]["name"])
    m1 = [q["text"] for q in mods[0]["questions"]]
    ok &= check("instructional stem dropped, sub-parts kept",
                not any("Attempt any two" in t for t in m1) and len(m1) == 5,
                f"{len(m1)} questions")
    ok &= check("continuation line joined to its question",
                any("using Laplace transforms" in t and "(b)" in t for t in m1))
    ok &= check("marks extracted", mods[0]["questions"][0]["marks"] == "5"
                and mods[0]["questions"][1]["marks"] == "5")
    m2 = [q["text"] for q in mods[1]["questions"]]
    ok &= check("substantive stem kept as context for its sub-parts",
                any(t.startswith("For the function f(x) = x^2") and "(b)" in t
                    for t in m2))
    ok &= check("page header noise not turned into a question",
                not any("Page 1" in t for m in mods for t in
                        [q["text"] for q in m["questions"]]))

    s = ingest.parse(SYLLABUS)
    print(f"\nsyllabus -> kind={s['kind']}, modules={[m['name'] for m in s['modules']]}")
    ok &= check("detected as a syllabus", s["kind"] == "syllabus")
    ok &= check("three units found", len(s["modules"]) == 3)
    ok &= check("unit body kept as notes for retrieval",
                "Round Robin" in s["modules"][1]["notes"])

    chunks = ingest.chunk(SYLLABUS * 4)
    ok &= check("chunking stays near target size",
                all(len(c) <= 1050 for c in chunks), f"{len(chunks)} chunks")

    # --- OCR: render a printed question paper and read it back -------------
    st = ingest.ocr_status()
    print(f"\ntesseract: {st.get('version', st.get('detail'))}")
    if st["available"]:
        img = Image.new("RGB", (1240, 700), "white")
        d = ImageDraw.Draw(img)
        font = ImageFont.truetype(r"C:\Windows\Fonts\times.ttf", 34)
        y = 60
        for line in ["Module 3: Complex Variables",
                     "Q1. Show that f(z) = z^2 is analytic everywhere. [5]",
                     "Q2. Evaluate the contour integral of 1/(z^2+1)",
                     "over the circle |z| = 2. [6]",
                     "Q3. State Cauchy's integral formula."]:
            d.text((70, y), line, fill="black", font=font)
            y += 70
        buf = io.BytesIO()
        img.save(buf, "PNG")
        res = ingest.extract("scan.png", buf.getvalue())
        parsed = ingest.parse(res["text"])
        qs = [q["text"] for m in parsed["modules"] for q in m["questions"]]
        print(f"  OCR text: {res['text'].strip()[:120]!r}...")
        print(f"  parsed questions: {qs}")
        ok &= check("OCR method recorded", res["method"] == "ocr")
        ok &= check("OCR'd paper parses into 3 questions", len(qs) == 3, str(len(qs)))
        ok &= check("OCR keeps the wording",
                    any("analytic everywhere" in q for q in qs))

        # scanned PDF (no text layer) must route through OCR per page
        pdf = io.BytesIO()
        img.save(pdf, "PDF", resolution=150)
        res = ingest.extract("scan.pdf", pdf.getvalue())
        ok &= check("scanned PDF page falls back to OCR",
                    res["page_methods"] == ["ocr"] and "analytic" in res["text"],
                    str(res["page_methods"]))
    else:
        ok = False

    print("\nINGEST RESULT:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
