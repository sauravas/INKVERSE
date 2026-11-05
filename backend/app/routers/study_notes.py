"""Prepared study notes per module, and what the student does to them.

Notes are written by the tutor from the module's own imported material and
questions, as the same structured steps answers use (so diagrams and tables
come through), and stored. Highlights, pen ink and questions asked about a
passage are stored as marks on the notes.
"""
from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .. import agents, db, obs
from .ai import SSE_HEADERS, _consent_step, _label, _resolve, _stream_events

router = APIRouter(prefix="/api/study-notes", tags=["study-notes"])


def _loads(s, default):
    try:
        return json.loads(s) if s else default
    except (TypeError, ValueError):
        return default


def _material(module_id: str) -> tuple[str, list[str]]:
    """The module's imported reference text, in import order, de-duplicated."""
    rows = db.rows("SELECT text, heading FROM chunks WHERE module_id = ? "
                   "ORDER BY rowid", (module_id,))
    seen, parts, headings = set(), [], []
    for r in rows:
        key = r["text"][:80]
        if key in seen:
            continue
        seen.add(key)
        parts.append(r["text"])
        if r["heading"] and r["heading"] not in headings:
            headings.append(r["heading"])
    return "\n\n".join(parts), headings


@router.get("/modules")
async def modules():
    subs = db.rows("SELECT id, name, origin FROM subjects ORDER BY created_at")
    for s in subs:
        s["modules"] = db.rows(
            "SELECT m.id, m.name, n.id AS note_id, n.updated_at AS prepared_at, "
            "(SELECT COUNT(*) FROM questions q WHERE q.module_id = m.id) AS questions, "
            "(SELECT COUNT(*) FROM chunks c WHERE c.module_id = m.id) AS passages "
            "FROM modules m LEFT JOIN study_notes n ON n.module_id = m.id "
            "WHERE m.subject_id = ? ORDER BY m.position, m.created_at", (s["id"],))
    return [s for s in subs if s["modules"]]


@router.get("/{module_id}")
async def get_notes(module_id: str):
    m = db.one("SELECT m.*, s.name AS subject_name FROM modules m "
               "JOIN subjects s ON s.id = m.subject_id WHERE m.id = ?", (module_id,))
    if not m:
        raise HTTPException(404, "No such module")
    note = db.one("SELECT * FROM study_notes WHERE module_id = ?", (module_id,))
    marks = []
    if note:
        note["steps"] = _loads(note.pop("steps_json"), [])
        marks = db.rows("SELECT * FROM note_marks WHERE note_id = ? ORDER BY created_at",
                        (note["id"],))
        for k in marks:
            k["data"] = _loads(k["data"], None)
    material, headings = _material(module_id)
    return {"module": {"id": m["id"], "name": m["name"]},
            "subject": {"id": m["subject_id"], "name": m["subject_name"]},
            "note": note, "marks": marks,
            "imported": {"text": material, "headings": headings}}


class PrepareIn(BaseModel):
    provider: str | None = None
    consent_cloud: bool = False


@router.post("/{module_id}/prepare")
async def prepare(module_id: str, body: PrepareIn):
    """Write the module's notes, streamed as typed events, and keep them."""
    m = db.one("SELECT m.*, s.name AS subject_name FROM modules m "
               "JOIN subjects s ON s.id = m.subject_id WHERE m.id = ?", (module_id,))
    if not m:
        raise HTTPException(404, "No such module")
    p = _resolve(body.provider, body.consent_cloud)
    material, headings = _material(module_id)
    questions = [r["text"] for r in db.rows(
        "SELECT text FROM questions WHERE module_id = ? ORDER BY position", (module_id,))]

    def persist(_text: str, steps: list[dict]):
        if not steps:
            return
        t = db.now()
        obs.emit("step", f"Notes saved ({len(steps)} sections)", step="save")
        db.run("INSERT INTO study_notes (id, subject_id, module_id, title, steps_json, "
               "created_at, updated_at) VALUES (?,?,?,?,?,?,?) "
               "ON CONFLICT(module_id) DO UPDATE SET steps_json = excluded.steps_json, "
               "title = excluded.title, updated_at = excluded.updated_at",
               (db.nid(), m["subject_id"], module_id, m["name"], json.dumps(steps), t, t))

    sources = [{"heading": h, "snippet": "imported material"} for h in headings[:6]]

    async def gen():
        with obs.trace("notes", f"Prepare notes for {m['name']}",
                       provider=_label(p)) as run:
            _consent_step(p)
            obs.emit("step",
                     f"{len(headings)} heading(s), {len(questions)} question(s) "
                     f"from imported material", step="material",
                     passages=len(sources))
            obs.emit("route", "Routing module material to the Notes Agent",
                     to="notewriter")
            async for chunk in _stream_events(
                    agents.notewriter(p, m["subject_name"], m["name"], material,
                                      questions),
                    run=run, on_done=persist, sources=sources):
                yield chunk

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers=SSE_HEADERS)


class MarkIn(BaseModel):
    section_index: int
    kind: str
    quote: str | None = None
    ask: str | None = None
    data: object | None = None


@router.post("/notes/{note_id}/marks")
async def add_mark(note_id: str, body: MarkIn):
    if body.kind not in ("highlight", "ink", "question"):
        raise HTTPException(400, "kind must be highlight, ink or question")
    if not db.one("SELECT 1 FROM study_notes WHERE id = ?", (note_id,)):
        raise HTTPException(404, "No such notes")
    mid = db.nid()
    db.run("INSERT INTO note_marks (id, note_id, section_index, kind, quote, ask, data, "
           "created_at) VALUES (?,?,?,?,?,?,?,?)",
           (mid, note_id, body.section_index, body.kind, (body.quote or "")[:2000],
            (body.ask or "")[:2000], json.dumps(body.data) if body.data is not None else None,
            db.now()))
    return {"id": mid}


class MarkPatch(BaseModel):
    data: object | None = None


@router.patch("/marks/{mark_id}")
async def update_mark(mark_id: str, body: MarkPatch):
    db.run("UPDATE note_marks SET data = ? WHERE id = ?",
           (json.dumps(body.data) if body.data is not None else None, mark_id))
    return {"ok": True}


@router.delete("/marks/{mark_id}")
async def delete_mark(mark_id: str):
    db.run("DELETE FROM note_marks WHERE id = ?", (mark_id,))
    return {"ok": True}

