"""Shared-workspace stroke sync.

The server holds authoritative page state so laptop and phone are literally the
same notebook: a late-joining phone receives the full snapshot. Nothing here
touches model code (constraint 1) - stroke relay stays live while inference runs.
"""
from __future__ import annotations

import asyncio
import time
import uuid
from collections import defaultdict
from dataclasses import dataclass, field

from fastapi import WebSocket


def _page(title="Page 1"):
    return {"id": uuid.uuid4().hex[:8], "title": title, "strokes": []}


@dataclass
class Client:
    id: str
    ws: WebSocket
    role: str = "laptop"
    name: str = ""


@dataclass
class Room:
    id: str
    pages: list = field(default_factory=lambda: [_page()])
    active: int = 0
    clients: dict = field(default_factory=dict)
    undo: dict = field(default_factory=lambda: defaultdict(list))
    redo: dict = field(default_factory=lambda: defaultdict(list))
    created_at: float = field(default_factory=time.time)
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    def page_by_id(self, pid):
        return next((p for p in self.pages if p["id"] == pid), None)

    def snapshot(self):
        return {"pages": self.pages, "active": self.active}

    def peers(self):
        return [{"id": c.id, "role": c.role, "name": c.name}
                for c in self.clients.values()]


class Hub:
    def __init__(self):
        self.rooms: dict[str, Room] = {}

    def room(self, rid: str) -> Room:
        if rid not in self.rooms:
            self.rooms[rid] = Room(id=rid)
        return self.rooms[rid]

    async def join(self, rid: str, ws: WebSocket, role: str, name: str = "") -> Client:
        r = self.room(rid)
        c = Client(id=uuid.uuid4().hex[:8], ws=ws, role=role, name=name)
        r.clients[c.id] = c
        await ws.send_json({"t": "welcome", "clientId": c.id, "room": rid,
                            "snapshot": r.snapshot(), "peers": r.peers()})
        await self.broadcast(rid, {"t": "peers", "peers": r.peers()})
        return c

    async def leave(self, rid: str, cid: str):
        r = self.rooms.get(rid)
        if not r:
            return
        r.clients.pop(cid, None)
        if r.clients:
            await self.broadcast(rid, {"t": "peers", "peers": r.peers()})
        # the room and its strokes stay alive so a client can reconnect

    async def announce(self, msg: dict):
        """Tell every connected client something that is not about one room.

        The library - subjects, modules, questions, notes - is shared by the
        whole app, not by a workspace, so an import has to reach the dashboard
        on another tab and the question bank on the phone, not just whoever
        happened to be in the room it was committed from.
        """
        for rid in list(self.rooms):
            await self.broadcast(rid, msg)

    async def broadcast(self, rid: str, msg: dict, skip: str | None = None):
        r = self.rooms.get(rid)
        if not r:
            return
        dead = []
        for cid, c in list(r.clients.items()):
            if cid == skip:
                continue
            try:
                await c.ws.send_json(msg)
            except Exception:
                dead.append(cid)
        for cid in dead:
            r.clients.pop(cid, None)

    # -- message handling --------------------------------------------------
    async def handle(self, rid: str, c: Client, m: dict):
        r = self.room(rid)
        t = m.get("t")

        if t == "ping":
            await c.ws.send_json({"t": "pong", "ts": m.get("ts")})
            return

        if t == "stroke_begin":
            async with r.lock:
                pid = m.get("pageId") or r.pages[r.active]["id"]
                page = r.page_by_id(pid)
                if page is None:
                    return
                stroke = {
                    "id": m["id"], "pageId": pid, "author": c.id, "role": c.role,
                    "tool": m.get("tool", "pen"), "color": m.get("color", "#16213a"),
                    "size": float(m.get("size", 2.4)), "pts": list(m.get("pts") or []),
                    "done": False,
                }
                page["strokes"].append(stroke)
            await self.broadcast(rid, {**m, "t": "stroke_begin", "pageId": pid,
                                       "author": c.id, "role": c.role}, skip=c.id)
            return

        if t == "stroke_points":
            async with r.lock:
                s = self._find(r, m["id"])
                if s is None:
                    return
                s["pts"].extend(m.get("pts") or [])
            await self.broadcast(rid, {**m, "t": "stroke_points", "author": c.id},
                                 skip=c.id)
            return

        if t == "stroke_end":
            async with r.lock:
                s = self._find(r, m["id"])
                if s is None:
                    return
                if m.get("pts"):
                    s["pts"].extend(m["pts"])
                s["done"] = True
                r.undo[c.id].append({"kind": "add", "strokeId": s["id"],
                                     "pageId": s["pageId"]})
                r.redo[c.id].clear()
            await self.broadcast(rid, {**m, "t": "stroke_end", "author": c.id},
                                 skip=c.id)
            return

        if t == "erase":
            # the eraser removes whole strokes by id, hit-tested on the client
            ids = set(m.get("ids") or [])
            async with r.lock:
                removed = []
                for p in r.pages:
                    keep = []
                    for s in p["strokes"]:
                        (removed if s["id"] in ids else keep).append(s)
                    p["strokes"] = keep
                if removed:
                    r.undo[c.id].append({"kind": "remove", "strokes": removed})
                    r.redo[c.id].clear()
            await self.broadcast(rid, {"t": "erase", "ids": list(ids),
                                       "author": c.id}, skip=c.id)
            return

        if t in ("undo", "redo"):
            await self._history(rid, r, c, t)
            return

        if t == "clear":
            async with r.lock:
                pid = m.get("pageId") or r.pages[r.active]["id"]
                page = r.page_by_id(pid)
                if page is None:
                    return
                if page["strokes"]:
                    r.undo[c.id].append({"kind": "remove",
                                         "strokes": list(page["strokes"])})
                    r.redo[c.id].clear()
                page["strokes"] = []
            await self.broadcast(rid, {"t": "clear", "pageId": pid, "author": c.id})
            return

        if t == "page_add":
            async with r.lock:
                r.pages.append(_page(f"Page {len(r.pages) + 1}"))
                r.active = len(r.pages) - 1
            await self.broadcast(rid, {"t": "pages", "snapshot": r.snapshot()})
            return

        if t == "page_open":
            # create-or-select a page with a known id, e.g. one per question in
            # the question bank, so every device lands on the same answer page
            pid = str(m.get("id") or "")[:64]
            if not pid:
                return
            async with r.lock:
                idx = next((i for i, p in enumerate(r.pages) if p["id"] == pid), None)
                if idx is None:
                    seed = m.get("strokes") or []
                    r.pages.append({"id": pid, "title": str(m.get("title") or pid)[:80],
                                    "strokes": [dict(s, pageId=pid) for s in seed]})
                    idx = len(r.pages) - 1
                r.active = idx
            await self.broadcast(rid, {"t": "pages", "snapshot": r.snapshot()})
            return

        if t == "page_select":
            async with r.lock:
                i = int(m.get("index", 0))
                if 0 <= i < len(r.pages):
                    r.active = i
            await self.broadcast(rid, {"t": "page_select", "index": r.active})
            return

        if t == "page_delete":
            async with r.lock:
                i = int(m.get("index", -1))
                if 0 <= i < len(r.pages) and len(r.pages) > 1:
                    r.pages.pop(i)
                    r.active = min(r.active, len(r.pages) - 1)
            await self.broadcast(rid, {"t": "pages", "snapshot": r.snapshot()})
            return

        if t == "snapshot_request":
            await c.ws.send_json({"t": "pages", "snapshot": r.snapshot()})
            return

        if t == "cursor":
            await self.broadcast(rid, {"t": "cursor", "author": c.id,
                                       "role": c.role, "x": m.get("x"),
                                       "y": m.get("y"), "down": m.get("down")},
                                 skip=c.id)
            return

    # -- helpers -----------------------------------------------------------
    @staticmethod
    def _find(r: Room, sid: str):
        for p in r.pages:
            for s in p["strokes"]:
                if s["id"] == sid:
                    return s
        return None

    async def _history(self, rid: str, r: Room, c: Client, which: str):
        """Per-author undo/redo: you only ever undo your own strokes."""
        src = r.undo[c.id] if which == "undo" else r.redo[c.id]
        dst = r.redo[c.id] if which == "undo" else r.undo[c.id]
        async with r.lock:
            if not src:
                return
            act = src.pop()
            if act["kind"] in ("add", "addmany"):
                strokes = act.get("strokes")
                if strokes is None:
                    s = self._find(r, act["strokeId"])
                    if s is None:
                        return
                    strokes = [s]
                ids = [s["id"] for s in strokes]
                for p in r.pages:
                    p["strokes"] = [x for x in p["strokes"] if x["id"] not in ids]
                dst.append({"kind": "remove", "strokes": strokes})
                out = {"t": "erase", "ids": ids, "author": c.id}
            else:
                strokes = act.get("strokes") or []
                for s in strokes:
                    page = r.page_by_id(s["pageId"])
                    if page is not None:
                        page["strokes"].append(s)
                dst.append({"kind": "addmany", "strokes": strokes})
                out = {"t": "restore", "strokes": strokes, "author": c.id}
        await self.broadcast(rid, out)


hub = Hub()
