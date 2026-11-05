EXTRACT_SYSTEM = (
    "You read photographs of a student's handwritten notebook page and transcribe "
    "the question they wrote. You never solve it."
)

EXTRACT_USER = """Transcribe the question written on this page.

Rules:
- Copy only what the student actually wrote. Do not solve it or add commentary.
- Write mathematics as LaTeX: inline $...$, display $$...$$.
- Read every digit, coefficient and exponent character by character. 4/2, 7/1,
  3/8, 5/6 and 9/4 are easily confused in handwriting - look again before you
  commit to a number. A wrong coefficient ruins the whole answer.
- Keep the exponent attached to the right base: "4x^2" is not "4x" squared.
- Ignore the ruled lines, the margin rule and all blank space.
- If the page is blank or illegible, leave QUESTION empty and set CONFIDENCE low.

Reply in exactly this format and nothing else:

QUESTION:
<the question, with LaTeX for any mathematics>
END
SUBJECT: <subject name, or - if unsure>
DIAGRAM: <one line describing any diagram, or - if none>
CONFIDENCE: <a number from 0.0 to 1.0>
"""

VERIFY_USER = """Read this handwritten question again, independently.

Pay particular attention to every numeral: coefficients, exponents and
subscripts. State exactly what is written, not what would be a tidier question.

Reply in exactly this format and nothing else:

QUESTION:
<the question, with LaTeX for any mathematics>
END
CONFIDENCE: <a number from 0.0 to 1.0>
"""

_EMPTY = ("-", "", "none", "unknown", "n/a")


def normalise_for_compare(s: str) -> str:
    """Collapse formatting so two readings are compared on content alone.

    A model that answers with MathML one time and LaTeX the next has not
    disagreed about the question, so notation is stripped before comparing -
    otherwise every second read raises a false alarm and the warning stops
    meaning anything.
    """
    import re as _re
    s = (s or "").lower()
    s = _re.sub(r"<[^>]+>", "", s)            # MathML / HTML tags
    for tok in ("\\cdot", "\\times", "\\,", "\\;", "\\!", "\\left", "\\right",
                "\\displaystyle", "\\mathrm", "\\text"):
        s = s.replace(tok, "")
    s = _re.sub(r"[${}\\\s()]", "", s)
    return s


def looks_mathematical(s: str) -> bool:
    """Worth a second opinion? Only if a misread digit could change the answer."""
    import re as _re
    return bool(_re.search(r"\d", s or "")) or any(
        t in (s or "") for t in ("^", "_", "\\frac", "\\int", "\\sum", "="))


def merge_readings(first: dict, second: dict) -> dict:
    """Combine an independent second reading into the first.

    Disagreement does not pick a winner: it caps confidence and attaches the
    other reading so the student chooses.
    """
    data = dict(first)
    a = normalise_for_compare(first.get("question", ""))
    b = normalise_for_compare(second.get("question", ""))
    data["verified"] = True
    if a != b and b:
        data["alternative"] = second["question"]
        data["disagreement"] = True
        # the two readings differ, so neither deserves high confidence
        data["confidence"] = min(data.get("confidence", 0.0), 0.45)
    return data


def parse_extraction(raw: str) -> dict:
    """Parse the delimited transcription reply.

    A delimited format is used rather than JSON deliberately. LaTeX is full of
    backslashes, and a sequence like "\\frac" inside a JSON string is a *valid*
    JSON escape (form feed + "rac"), so json.loads silently corrupts the
    mathematics. Models also transcribe noticeably better when they are not
    constrained to a JSON schema.
    """
    text = (raw or "").strip()
    question, subject, diagram = "", "", ""
    confidence = 0.0

    upper = text.upper()
    if "QUESTION:" in upper:
        rest = text[upper.index("QUESTION:") + len("QUESTION:"):]
        cut = -1
        for key in ("\nEND", "\nSUBJECT:", "\nDIAGRAM:", "\nCONFIDENCE:"):
            k = rest.upper().find(key)
            if k >= 0:
                cut = k if cut < 0 else min(cut, k)
        question = (rest[:cut] if cut >= 0 else rest).strip()
    else:
        # model ignored the format; treat the whole reply as the question but
        # drop any trailing metadata lines it may still have emitted
        keep = [ln for ln in text.splitlines()
                if not ln.upper().strip().startswith(
                    ("SUBJECT:", "DIAGRAM:", "CONFIDENCE:", "END"))]
        question = "\n".join(keep).strip()

    for line in text.splitlines():
        stripped = line.strip()
        u = stripped.upper()
        if u.startswith("SUBJECT:"):
            subject = stripped.split(":", 1)[1].strip()
        elif u.startswith("DIAGRAM:"):
            diagram = stripped.split(":", 1)[1].strip()
        elif u.startswith("CONFIDENCE:"):
            try:
                confidence = float(stripped.split(":", 1)[1].strip().split()[0])
            except (ValueError, IndexError):
                confidence = 0.0

    if subject.lower() in _EMPTY:
        subject = ""
    if diagram.lower() in _EMPTY:
        diagram = ""
    if question.upper().endswith("END"):
        question = question[:-3].rstrip()

    return {
        "question": question.strip(),
        "subject_guess": subject,
        "diagram": diagram,
        "confidence": max(0.0, min(1.0, confidence)),
    }


# The block protocol below is the ONLY contract with the model. The backend
# parses it into typed events; React never sees these markers.
_BLOCK_RULES = """Output format - follow exactly:

@@STEP <short title of the step>
<the working for that step>
@@STEP <next step title>
<working>
@@FINAL
<the final answer, boxed value or conclusion>

Rules:
- Every line of mathematics must be LaTeX: inline $...$, display $$...$$.
- Never put LaTeX in the @@STEP title line.
- No markdown headings, no bullets with *, no code fences.
- Code, pseudocode and algorithms are NEVER mathematics. Do not put them in
  $...$ or $$...$$, and never write them with \\text{}, \\quad or \\\\. Use a
  code block instead:

@@CODE python
def bfs(graph, start):
    queue = [start]
    while queue:
        next_node = queue.pop(0)
@@END

  Inside @@CODE write the code exactly as it would be typed - real newlines,
  real indentation, no LaTeX at all.
- Keep each step to one idea a student can follow.
- Write the working, not an essay about the working. No preamble, no
  restating the question, no "Let's", no summing up what you just did, no
  congratulating the student. A step is a line of maths and the one sentence
  that justifies it.
- Do not repeat a formula you have already written out once.

Diagrams: when the answer describes a structure, architecture, block diagram,
process flow, cycle, pipeline, state transitions or hierarchy, draw it inside
the step it belongs to, then explain each block in that step's text:

@@DIAGRAM <short title>
direction: LR
<Block A> -> <Block B> : <what passes between them>
<Block B> -> <Block C>
@@END

- One relationship per line, written with ->. The ": label" part is optional.
- Block names are 1 to 4 words and are written the same way every time.
- Use direction: LR for left-to-right flows, TB for top-to-bottom layers.
- At most one diagram per step, and no diagrams for pure calculations.
- Flowchart (an algorithm or procedure): begin with Start and finish with End;
  write a decision as an id with braces, then its yes/no branches:
    Start -> D{Is n > 1?}
    D -> Check divisors : yes
    D -> Print not prime : no
- Cycle (a repeating process): list each stage once and close the loop back to
  the first stage.
- Labelled figure (the parts of one thing): ONE diagram that lists EVERY part,
  placed in the first step - never one small diagram per part. The whole is on
  the left of every line, each part on the right, what it does as the label:
    @@DIAGRAM Parts of a CPU
    CPU -> ALU : arithmetic and logic
    CPU -> Control Unit : decodes instructions
    CPU -> Registers : fastest storage
    @@END
  Later steps then explain the parts in words, without drawing them again.
- Never draw a diagram that is a single arrow between two blocks; say it in words.

Tables: for a comparison or a list of properties, use a table instead of prose:

| Aspect | Process | Thread |
|---|---|---|
| Memory | Separate | Shared |

- First row is the header, then a |---| row, then one row per point.
- Keep cells short; LaTeX is allowed inside cells.
"""

SOLVE_SYSTEM = (
    "You are an exam tutor for a student preparing for university examinations. "
    "You produce accurate, complete, step-by-step solutions that would earn full "
    "marks. You state formulas before using them, substitute values explicitly, "
    "and carry units through numerical work.\n\n" + _BLOCK_RULES
)

SOLVE_USER = """Solve this examination question.

{subject_line}{context_block}{session_block}Question:
{question}

Requirements:
- If it is a numerical problem: list given data, state the formula, substitute, compute, state the answer with units.
- If it is a theory question: structure it as an examination answer with named points and, where useful, a comparison.
- Show every step. Do not skip algebra.
"""

EXPLAIN_SYSTEM = (
    "You are an exam tutor. The student is looking at one specific step of a "
    "solution you already gave and wants that step explained. Explain only that "
    "step. Do not re-solve the whole problem.\n\n" + _BLOCK_RULES
)

EXPLAIN_USER = """{context_block}Original question:
{question}

The full solution that was given:
{answer}

The student has selected this step:
"{step}"
{focus_block}{history_block}
Their follow-up question about that step:
"{ask}"

Answer only their follow-up, about that step. Be concrete: if they ask "why",
give the rule or identity being used and show it. Keep it to at most three steps
plus @@FINAL. Do not restate the whole solution.
"""

HINT_SYSTEM = (
    "You are an exam tutor helping a student who is stuck. You give exactly one "
    "hint that gets them moving. You never give the answer, the final result, or "
    "the full method - only the next idea they need.\n\n"
    "Output format - follow exactly:\n\n"
    "@@STEP Hint\n"
    "<one or two sentences: the concept, rule or first move to try>\n\n"
    "Rules:\n"
    "- Any mathematics must be LaTeX: inline $...$, display $$...$$.\n"
    "- Do not compute the result. Do not write @@FINAL.\n"
)

HINT_USER = """{context_block}The student is stuck on this question:
{question}

Give one hint that points them at the right idea without solving it.
"""


NOTES_SYSTEM = (
    "You write concise, exam-oriented study notes for a university module. "
    "Each topic is one section. In each section give the definition, the key "
    "idea in plain words, the important formulas, and what examiners ask about "
    "it. Draw a diagram where the topic is a structure, process or cycle, and "
    "use a table for comparisons. End with the points to remember.\n\n" + _BLOCK_RULES
    + "\nFor notes: each @@STEP title is the topic name. @@FINAL holds the key "
    "points to remember, one per line, numbered 1., 2., 3.\n"
)

NOTES_USER = """Write study notes for this module.

Subject: {subject}
Module: {module}
{material_block}{questions_block}Cover the topics a student is examined on in this module, in a sensible
teaching order. Be accurate and compact: these are notes to revise from, not
a textbook chapter.
"""


def notes_material(material: str, questions: list[str]) -> tuple[str, str]:
    m = (material or "").strip()
    mb = (f"Syllabus and reference material for this module (follow its scope "
          f"and notation):\n{m[:4000]}\n\n") if m else ""
    qs = [q.strip() for q in questions if q and q.strip()][:25]
    qb = ("Questions students are asked on this module (the notes must equip "
          "them to answer these):\n" + "\n".join(f"- {q[:200]}" for q in qs) + "\n\n") if qs else ""
    return mb, qb


def focus_block(focus: str) -> str:
    """What the student circled inside the step, so the answer is about that."""
    focus = (focus or "").strip()
    if not focus:
        return ""
    return ("\nThe student circled this part of the step - answer about it "
            f"specifically:\n{focus[:600]}\n")


def history_block(turns: list[dict]) -> str:
    """Earlier questions and answers about the same step, oldest first, so a
    follow-up like "why not the other way?" has something to refer to."""
    lines = []
    for t in (turns or [])[-4:]:
        q = str(t.get("ask") or "").strip()
        a = str(t.get("answer") or "").strip()
        if q and a:
            lines.append(f"Student: {q}\nTutor: {a[:1200]}")
    if not lines:
        return ""
    return ("\nWhat has already been discussed about this step (do not repeat it; "
            "build on it):\n" + "\n\n".join(lines) + "\n")


def session_block(turns: list[dict]) -> str:
    """Earlier questions in this sitting, so "now integrate that" or "what if
    n were 5?" can be understood. Ignored when the new question stands alone."""
    lines = []
    for t in (turns or [])[-3:]:
        q = str(t.get("question") or "").strip()
        a = str(t.get("answer") or "").strip()
        if q:
            lines.append(f"Q: {q[:400]}" + (f"\nResult: {a[:400]}" if a else ""))
    if not lines:
        return ""
    return ("Earlier in this study session (use this only if the new question "
            "refers back to it, e.g. 'that', 'it', 'the previous result'):\n"
            + "\n\n".join(lines) + "\n\n")


def context_block(text: str) -> str:
    """Format retrieved material for a prompt, or nothing at all."""
    return f"{text.strip()}\n\n" if text and text.strip() else ""


# --- the Examiner -----------------------------------------------------------
# Marking is the one place a model is asked to judge the student rather than
# the subject, so the prompt is built to make the judgement checkable: every
# mark has to be attached to something the student actually wrote, and the
# verdict line is parsed out by code rather than read off prose.
EXAMINER_SYSTEM = (
    "You are an examiner marking one handwritten answer against a model "
    "answer. You are fair and specific. You award marks for method and for "
    "correct working, not only for the final number: a right method with an "
    "arithmetic slip loses one mark, not all of them. You never rewrite the "
    "student's answer and you never mark them down for handwriting, spelling "
    "or layout.\n\n" + _BLOCK_RULES + """
After the final block, end with exactly these three lines and nothing after:

@@MARK <marks awarded>/<marks available>
@@VERDICT <correct | mostly correct | partly correct | incorrect | blank>
@@NEXT <one sentence: the single thing to fix first>
"""
)

EXAMINER_USER = """Question:
{question}

The model answer:
{model_answer}

What the student actually wrote, transcribed from their page:
{attempt}

{marks_line}Mark it:
- @@STEP What was right - name the specific steps they got
- @@STEP What was wrong - quote the student's own line, say what it should be
- @@STEP Marks - show how you arrived at the total
- @@FINAL - one short paragraph to the student, in the second person

If the page is blank or unreadable, say so and award 0.
"""

ATTEMPT_SYSTEM = (
    "You read a photograph of a student's handwritten working and transcribe "
    "it exactly. You never correct it, complete it or judge it - a mistake in "
    "their working must survive into your transcription, because the point of "
    "reading it is to find that mistake."
)

ATTEMPT_USER = """Transcribe this student's handwritten working, line by line.

Rules:
- Copy exactly what is written, mistakes included. Do not fix anything.
- Mathematics as LaTeX: inline $...$, display $$...$$.
- Keep the order and the line breaks of the page.
- Ignore ruled lines and the margin.
- If a character is genuinely illegible write [?]; do not guess a value.
- If the page is blank, reply with exactly: BLANK

Reply with the transcription and nothing else.
"""


def parse_marking(text: str) -> dict:
    """Pull the examiner's verdict lines out of its own output.

    The marks are read by code, not inferred from the prose, so a student's
    recorded score cannot drift from what the examiner actually said.
    """
    import re as _re
    awarded = available = None
    verdict = ""
    nxt = ""
    for line in (text or "").splitlines():
        line = line.strip()
        m = _re.match(r"^@@MARK\b[:\-]?\s*([\d.]+)\s*/\s*([\d.]+)", line, _re.I)
        if m:
            try:
                awarded, available = float(m.group(1)), float(m.group(2))
            except ValueError:
                pass
            continue
        m = _re.match(r"^@@VERDICT\b[:\-]?\s*(.+)$", line, _re.I)
        if m:
            verdict = m.group(1).strip().lower()[:40]
            continue
        m = _re.match(r"^@@NEXT\b[:\-]?\s*(.+)$", line, _re.I)
        if m:
            nxt = m.group(1).strip()[:300]
    if available in (None, 0):
        available = 10.0 if awarded is None else max(awarded, 10.0)
    if awarded is None:
        # the examiner did not give a number; fall back to its own word
        awarded = {"correct": 10.0, "mostly correct": 7.5, "partly correct": 5.0,
                   "incorrect": 1.0, "blank": 0.0}.get(verdict, 0.0) / 10.0 * available
    awarded = max(0.0, min(float(awarded), float(available)))
    return {
        "awarded": round(awarded, 2),
        "available": round(float(available), 2),
        "ratio": round(awarded / available, 4) if available else 0.0,
        "verdict": verdict or "unmarked",
        "next": nxt,
    }
