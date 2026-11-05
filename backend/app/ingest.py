"""Importing question banks, syllabi and notes.

Text is taken from the document's own text layer wherever it has one, and only
pages without usable text are sent through Tesseract - OCR is slower and less
accurate than text that is already there. Everything here is deterministic and
CPU-only; callers run it in a worker thread so the server stays responsive.
"""
from __future__ import annotations

import io
import os
import re
import shutil
import subprocess
from pathlib import Path

from PIL import Image, ImageOps

from . import config

IMAGE_EXT = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}
TEXT_EXT = {".txt", ".md", ".markdown", ".csv"}
MAX_PAGES = int(os.getenv("INKWISE_IMPORT_MAX_PAGES", "80"))
OCR_DPI = 300
MIN_PAGE_TEXT = 40          # below this, a PDF page is treated as scanned


class ImportError_(RuntimeError):
    pass


# --- Tesseract ---------------------------------------------------------------

def tesseract_cmd() -> str | None:
    """Locate tesseract.exe. The Windows installer does not add it to PATH."""
    candidates = [
        config.TESSERACT_CMD,
        shutil.which("tesseract"),
        r"C:\Program Files\Tesseract-OCR\tesseract.exe",
        r"C:\Program Files (x86)\Tesseract-OCR\tesseract.exe",
        str(Path(os.getenv("LOCALAPPDATA", "")) / "Programs/Tesseract-OCR/tesseract.exe"),
    ]
    for c in candidates:
        if c and Path(c).is_file():
            return c
    return None


def ocr_status() -> dict:
    cmd = tesseract_cmd()
    if not cmd:
        return {"available": False, "detail": "Tesseract not found. Install it, "
                "or set INKWISE_TESSERACT to the path of tesseract.exe."}
    try:
        out = subprocess.run([cmd, "--version"], capture_output=True, timeout=20,
                             creationflags=_NO_WINDOW)
        version = (out.stdout or out.stderr).decode("utf-8", "replace").splitlines()[0]
        langs = subprocess.run([cmd, "--list-langs"], capture_output=True,
                               timeout=20, creationflags=_NO_WINDOW)
        names = [l.strip() for l in langs.stdout.decode("utf-8", "replace").splitlines()[1:]
                 if l.strip()]
        return {"available": True, "path": cmd, "version": version, "languages": names}
    except Exception as e:  # pragma: no cover - environment specific
        return {"available": False, "detail": f"Tesseract failed to run: {e}"}


_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def ocr_image(im: Image.Image, lang: str = "eng") -> str:
    cmd = tesseract_cmd()
    if not cmd:
        raise ImportError_("This page needs OCR, but Tesseract was not found. "
                           "Set INKWISE_TESSERACT to the path of tesseract.exe.")
    im = ImageOps.exif_transpose(im).convert("L")
    # Tesseract is tuned for roughly 300 dpi text; small images read badly
    if im.width < 1700:
        s = 1700 / im.width
        im = im.resize((round(im.width * s), round(im.height * s)), Image.LANCZOS)
    im = ImageOps.autocontrast(im, cutoff=1)
    buf = io.BytesIO()
    im.save(buf, format="PNG")
    proc = subprocess.run([cmd, "stdin", "stdout", "-l", lang, "--psm", "3"],
                          input=buf.getvalue(), capture_output=True, timeout=180,
                          creationflags=_NO_WINDOW)
    if proc.returncode != 0:
        err = proc.stderr.decode("utf-8", "replace").strip()[:300]
        raise ImportError_(f"Tesseract failed: {err}")
    return proc.stdout.decode("utf-8", "replace")


# --- extraction --------------------------------------------------------------

def extract(filename: str, data: bytes) -> dict:
    """Return {text, pages, method, page_methods, truncated}."""
    ext = Path(filename or "").suffix.lower()
    if ext == ".pdf":
        return _extract_pdf(data)
    if ext in IMAGE_EXT:
        text = ocr_image(Image.open(io.BytesIO(data)))
        return {"text": text, "pages": 1, "method": "ocr",
                "page_methods": ["ocr"], "truncated": False}
    if ext == ".docx":
        return _extract_docx(data)
    if ext in TEXT_EXT or not ext:
        return {"text": data.decode("utf-8", "replace"), "pages": 1,
                "method": "text", "page_methods": ["text"], "truncated": False}
    raise ImportError_(f"Unsupported file type '{ext}'. Use PDF, DOCX, TXT or an image.")


def _extract_pdf(data: bytes) -> dict:
    import pypdf
    import pypdfium2 as pdfium

    try:
        reader = pypdf.PdfReader(io.BytesIO(data))
    except Exception as e:
        raise ImportError_(f"Could not read this PDF: {e}")
    total = len(reader.pages)
    n = min(total, MAX_PAGES)
    texts, methods = [], []
    rendered = None
    for i in range(n):
        try:
            t = reader.pages[i].extract_text() or ""
        except Exception:
            t = ""
        if len(t.strip()) >= MIN_PAGE_TEXT:
            texts.append(t)
            methods.append("text")
            continue
        # no usable text layer: a scanned page
        if rendered is None:
            rendered = pdfium.PdfDocument(data)
        bitmap = rendered[i].render(scale=OCR_DPI / 72)
        texts.append(ocr_image(bitmap.to_pil()))
        methods.append("ocr")
    kinds = set(methods)
    method = kinds.pop() if len(kinds) == 1 else "mixed"
    return {"text": "\n\n".join(texts), "pages": n, "method": method,
            "page_methods": methods, "truncated": total > n, "total_pages": total}


def _extract_docx(data: bytes) -> dict:
    import docx
    d = docx.Document(io.BytesIO(data))
    lines = [p.text for p in d.paragraphs]
    for table in d.tables:
        for row in table.rows:
            lines.append("  ".join(c.text for c in row.cells))
    return {"text": "\n".join(lines), "pages": 1, "method": "text",
            "page_methods": ["text"], "truncated": False}


# --- parsing -----------------------------------------------------------------

MODULE_RE = re.compile(
    r"^\s*(module|unit|chapter|part|section|topic)\s*[-:.#]?\s*"
    r"(\d{1,2}|[ivxlc]{1,6})\b[\s:.\-\u2013\u2014)]*(.*)$", re.I)

# Q1. / Q.1 / Question 1: / 1. / 1)  - a top-level question
TOP_Q_RE = re.compile(
    r"^\s*(?:Q(?:uestion)?\s*\.?\s*(\d{1,3})\s*[.):\-]?|(\d{1,3})\s*[.)])\s+(.*)$",
    re.I)
# (a) / a) / (ii) / ii)  - a sub-part
SUB_Q_RE = re.compile(r"^\s*\(?([a-h]|i{1,3}|iv|vi{0,3}|ix|x)\)\s+(.*)$", re.I)

MARKS_RE = re.compile(
    r"\s*[\[(]\s*(\d{1,2})\s*(?:m|mks?|marks?)?\s*[\])]\s*$|\s+(\d{1,2})\s*marks?\s*$",
    re.I)

NOISE_RE = re.compile(
    r"^\s*(page\s*\d+(\s*of\s*\d+)?|\d{1,3}|[-_=*.\u2022]{3,})\s*$", re.I)

# a stem like "Q2. Attempt any two of the following" is an instruction, not a question
INSTRUCTION_RE = re.compile(
    r"(attempt|answer|solve|write)\s+(any|all|the following)|following\s*:?\s*$|"
    r"compulsory|each carr(y|ies)|instructions?", re.I)

QUESTION_HINT_RE = re.compile(
    r"\?\s*$|^\s*(explain|define|derive|prove|find|solve|evaluate|what|why|how|"
    r"describe|compare|differentiate|distinguish|state|calculate|determine|show|"
    r"list|write|discuss|draw|obtain|discuss|illustrate|justify|compute)\b", re.I)


def _clean_lines(text: str) -> list[str]:
    out = []
    for raw in text.replace("\r", "\n").split("\n"):
        line = re.sub(r"[ \t\u00a0]+", " ", raw).strip()
        if not line or NOISE_RE.match(line):
            out.append("")
            continue
        out.append(line)
    return out


def _split_marks(text: str) -> tuple[str, str | None]:
    m = MARKS_RE.search(text)
    if not m:
        return text.strip(), None
    return text[:m.start()].strip(), (m.group(1) or m.group(2))


def guess_kind(text: str) -> str:
    lines = [l for l in _clean_lines(text) if l]
    if not lines:
        return "notes"
    q_prefixed = sum(1 for l in lines if re.match(r"^\s*Q(uestion)?\s*\.?\s*\d", l, re.I))
    # judge the wording after any leading number: "Q1. Find ..." starts with Find
    bodies = [re.sub(r"^\s*(Q(uestion)?\s*\.?\s*)?\(?\w{1,4}[.)]\s*", "", l, flags=re.I)
              for l in lines]
    questiony = sum(1 for b in bodies if QUESTION_HINT_RE.search(b))
    modules = sum(1 for l in lines if MODULE_RE.match(l))
    if q_prefixed >= 2 or questiony >= max(3, len(lines) * 0.2):
        return "questions"
    return "syllabus" if modules else "notes"


def parse(text: str, kind: str = "auto", default_module: str = "Imported") -> dict:
    """Split extracted text into modules, questions and reference notes.

    Returns {"kind", "modules": [{"name", "questions": [{"text","marks"}],
    "notes"}]}. The result is a proposal: the student reviews and edits it
    before anything is saved.
    """
    if kind == "auto":
        kind = guess_kind(text)
    lines = _clean_lines(text)

    modules: list[dict] = []
    cur = {"name": default_module, "questions": [], "notes": []}
    modules.append(cur)

    stem = None            # current top-level question text, if any
    stem_has_subs = False
    q = None               # question currently being extended

    def close_stem():
        nonlocal stem, stem_has_subs
        # a top-level question with no sub-parts is a question in its own right
        if stem is not None and not stem_has_subs and stem["text"]:
            cur["questions"].append(stem)
        stem, stem_has_subs = None, False

    for i, line in enumerate(lines):
        if not line:
            q = None if kind != "questions" else q
            continue

        m = MODULE_RE.match(line)
        if m:
            if kind == "questions":
                close_stem()
            title = m.group(3).strip(" :-.")
            if not title:
                # "Module 3" on its own line: the title is usually the next line
                nxt = next((l for l in lines[i + 1:i + 3] if l), "")
                if nxt and not TOP_Q_RE.match(nxt) and not SUB_Q_RE.match(nxt):
                    title = nxt
            label = f"{m.group(1).title()} {m.group(2).upper()}"
            name = f"{label}: {title}" if title else label
            # drop the placeholder module if nothing landed in it
            if cur["name"] == default_module and not cur["questions"] and not cur["notes"]:
                modules.pop()
            cur = {"name": name[:120], "questions": [], "notes": []}
            modules.append(cur)
            q = None
            continue

        if kind != "questions":
            if not (cur["notes"] and cur["notes"][-1] == line):
                cur["notes"].append(line)
            continue

        top = TOP_Q_RE.match(line)
        sub = SUB_Q_RE.match(line)
        if top:
            close_stem()
            body, marks = _split_marks(top.group(3))
            stem = {"text": body, "marks": marks}
            q = stem
            continue
        if sub and (stem is not None or cur["questions"]):
            body, marks = _split_marks(sub.group(2))
            context = ""
            if stem is not None:
                stem_has_subs = True
                if stem["text"] and not INSTRUCTION_RE.search(stem["text"]):
                    context = stem["text"].rstrip(":") + "\n"
            q = {"text": f"{context}({sub.group(1).lower()}) {body}".strip(),
                 "marks": marks}
            cur["questions"].append(q)
            continue
        if q is not None:
            # a continuation line of the current question
            body, marks = _split_marks(line)
            q["text"] = f"{q['text']} {body}".strip()
            q["marks"] = q["marks"] or marks
            continue
        cur["notes"].append(line)

    if kind == "questions":
        close_stem()

    out = []
    for mod in modules:
        qs = [x for x in mod["questions"] if len(x["text"]) >= 4]
        notes = "\n".join(mod["notes"]).strip()
        if qs or notes:
            out.append({"name": mod["name"], "questions": qs, "notes": notes})

    # Text before the first real module heading is usually a title block
    # ("University of ...  Question Bank"), not a module. Drop the placeholder
    # unless it is the only module or actually holds questions or substance.
    if (len(out) > 1 and out[0]["name"] == default_module
            and not out[0]["questions"] and len(out[0]["notes"]) < 300):
        out.pop(0)
    return {"kind": kind, "modules": out}


# --- chunking for retrieval --------------------------------------------------

def chunk(text: str, size: int = 700, overlap: int = 120) -> list[str]:
    """Split on paragraph boundaries into overlapping, retrieval-sized pieces."""
    paras = [p.strip() for p in re.split(r"\n\s*\n|\n(?=[A-Z0-9(])", text) if p.strip()]
    chunks, cur = [], ""
    for p in paras:
        if len(cur) + len(p) + 1 <= size:
            cur = f"{cur}\n{p}" if cur else p
            continue
        if cur:
            chunks.append(cur)
            cur = cur[-overlap:] + "\n" + p if overlap else p
        else:
            cur = p
        while len(cur) > size * 1.5:          # one enormous paragraph
            chunks.append(cur[:size])
            cur = cur[size - overlap:]
    if cur.strip():
        chunks.append(cur)
    return chunks
