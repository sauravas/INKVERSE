"""Importing question banks, syllabi and notes.

Two steps on purpose: /extract proposes a structure, the student corrects it,
and only /commit writes anything. OCR and parsing are never trusted blindly.
"""
from __future__ import annotations

import asyncio

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from .. import db, ingest, retrieval

router = APIRouter(prefix="/api/import", tags=["import"])

MAX_BYTES = 40 * 1024 * 1024


class QuestionDraft(BaseModel):
    text: str
    marks: str | None = None
    important: bool = False


class ModuleDraft(BaseModel):
    name: str
    module_id: str | None = None      # attach to an existing module instead
    questions: list[QuestionDraft] = []
    notes: str = ""


class CommitIn(BaseModel):
    subject_id: str | None = None
    subject_name: str | None = None
    filename: str = ""
    kind: str = "questions"
    method: str = "text"
    pages: int = 1
    text: str = ""
    modules: list[ModuleDraft]


@router.get("/status")
async def status():
    return {"ocr": await asyncio.to_thread(ingest.ocr_status),
            "max_pages": ingest.MAX_PAGES,
            "accepts": [".pdf", ".docx", ".txt", ".md", *sorted(ingest.IMAGE_EXT)]}


@router.post("/extract")
async def extract(file: UploadFile = File(...), kind: str = Form("auto")):
    data = await file.read()
    if not data:
        raise HTTPException(400, "The file is empty.")
    if len(data) > MAX_BYTES:
        raise HTTPException(413, "File is larger than 40 MB.")
    try:
        # OCR is CPU-bound and slow: keep it off the event loop so handwriting
        # sync and every other request stay live while a scan is being read
        res = await asyncio.to_thread(ingest.extract, file.filename or "", data)
        parsed = await asyncio.to_thread(
            ingest.parse, res["text"], kind,
            (file.filename or "Imported").rsplit(".", 1)[0][:60] or "Imported")
    except ingest.ImportError_ as e:
        raise HTTPException(422, str(e))
    qcount = sum(len(m["questions"]) for m in parsed["modules"])
    return {
        "filename": file.filename, **res, **parsed,
        "summary": {"modules": len(parsed["modules"]), "questions": qcount,
                    "chars": len(res["text"])},
    }


@router.post("/commit")
async def commit(body: CommitIn):
    if not body.modules:
        raise HTTPException(400, "Nothing to import.")

    sid = body.subject_id
    if sid:
        if not db.one("SELECT 1 FROM subjects WHERE id=?", (sid,)):
            raise HTTPException(404, "No such subject")
    else:
        name = (body.subject_name or "").strip() or (
            body.filename.rsplit(".", 1)[0] if body.filename else "Imported subject")
        existing = db.one("SELECT id FROM subjects WHERE lower(name)=lower(?)", (name,))
        if existing:
            sid = existing["id"]
        else:
            sid = db.nid()
            db.run("INSERT INTO subjects (id,name,created_at) VALUES (?,?,?)",
                   (sid, name[:120], db.now()))

    # the exact same document imported again: reuse it rather than indexing
    # its passages twice, which would make retrieval return duplicates
    dup = db.one("SELECT id FROM sources WHERE subject_id=? AND kind=? AND text=?",
                 (sid, body.kind, body.text)) if body.text.strip() else None
    reindex = dup is None

    src = dup["id"] if dup else db.nid()
    if reindex:
        db.run("INSERT INTO sources (id,subject_id,filename,kind,method,pages,text,"
               "created_at) VALUES (?,?,?,?,?,?,?,?)",
               (src, sid, body.filename, body.kind, body.method, body.pages,
                body.text, db.now()))

    created_modules = created_questions = chunks = 0
    positions = db.one("SELECT COALESCE(MAX(position), -1) p FROM modules "
                       "WHERE subject_id=?", (sid,))["p"]
    for draft in body.modules:
        mid = draft.module_id
        if mid and not db.one("SELECT 1 FROM modules WHERE id=? AND subject_id=?",
                              (mid, sid)):
            mid = None
        if not mid:
            # re-importing the same paper must not duplicate its modules
            same = db.one("SELECT id FROM modules WHERE subject_id=? AND lower(name)=lower(?)",
                          (sid, draft.name.strip()))
            if same:
                mid = same["id"]
            else:
                positions += 1
                mid = db.nid()
                db.run("INSERT INTO modules (id,subject_id,name,position,created_at) "
                       "VALUES (?,?,?,?,?)",
                       (mid, sid, draft.name.strip()[:120] or "Module", positions, db.now()))
                created_modules += 1

        start = db.one("SELECT COALESCE(MAX(position), -1) p FROM questions "
                       "WHERE module_id=?", (mid,))["p"]
        have = {r["t"] for r in db.rows(
            "SELECT lower(trim(text)) t FROM questions WHERE module_id=?", (mid,))}
        for i, q in enumerate(draft.questions):
            text = q.text.strip()
            if not text or text.lower() in have:
                continue
            have.add(text.lower())
            t = db.now()
            db.run("INSERT INTO questions (id,module_id,subject_id,text,important,"
                   "status,source_id,position,marks,created_at,updated_at) "
                   "VALUES (?,?,?,?,?,'pending',?,?,?,?,?)",
                   (db.nid(), mid, sid, text, int(q.important), src,
                    start + 1 + i, q.marks, t, t))
            created_questions += 1

        # index notes and the questions themselves, so answers can cite them
        material = draft.notes.strip()
        if draft.questions:
            material += "\n\n" + "\n".join(q.text for q in draft.questions)
        if reindex and material.strip():
            chunks += retrieval.index(src, sid, mid, draft.name, material)

    return {"subject_id": sid, "source_id": src, "modules_created": created_modules,
            "questions_created": created_questions, "chunks_indexed": chunks}


@router.get("/sources")
async def sources(subject_id: str | None = None):
    sql = ("SELECT s.id, s.subject_id, s.filename, s.kind, s.method, s.pages, "
           "s.created_at, length(s.text) chars, "
           "(SELECT COUNT(*) FROM questions q WHERE q.source_id = s.id) questions "
           "FROM sources s")
    if subject_id:
        return db.rows(sql + " WHERE s.subject_id=? ORDER BY s.created_at DESC",
                       (subject_id,))
    return db.rows(sql + " ORDER BY s.created_at DESC")


@router.delete("/sources/{source_id}")
async def delete_source(source_id: str, with_questions: bool = False):
    """Remove an import. Questions stay unless asked, because the student may
    have attempts and notes attached to them."""
    retrieval.drop_source(source_id)
    if with_questions:
        db.run("DELETE FROM questions WHERE source_id=?", (source_id,))
    else:
        db.run("UPDATE questions SET source_id=NULL WHERE source_id=?", (source_id,))
    db.run("DELETE FROM sources WHERE id=?", (source_id,))
    return {"ok": True}


@router.get("/search")
async def search(q: str, subject_id: str | None = None, module_id: str | None = None):
    """Debug/inspection view of what retrieval would hand the model."""
    block, used = retrieval.context_for(q, subject_id=subject_id, module_id=module_id)
    return {"sources": used, "chars": len(block)}
