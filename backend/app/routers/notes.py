"""Reference notes, and sharing them with friends.

Notes are assembled from what is already stored: the question, the student's
handwritten attempt, any hint, the worked answer and the step annotations.

Sharing stays local-first:
- a read-only link on the local network, with a QR code, revocable; and
- a portable bundle file a friend imports into their own INKWISE.
An imported bundle becomes a separate subject marked with its origin, and its
progress starts from zero, so a friend's record never counts as your own.
"""
from __future__ import annotations

import json
import secrets
import time

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel

from .. import config, db
from .pair import lan_ip, qr_svg

router = APIRouter(tags=["notes"])

BUNDLE_VERSION = 1


def _loads(s, default):
    try:
        return json.loads(s) if s else default
    except (TypeError, ValueError):
        return default


def _question_notes(q: dict) -> dict:
    a = db.one("SELECT image, hint_json, outcome, updated_at FROM attempts "
               "WHERE question_id=? ORDER BY updated_at DESC LIMIT 1", (q["id"],))
    ex = db.rows("SELECT step_index, step_text, ask, answer_json FROM explanations "
                 "WHERE question_id=? ORDER BY created_at", (q["id"],))
    return {
        "id": q["id"], "text": q["text"], "marks": q["marks"],
        "important": bool(q["important"]), "status": q["status"],
        "answer_steps": _loads(q["answer_json"], []),
        "attempt": None if not a else {
            "image": a["image"], "outcome": a["outcome"],
            "hint_steps": _loads(a["hint_json"], None),
            "updated_at": a["updated_at"]},
        "explanations": [{"step_index": e["step_index"], "step_text": e["step_text"],
                          "ask": e["ask"], "steps": _loads(e["answer_json"], [])}
                         for e in ex],
    }


def _module_notes(mid: str) -> dict:
    m = db.one("SELECT * FROM modules WHERE id=?", (mid,))
    if not m:
        raise HTTPException(404, "No such module")
    qs = db.rows("SELECT * FROM questions WHERE module_id=? "
                 "ORDER BY position, created_at", (mid,))
    return {"id": m["id"], "name": m["name"],
            "questions": [_question_notes(q) for q in qs]}


def _notes(subject_id: str | None, module_id: str | None) -> dict:
    if module_id:
        m = db.one("SELECT subject_id FROM modules WHERE id=?", (module_id,))
        if not m:
            raise HTTPException(404, "No such module")
        subject_id = m["subject_id"]
        mods = [_module_notes(module_id)]
    elif subject_id:
        mods = [_module_notes(r["id"]) for r in db.rows(
            "SELECT id FROM modules WHERE subject_id=? ORDER BY position, created_at",
            (subject_id,))]
    else:
        raise HTTPException(400, "Give a module_id or subject_id.")
    s = db.one("SELECT id, name, origin FROM subjects WHERE id=?", (subject_id,))
    if not s:
        raise HTTPException(404, "No such subject")
    return {"subject": s, "modules": mods,
            "counts": {"questions": sum(len(m["questions"]) for m in mods),
                       "attempted": sum(1 for m in mods for q in m["questions"]
                                        if q["attempt"]),
                       "answered": sum(1 for m in mods for q in m["questions"]
                                       if q["answer_steps"])}}


# --- notes -------------------------------------------------------------------

@router.get("/api/notes")
async def notes(subject_id: str | None = None, module_id: str | None = None):
    return _notes(subject_id, module_id)


# --- share links -------------------------------------------------------------

class ShareIn(BaseModel):
    subject_id: str | None = None
    module_id: str | None = None
    title: str | None = None


def _share_url(token: str) -> str:
    return f"http://{lan_ip()}:{config.PUBLIC_PORT}/notes/{token}"


@router.post("/api/share")
async def create_share(body: ShareIn):
    data = _notes(body.subject_id, body.module_id)    # validates the target
    title = body.title or (data["modules"][0]["name"] if body.module_id
                           else data["subject"]["name"])
    token = secrets.token_urlsafe(12)
    db.run("INSERT INTO shares (token, subject_id, module_id, title, created_at) "
           "VALUES (?,?,?,?,?)",
           (token, data["subject"]["id"], body.module_id, title, db.now()))
    url = _share_url(token)
    return {"token": token, "url": url, "title": title, "svg": qr_svg(url)}


@router.get("/api/shares")
async def list_shares():
    rows = db.rows("SELECT * FROM shares WHERE revoked=0 ORDER BY created_at DESC")
    for r in rows:
        r["url"] = _share_url(r["token"])
    return rows


@router.get("/api/share/{token}")
async def open_share(token: str):
    s = db.one("SELECT * FROM shares WHERE token=?", (token,))
    if not s or s["revoked"]:
        raise HTTPException(404, "This share link does not exist or was turned off.")
    data = _notes(s["subject_id"], s["module_id"])
    data["share"] = {"title": s["title"], "created_at": s["created_at"]}
    return data


@router.get("/api/share/{token}/bundle")
async def share_bundle(token: str):
    """Let a friend viewing a share link save the notes into their own INKWISE."""
    s = db.one("SELECT * FROM shares WHERE token=?", (token,))
    if not s or s["revoked"]:
        raise HTTPException(404, "This share link does not exist or was turned off.")
    return await export(subject_id=s["subject_id"], module_id=s["module_id"])


@router.delete("/api/share/{token}")
async def revoke_share(token: str):
    db.run("UPDATE shares SET revoked=1 WHERE token=?", (token,))
    return {"ok": True}


# --- portable bundles --------------------------------------------------------

@router.get("/api/notes/export")
async def export(subject_id: str | None = None, module_id: str | None = None,
                 shared_by: str = ""):
    data = _notes(subject_id, module_id)
    bundle = {
        "inkwise_bundle": BUNDLE_VERSION,
        "exported_at": time.time(),
        "shared_by": shared_by.strip()[:60],
        "subject": {"name": data["subject"]["name"]},
        "modules": [{
            "name": m["name"],
            "questions": [{k: q[k] for k in ("text", "marks", "important",
                                              "answer_steps", "attempt",
                                              "explanations")}
                          for q in m["questions"]],
        } for m in data["modules"]],
    }
    slug = "".join(ch if ch.isalnum() else "-" for ch in
                   (data["modules"][0]["name"] if module_id
                    else data["subject"]["name"]))[:50].strip("-") or "notes"
    return Response(
        json.dumps(bundle, ensure_ascii=False),
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{slug}.inkwise.json"'})


class BundleIn(BaseModel):
    bundle: dict
    shared_by: str | None = None


@router.post("/api/notes/import")
async def import_bundle(body: BundleIn):
    b = body.bundle
    if b.get("inkwise_bundle") != BUNDLE_VERSION or "modules" not in b:
        raise HTTPException(400, "This is not an INKWISE notes file.")
    who = (body.shared_by or b.get("shared_by") or "a friend").strip()[:60]
    base = (b.get("subject") or {}).get("name") or "Shared notes"
    sid = db.nid()
    db.run("INSERT INTO subjects (id,name,origin,created_at) VALUES (?,?,?,?)",
           (sid, f"{base} (from {who})"[:120], f"Shared by {who}", db.now()))

    n_mod = n_q = 0
    for mi, m in enumerate(b["modules"]):
        mid = db.nid()
        db.run("INSERT INTO modules (id,subject_id,name,position,created_at) "
               "VALUES (?,?,?,?,?)",
               (mid, sid, str(m.get("name") or "Module")[:120], mi, db.now()))
        n_mod += 1
        for qi, q in enumerate(m.get("questions") or []):
            text = str(q.get("text") or "").strip()
            if not text:
                continue
            qid, t = db.nid(), db.now()
            steps = q.get("answer_steps") or []
            # progress always starts fresh: their record is not your recall
            db.run("INSERT INTO questions (id,module_id,subject_id,text,marks,important,"
                   "status,answer_json,position,created_at,updated_at) "
                   "VALUES (?,?,?,?,?,?,'pending',?,?,?,?)",
                   (qid, mid, sid, text, q.get("marks"), int(bool(q.get("important"))),
                    json.dumps(steps) if steps else None, qi, t, t))
            a = q.get("attempt") or {}
            if a.get("image") or a.get("hint_steps"):
                db.run("INSERT INTO attempts (id,question_id,image,hint_json,outcome,"
                       "created_at,updated_at) VALUES (?,?,?,?,?,?,?)",
                       (db.nid(), qid, a.get("image"),
                        json.dumps(a["hint_steps"]) if a.get("hint_steps") else None,
                        a.get("outcome"), t, t))
            for e in q.get("explanations") or []:
                db.run("INSERT INTO explanations (id,question_id,step_index,step_text,"
                       "ask,answer_json,created_at) VALUES (?,?,?,?,?,?,?)",
                       (db.nid(), qid, e.get("step_index"), e.get("step_text"),
                        str(e.get("ask") or ""), json.dumps(e.get("steps") or []), t))
            n_q += 1
    return {"subject_id": sid, "modules": n_mod, "questions": n_q,
            "origin": f"Shared by {who}"}
