"""Observability: a live, in-process event bus for agent activity.

Every agent run, model call, model eviction, retry and guard decision is
emitted here as a small typed event. The UI subscribes over SSE
(GET /api/obs/stream) and draws the orchestration graph and log from them.

Design rules:
- emit() is synchronous and never raises; observability must not be able to
  break a solve, exactly as AI must not be able to break writing.
- Events never carry notebook content in full: questions are truncated to a
  short preview, images are never included.
- The buffer is in memory and bounded. Nothing is persisted to disk.
"""
from __future__ import annotations

import asyncio
import contextvars
import itertools
import time
import uuid
from collections import deque

BUFFER_SIZE = 500

_buf: deque[dict] = deque(maxlen=BUFFER_SIZE)
_subs: set[asyncio.Queue] = set()
_seq = itertools.count(1)

_trace: contextvars.ContextVar[str | None] = contextvars.ContextVar("obs_trace", default=None)
_agent: contextvars.ContextVar[str | None] = contextvars.ContextVar("obs_agent", default=None)

# per-agent counters since server start
_stats: dict[str, dict] = {}


def preview(text: str | None, n: int = 70) -> str:
    t = " ".join((text or "").split())
    return t if len(t) <= n else t[: n - 1] + "…"


def emit(kind: str, message: str = "", *, agent: str | None = None,
         trace: str | None = None, level: str = "info", **data) -> dict | None:
    try:
        ev = {
            "seq": next(_seq),
            "ts": time.time(),
            "trace": trace or _trace.get(),
            "agent": agent or _agent.get() or "orchestrator",
            "kind": kind,
            "level": level,
            "message": message,
            "data": data,
        }
        _buf.append(ev)
        for q in list(_subs):
            try:
                q.put_nowait(ev)
            except asyncio.QueueFull:
                pass            # a stalled viewer drops events, never blocks us
        return ev
    except Exception:
        return None


def recent(n: int = BUFFER_SIZE) -> list[dict]:
    return list(_buf)[-n:]


def stats() -> dict:
    return {k: dict(v) for k, v in _stats.items()}


def subscribe() -> asyncio.Queue:
    q: asyncio.Queue = asyncio.Queue(maxsize=1000)
    _subs.add(q)
    return q


def unsubscribe(q: asyncio.Queue) -> None:
    _subs.discard(q)


def _record(agent: str, status: str, ms: float) -> None:
    s = _stats.setdefault(agent, {"calls": 0, "errors": 0, "total_ms": 0.0,
                                  "last_ms": None, "last_ts": None})
    s["calls"] += 1
    if status == "error":
        s["errors"] += 1
    s["total_ms"] += ms
    s["last_ms"] = round(ms)
    s["last_ts"] = time.time()


class _Ctx:
    """Sync context manager so it is safe inside async generators."""

    def __init__(self):
        self._tokens = []

    def _set(self, var, value):
        self._tokens.append((var, var.set(value)))

    def _restore(self):
        for var, tok in reversed(self._tokens):
            try:
                var.reset(tok)
            except ValueError:     # generator closed from another context
                pass
        self._tokens.clear()


class trace(_Ctx):
    """One user request handled by the orchestrator (a "run")."""

    def __init__(self, flow: str, message: str = "", **data):
        super().__init__()
        self.id = uuid.uuid4().hex[:6]
        self.flow, self.message, self.data = flow, message, data
        self.status = "ok"

    def __enter__(self):
        self._t0 = time.perf_counter()
        self._set(_trace, self.id)
        self._set(_agent, "orchestrator")
        emit("run.start", self.message, flow=self.flow, **self.data)
        return self

    def fail(self, why: str):
        self.status = "error"
        emit("run.error", why, level="error", flow=self.flow)

    def __exit__(self, et, ev, tb):
        if et is not None and self.status == "ok":
            self.status = "cancelled" if et in (GeneratorExit, asyncio.CancelledError) \
                else "error"
        ms = (time.perf_counter() - self._t0) * 1000
        emit("run.end", f"{self.flow} {self.status} in {ms / 1000:.1f}s",
             agent="orchestrator", flow=self.flow, status=self.status,
             duration_ms=round(ms),
             level="error" if self.status == "error" else "info")
        self._restore()
        return False


class span(_Ctx):
    """One agent doing one job inside a run."""

    def __init__(self, agent: str, message: str = "", **data):
        super().__init__()
        self.agent, self.message, self.data = agent, message, data
        self.status = "ok"
        self.parent = None

    def __enter__(self):
        self.parent = _agent.get()
        self._t0 = time.perf_counter()
        self._set(_agent, self.agent)
        # `caller` overrides the context for a hand-off: the Verifier runs
        # after the Reader returns, but on the Reader's output
        caller = self.data.pop("caller", None) or self.parent or "orchestrator"
        emit("agent.start", self.message, agent=self.agent, caller=caller,
             **self.data)
        return self

    def fail(self, why: str):
        self.status = "error"
        emit("agent.error", why, agent=self.agent, level="error")

    def __exit__(self, et, ev, tb):
        if et is not None and self.status == "ok":
            if et in (GeneratorExit, asyncio.CancelledError):
                self.status = "cancelled"
            else:
                self.status = "error"
                emit("agent.error", preview(str(ev), 200) or et.__name__,
                     agent=self.agent, level="error")
        ms = (time.perf_counter() - self._t0) * 1000
        _record(self.agent, self.status, ms)
        emit("agent.end", f"{self.status} in {ms / 1000:.1f}s", agent=self.agent,
             status=self.status, duration_ms=round(ms),
             level="error" if self.status == "error" else "info")
        self._restore()
        return False
