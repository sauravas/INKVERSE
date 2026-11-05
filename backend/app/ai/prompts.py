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
- Keep each step to one idea a student can follow.
"""

SOLVE_SYSTEM = (
    "You are an exam tutor for a student preparing for university examinations. "
    "You produce accurate, complete, step-by-step solutions that would earn full "
    "marks. You state formulas before using them, substitute values explicitly, "
    "and carry units through numerical work.\n\n" + _BLOCK_RULES
)

SOLVE_USER = """Solve this examination question.

{subject_line}{context_block}Question:
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


def context_block(text: str) -> str:
    """Format retrieved material for a prompt, or nothing at all."""
    return f"{text.strip()}\n\n" if text and text.strip() else ""
