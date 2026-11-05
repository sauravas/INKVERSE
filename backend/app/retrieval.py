"""Grounding answers in the student's own imported material.

BM25 over SQLite FTS5 rather than embeddings: it needs no extra model, so it
never competes with the vision and text models for this machine's shared GPU
memory, and its matches are explainable (the same words appear in both).
"""
from __future__ import annotations

import re

from . import db, ingest

STOPWORDS = set("""
a an and are as at be by for from has have how if in into is it its of on or
that the their then there these this to was were what when where which who why
will with you your find show prove explain define state write give obtain using
derive evaluate determine calculate compute discuss describe hence also given
following question marks answer solve
""".split())

MAX_CONTEXT_CHARS = 2600


def index(source_id: str, subject_id: str | None, module_id: str | None,
          heading: str, text: str) -> int:
    n = 0
    c = db.conn()
    for piece in ingest.chunk(text):
        c.execute("INSERT INTO chunks (text, heading, source_id, subject_id, module_id) "
                  "VALUES (?,?,?,?,?)",
                  (piece, heading or "", source_id, subject_id or "", module_id or ""))
        n += 1
    c.commit()
    return n


def drop_source(source_id: str) -> None:
    db.run("DELETE FROM chunks WHERE source_id = ?", (source_id,))


def _fts_query(text: str) -> str:
    words = []
    for w in re.findall(r"[A-Za-z][A-Za-z0-9]{2,}", text.lower()):
        if w not in STOPWORDS and w not in words:
            words.append(w)
    # quoted terms cannot be misread as FTS5 operators
    return " OR ".join(f'"{w}"' for w in words[:24])


def search(query: str, subject_id: str | None = None, module_id: str | None = None,
           k: int = 4) -> list[dict]:
    q = _fts_query(query)
    if not q:
        return []

    def run(where: str, args: tuple, limit: int) -> list[dict]:
        sql = ("SELECT text, heading, source_id, module_id, bm25(chunks) AS score "
               f"FROM chunks WHERE chunks MATCH ? {where} ORDER BY score LIMIT ?")
        try:
            return db.rows(sql, (q, *args, limit))
        except Exception:
            return []

    hits: list[dict] = []
    if module_id:
        hits = run("AND module_id = ?", (module_id,), k)
    if len(hits) < k and subject_id:
        seen = {h["text"] for h in hits}
        hits += [h for h in run("AND subject_id = ?", (subject_id,), k * 2)
                 if h["text"] not in seen][:k - len(hits)]
    return hits


def context_for(question: str, question_id: str | None = None,
                subject_id: str | None = None,
                module_id: str | None = None) -> tuple[str, list[dict]]:
    """Return (prompt block, sources) for a question, or ("", []) if nothing fits."""
    if question_id:
        row = db.one("SELECT subject_id, module_id FROM questions WHERE id = ?",
                     (question_id,))
        if row:
            subject_id = subject_id or row["subject_id"]
            module_id = module_id or row["module_id"]
    if not (subject_id or module_id):
        return "", []

    hits = search(question, subject_id, module_id)
    # the question itself is often indexed too; it is not useful as evidence
    norm = re.sub(r"\W+", "", question.lower())
    hits = [h for h in hits if re.sub(r"\W+", "", h["text"].lower()) != norm]
    if not hits:
        return "", []

    parts, used, total = [], [], 0
    for h in hits:
        body = h["text"].strip()
        if total + len(body) > MAX_CONTEXT_CHARS:
            body = body[:max(0, MAX_CONTEXT_CHARS - total)]
        if not body:
            break
        parts.append(f"[{h['heading'] or 'notes'}]\n{body}")
        used.append({"heading": h["heading"], "snippet": body[:180],
                     "source_id": h["source_id"]})
        total += len(body)
    block = ("Reference material from the student's own syllabus and notes. Use it "
             "where it is relevant, keep to its notation and scope, and do not "
             "invent facts beyond it:\n\n" + "\n\n".join(parts))
    return block, used
