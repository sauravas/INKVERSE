"""AI endpoints - the orchestrator's front door.

Each request becomes one traced run (see app/obs.py) that routes to agents
defined in app/agents.py. The model stream is parsed server-side into typed
events (constraint 2); the client receives structured data over SSE and
decides how to render it.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import time

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from .. import agents, config, db, imaging, obs, resources
from ..ai import registry
from ..ai.base import ProviderError
from ..ai.parser import StepStreamParser, events_to_steps

router = APIRouter(prefix="/api/ai", tags=["ai"])


# --------------------------------------------------------------------------
class ExtractIn(BaseModel):
    image: str                      # data URL or bare base64 PNG
    hint: str = ""
    provider: str | None = None
    consent_cloud: bool = False


class SolveIn(BaseModel):
    question: str
    subject: str = ""
    question_id: str | None = None
    provider: str | None = None
    consent_cloud: bool = False


class ExplainIn(BaseModel):
    question: str
    answer: str = ""
    step: str = ""
    step_index: int | None = None
    ask: str = ""
    ask_image: str | None = None
    question_id: str | None = None
    provider: str | None = None
    consent_cloud: bool = False


def _resolve(name: str | None, consent: bool):
    """Orchestrator step 1: pick the provider and enforce the consent gate."""
    p = registry.get(name)
    if getattr(p, "requires_consent", False) and not consent:
        obs.emit("consent.blocked",
                 f"{getattr(p, 'name', name)} sends data off this machine - "
                 "blocked until the student consents", level="warn")
        raise HTTPException(
            status_code=412,
            detail=("This provider sends your notebook off this machine. "
                    "Re-send with consent_cloud=true to allow it."))
    return p


def _label(p) -> str:
    return getattr(p, "label", None) or getattr(p, "name", "?")


def _sse(event: dict) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no",
               "Connection": "keep-alive"}


# --------------------------------------------------------------------------
@router.get("/providers")
async def providers():
    return {"default": config.PROVIDER, "providers": registry.available()}


@router.get("/health")
async def health(provider: str | None = None):
    p = registry.get(provider)
    return await p.health()


@router.post("/extract")
async def extract(body: ExtractIn):
    """Turn a handwritten page into an editable question the student can correct.

    Orchestration: consent gate -> blank check -> crop -> Reader -> (Verifier).
    """
    p = _resolve(body.provider, body.consent_cloud)
    with obs.trace("read", "Student pressed Solve - read the page",
                   provider=_label(p)) as run:
        try:
            if imaging.is_effectively_blank(body.image):
                obs.emit("route", "Page is blank - no agent called")
                return {"question": "", "confidence": 0.0, "blank": True,
                        "note": "Nothing was written on this page yet."}
            b64, info = imaging.prepare_b64(body.image)
        except HTTPException:
            raise
        except Exception as e:
            run.fail(f"Bad image: {e}")
            raise HTTPException(status_code=400, detail=f"Bad image: {e}")

        if info.get("cropped"):
            o, s = info["original"], info["sent"]
            obs.emit("route", f"Cropped page to ink: {o[0]}x{o[1]} -> {s[0]}x{s[1]}",
                     original=list(o), sent=list(s))
        try:
            out = await agents.read_page(p, b64, body.hint)
        except ProviderError as e:
            run.fail(str(e))
            raise HTTPException(status_code=503, detail=str(e))
        obs.emit("route", "Reading handed to the student for review "
                          "(human in the loop)")
    out["image"] = info
    out["trace"] = run.id
    return out


async def _stream_events(agen, *, run=None, on_done=None):
    """Parse a raw model stream into typed SSE events.

    Events are accumulated as they are emitted so the finished answer can be
    persisted without re-parsing.
    """
    parser = StepStreamParser()
    seen: list[dict] = []
    t0 = time.perf_counter()
    first = None
    try:
        yield _sse({"type": "start", "ts": t0, "trace": run.id if run else None})
        # aclosing: a Stop from the student closes the agent cleanly, so its
        # span ends as "cancelled" instead of dangling until garbage collection
        async with contextlib.aclosing(agen):
            async for chunk in agen:
                if first is None:
                    first = round(time.perf_counter() - t0, 2)
                    yield _sse({"type": "first_token", "ttft_s": first})
                for ev in parser.feed(chunk):
                    seen.append(ev)
                    yield _sse(ev)
        for ev in parser.finish():
            seen.append(ev)
            yield _sse(ev)

        steps = events_to_steps(seen)
        obs.emit("route", f"Parser produced {len(steps)} typed step(s) for the UI",
                 steps=len(steps))
        if on_done:
            try:
                on_done(parser.text(), steps)
            except Exception:
                pass
        yield _sse({"type": "done", "ttft_s": first,
                    "total_s": round(time.perf_counter() - t0, 2),
                    "steps": len(steps)})
    except ProviderError as e:
        if run:
            run.fail(str(e))
        yield _sse({"type": "error", "message": str(e)})
    except asyncio.CancelledError:
        raise
    except Exception as e:
        if run:
            run.fail(f"{type(e).__name__}: {e}")
        yield _sse({"type": "error", "message": f"{type(e).__name__}: {e}"})


@router.post("/solve")
async def solve(body: SolveIn, request: Request):
    """Orchestration: Tutor -> parser -> typed events (-> persist)."""
    if not body.question.strip():
        raise HTTPException(status_code=400, detail="Question is empty.")
    p = _resolve(body.provider, body.consent_cloud)

    def persist(text: str, steps: list[dict]):
        if not body.question_id:
            return
        db.run("UPDATE questions SET answer_md=?, answer_json=?, updated_at=? "
               "WHERE id=?",
               (text, json.dumps(steps), db.now(), body.question_id))
        obs.emit("route", "Answer saved to the filed question")

    async def gen():
        with obs.trace("solve", f"Solve “{obs.preview(body.question, 60)}”",
                       provider=_label(p)) as run:
            obs.emit("route", "Routing confirmed question to Tutor", to="tutor")
            async for chunk in _stream_events(
                    agents.tutor(p, body.question, body.subject),
                    run=run, on_done=persist):
                yield chunk

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers=SSE_HEADERS)


@router.post("/explain")
async def explain(body: ExplainIn):
    """Focused explanation of ONE step. Never regenerates the whole answer.

    Orchestration: (Reader, if the follow-up is handwritten) -> Explainer.
    """
    p = _resolve(body.provider, body.consent_cloud)
    if not body.ask.strip() and not body.ask_image:
        raise HTTPException(status_code=400, detail="No follow-up question given.")

    async def gen():
        with obs.trace("explain", f"Ask about step {body.step_index}",
                       provider=_label(p)) as run:
            ask = body.ask.strip()
            # the follow-up may itself be handwritten next to the step
            if not ask:
                try:
                    b64, _ = imaging.prepare_b64(body.ask_image)
                    ask = await agents.read_followup(p, b64)
                except ProviderError as e:
                    run.fail(str(e))
                    yield _sse({"type": "error", "message": str(e)})
                    return
                except Exception as e:
                    run.fail(f"Bad image: {e}")
                    yield _sse({"type": "error", "message": f"Bad image: {e}"})
                    return
            if not ask:
                run.fail("Could not read the handwritten follow-up")
                yield _sse({"type": "error",
                            "message": "Could not read your follow-up question."})
                return

            eid = db.nid()
            if body.question_id:
                db.run("INSERT INTO explanations (id, question_id, step_index, "
                       "step_text, ask, created_at) VALUES (?,?,?,?,?,?)",
                       (eid, body.question_id, body.step_index, body.step[:2000],
                        ask, db.now()))

            def persist(text: str, steps: list[dict]):
                if body.question_id:
                    db.run("UPDATE explanations SET answer_json=? WHERE id=?",
                           (json.dumps(steps), eid))

            yield _sse({"type": "ask", "value": ask, "explanation_id": eid})
            obs.emit("route", "Routing step + follow-up to Explainer",
                     to="explainer")
            async for chunk in _stream_events(
                    agents.explainer(p, body.question, body.answer, body.step, ask),
                    run=run, on_done=persist):
                yield chunk

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers=SSE_HEADERS)


# --------------------------------------------------------------------------
@router.get("/memory")
async def memory():
    """Free RAM plus which models are currently resident."""
    info = {"memory": resources.memory(), "guard": config.RAM_GUARD,
            "min_free_gb": config.MIN_FREE_RAM_GB}
    try:
        p = registry.get("local")
        info["loaded"] = sorted(await p._loaded())
    except Exception:
        info["loaded"] = []
    return info


@router.post("/unload")
async def unload(model: str | None = None):
    """Evict model(s) from RAM right now."""
    p = registry.get("local")
    if not hasattr(p, "unload"):
        raise HTTPException(400, "This provider has nothing to unload.")
    out = await p.unload(model)
    obs.emit("model.evict", f"Student unloaded {', '.join(out['unloaded']) or 'nothing'}",
             models=out["unloaded"])
    return out
