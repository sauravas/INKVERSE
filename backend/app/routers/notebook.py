"""Notebook page persistence.

Live stroke sync happens over the WebSocket hub; this router is for saving a
workspace to SQLite and loading it back.
"""
from __future__ import annotations

import json

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from .. import db
from ..ws import hub

router = APIRouter(prefix="/api/notebook", tags=["notebook"])


class SaveIn(BaseModel):
    room: str


@router.get("/pages")
async def list_pages():
    return db.rows("SELECT id,title,position,updated_at FROM pages "
                   "ORDER BY position, updated_at")


@router.get("/pages/{pid}")
async def get_page(pid: str):
    p = db.one("SELECT * FROM pages WHERE id=?", (pid,))
    if not p:
        raise HTTPException(404, "No such page")
    p["strokes"] = json.loads(p["strokes"])
    return p


@router.post("/save")
async def save_room(body: SaveIn):
    """Persist every page of a live workspace."""
    r = hub.rooms.get(body.room)
    if not r:
        raise HTTPException(404, "No such workspace")
    saved = []
    for i, page in enumerate(r.pages):
        db.run(
            "INSERT INTO pages (id,title,position,strokes,updated_at) "
            "VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET "
            "title=excluded.title, position=excluded.position, "
            "strokes=excluded.strokes, updated_at=excluded.updated_at",
            (page["id"], page.get("title") or f"Page {i + 1}", i,
             json.dumps(page["strokes"]), db.now()))
        saved.append(page["id"])
    return {"saved": saved, "count": len(saved)}


@router.post("/load/{pid}")
async def load_page(pid: str, room: str):
    """Load a saved page into a live workspace as a new page."""
    p = db.one("SELECT * FROM pages WHERE id=?", (pid,))
    if not p:
        raise HTTPException(404, "No such page")
    r = hub.room(room)
    page = {"id": p["id"], "title": p["title"], "strokes": json.loads(p["strokes"])}
    existing = next((i for i, x in enumerate(r.pages) if x["id"] == page["id"]), None)
    if existing is None:
        r.pages.append(page)
        r.active = len(r.pages) - 1
    else:
        r.pages[existing] = page
        r.active = existing
    await hub.broadcast(room, {"t": "pages", "snapshot": r.snapshot()})
    return {"ok": True, "active": r.active}


@router.delete("/pages/{pid}")
async def delete_page(pid: str):
    db.run("DELETE FROM pages WHERE id=?", (pid,))
    return {"ok": True}
