"""One shared HTTP client for model providers.

Creating an httpx.AsyncClient builds a TLS context synchronously, measured at
350-500 ms on Windows. The providers used to create one per call - several per
Solve - which blocked the event loop for seconds, freezing phone stroke sync
(ARCHITECTURE.md #1) and delaying live observability events. Now one client is
created per event loop (at startup, see main.py) and reused.

Usage mirrors the old code: `async with http.session(timeout) as c:` gives an
object with get/post/stream that apply that timeout per request.
"""
from __future__ import annotations

import asyncio
import contextlib
import weakref

import httpx

_clients: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, httpx.AsyncClient]" = \
    weakref.WeakKeyDictionary()


def client() -> httpx.AsyncClient:
    """The shared client for the running event loop."""
    loop = asyncio.get_running_loop()
    c = _clients.get(loop)
    if c is None or c.is_closed:
        c = httpx.AsyncClient(timeout=None)
        _clients[loop] = c
    return c


class _Timed:
    def __init__(self, c: httpx.AsyncClient, timeout: float | None):
        self._c, self._t = c, timeout

    def get(self, *a, **k):
        k.setdefault("timeout", self._t)
        return self._c.get(*a, **k)

    def post(self, *a, **k):
        k.setdefault("timeout", self._t)
        return self._c.post(*a, **k)

    def stream(self, *a, **k):
        k.setdefault("timeout", self._t)
        return self._c.stream(*a, **k)


@contextlib.asynccontextmanager
async def session(timeout: float | None):
    yield _Timed(client(), timeout)


async def aclose() -> None:
    with contextlib.suppress(RuntimeError):
        c = _clients.pop(asyncio.get_running_loop(), None)
        if c is not None:
            await c.aclose()
