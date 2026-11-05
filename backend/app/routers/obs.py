"""Observability endpoints: agent topology, recent events, and a live stream."""
from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from .. import agents, obs
from ..ai import registry

router = APIRouter(prefix="/api/obs", tags=["observability"])


@router.get("/agents")
async def topology(provider: str | None = None):
    """How many agents exist, how they connect, and which models back them."""
    out = agents.topology(registry.get(provider))
    out["stats"] = obs.stats()
    return out


@router.get("/recent")
async def recent(n: int = 200):
    return {"events": obs.recent(max(1, min(n, obs.BUFFER_SIZE)))}


@router.get("/stream")
async def stream(request: Request, replay: int = 150):
    """Server-sent events: the last `replay` events, then everything live."""
    q = obs.subscribe()            # subscribe first so nothing falls in a gap
    backlog = obs.recent(max(0, min(replay, obs.BUFFER_SIZE)))
    last = backlog[-1]["seq"] if backlog else 0

    def frame(ev: dict) -> str:
        return f"data: {json.dumps(ev, ensure_ascii=False, default=str)}\n\n"

    async def gen():
        try:
            yield "retry: 2000\n\n"
            for ev in backlog:
                yield frame(ev)
            while True:
                if await request.is_disconnected():
                    break
                try:
                    ev = await asyncio.wait_for(q.get(), timeout=15)
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"
                    continue
                if ev["seq"] <= last:
                    continue
                yield frame(ev)
        finally:
            obs.unsubscribe(q)

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache",
                                      "X-Accel-Buffering": "no"})
