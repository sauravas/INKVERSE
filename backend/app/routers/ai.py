"""AI endpoints.

The model stream is parsed server-side into typed events (constraint 2); the
client receives structured data over SSE and decides how to render it.
"""
from __future__ import annotations

import asyncio
import json
import time

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from .. import config, db, imaging, resources, retrieval, websearch
from ..ai import registry
from ..ai.base import Notice, ProviderError
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
    subject_id: str | None = None
    module_id: str | None = None
    provider: str | None = None
    consent_cloud: bool = False
    # also look the question up on the web; sends its text to Wikipedia/DDG
    web: bool = False
    # earlier questions in this sitting: [{"question": ..., "answer": ...}]
    session: list[dict] = []


class HintIn(BaseModel):
    question: str
    question_id: str | None = None
    subject_id: str | None = None
    module_id: str | None = None
    provider: str | None = None
    consent_cloud: bool = False


class ExplainIn(BaseModel):
    question: str
    answer: str = ""
    step: str = ""
    step_index: int | None = None
    ask: str = ""
    ask_image: str | None = None
    # earlier turns about this same step: [{"ask": ..., "answer": ...}]
    history: list[dict] = []
    # what the student circled inside the step (labels, formulas, words)
    focus: str = ""
    question_id: str | None = None
    provider: str | None = None
    consent_cloud: bool = False


def _resolve(name: str | None, consent: bool):
    p = registry.get(name)
    if getattr(p, "requires_consent", False) and not consent:
        raise HTTPException(
            status_code=412,
            detail=("This provider sends your notebook off this machine. "
                    "Re-send with consent_cloud=true to allow it."))
    return p


def _sse(event: dict) -> str:
    return f"data: {json.dumps(event, ensure_ascii=False)}\n\n"


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
    """Turn a handwritten page into an editable question the student can correct."""
    try:
        if imaging.is_effectively_blank(body.image):
            return {"question": "", "confidence": 0.0, "blank": True,
                    "note": "Nothing was written on this page yet."}
        b64, info = imaging.prepare_b64(body.image)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Bad image: {e}")

    p = _resolve(body.provider, body.consent_cloud)
    try:
        out = await p.extract(b64, body.hint)
    except ProviderError as e:
        raise HTTPException(status_code=503, detail=str(e))
    out["image"] = info
    return out


async def _stream_events(agen, *, on_done=None, sources=None, notices=None):
    """Parse a raw model stream into typed SSE events.

    Events are accumulated as they are emitted so the finished answer can be
    persisted without re-parsing.
    """
    parser = StepStreamParser()
    seen: list[dict] = []
    t0 = time.perf_counter()
    first = None
    try:
        yield _sse({"type": "start", "ts": t0})
        if sources:
            # what the answer was grounded in, so the student can check it
            yield _sse({"type": "sources", "items": sources})
        for note in notices or []:
            yield _sse({"type": "notice", "message": note})
        async for chunk in agen:
            if isinstance(chunk, Notice):
                # e.g. "answering with the smaller model": shown, never parsed
                yield _sse({"type": "notice", "message": str(chunk)})
                continue
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
        if on_done:
            try:
                on_done(parser.text(), steps)
            except Exception:
                pass
        yield _sse({"type": "done", "ttft_s": first,
                    "total_s": round(time.perf_counter() - t0, 2),
                    "steps": len(steps)})
    except ProviderError as e:
        yield _sse({"type": "error", "message": str(e)})
    except asyncio.CancelledError:
        raise
    except Exception as e:
        yield _sse({"type": "error", "message": f"{type(e).__name__}: {e}"})


@router.post("/solve")
async def solve(body: SolveIn, request: Request):
    if not body.question.strip():
        raise HTTPException(status_code=400, detail="Question is empty.")
    p = _resolve(body.provider, body.consent_cloud)

    def persist(text: str, steps: list[dict]):
        if not body.question_id:
            return
        db.run("UPDATE questions SET answer_md=?, answer_json=?, updated_at=? "
               "WHERE id=?",
               (text, json.dumps(steps), db.now(), body.question_id))

    context, used = retrieval.context_for(
        body.question, body.question_id, body.subject_id, body.module_id)
    notices = []
    if body.web:
        w = await websearch.lookup(body.question)
        if w["block"]:
            context = "\n\n".join(x for x in (context, w["block"]) if x)
            used = used + w["sources"]
        elif w.get("skipped"):
            notices.append(f"Web search skipped: {w['skipped']}.")
        else:
            notices.append(f"No web results ({w.get('error') or 'none found'}); "
                           "answering from the local model alone.")
    agen = p.solve(body.question, body.subject, context, body.session)
    return StreamingResponse(
        _stream_events(agen, on_done=persist, sources=used, notices=notices),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no",
                 "Connection": "keep-alive"})


@router.post("/explain")
async def explain(body: ExplainIn):
    """Focused explanation of ONE step. Never regenerates the whole answer."""
    ask = body.ask.strip()
    p = _resolve(body.provider, body.consent_cloud)

    # the follow-up may itself be handwritten next to the step
    if not ask and body.ask_image:
        try:
            b64, _ = imaging.prepare_b64(body.ask_image)
            got = await p.extract(b64, hint="This is a short follow-up question.")
            ask = got.get("question", "").strip()
        except ProviderError as e:
            raise HTTPException(status_code=503, detail=str(e))
    if not ask:
        raise HTTPException(status_code=400, detail="No follow-up question given.")

    eid = db.nid()
    if body.question_id:
        db.run("INSERT INTO explanations (id, question_id, step_index, step_text, "
               "ask, created_at) VALUES (?,?,?,?,?,?)",
               (eid, body.question_id, body.step_index, body.step[:2000], ask,
                db.now()))

    def persist(text: str, steps: list[dict]):
        if body.question_id:
            db.run("UPDATE explanations SET answer_json=? WHERE id=?",
                   (json.dumps(steps), eid))

    context, used = retrieval.context_for(f"{ask}\n{body.step}", body.question_id)
    agen = p.explain(body.question, body.answer, body.step, ask, context,
                     body.history, body.focus)

    async def gen():
        yield _sse({"type": "ask", "value": ask, "explanation_id": eid})
        async for chunk in _stream_events(
                agen, on_done=persist, sources=used):
            yield chunk

    return StreamingResponse(
        gen(), media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no",
                 "Connection": "keep-alive"})


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
    return await p.unload(model)


@router.post("/hint")
async def hint(body: HintIn):
    """One nudge toward the method - deliberately not the answer.

    The question bank asks the student to try first; this is the step between
    "I'm stuck" and "show me the full solution".
    """
    if not body.question.strip():
        raise HTTPException(status_code=400, detail="Question is empty.")
    p = _resolve(body.provider, body.consent_cloud)
    context, used = retrieval.context_for(
        body.question, body.question_id, body.subject_id, body.module_id)
    return StreamingResponse(
        _stream_events(p.hint(body.question, context), sources=used),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no",
                 "Connection": "keep-alive"})
