"""Voice input via the whisperflow sidecar.

The browser streams 16 kHz int16 PCM to INKWISE at /ws/speech; INKWISE relays
it to whisperflow and relays its transcripts back. One address for the browser
(and the phone), whisperflow's pinned dependencies kept out of INKWISE's own
environment, and everything stays on this machine.
"""
from __future__ import annotations

import asyncio
import json
import os
import subprocess
import time
from pathlib import Path
from urllib.parse import urlparse

import httpx
import websockets
from fastapi import WebSocket, WebSocketDisconnect

from . import config, db

_start_lock = asyncio.Lock()
_last_start = 0.0


def _http_base() -> str:
    u = urlparse(config.SPEECH_URL)
    return f"http://{u.hostname}:{u.port or 8181}"


async def status() -> dict:
    try:
        async with httpx.AsyncClient(timeout=3) as c:
            r = await c.get(f"{_http_base()}/ready")
            d = r.json()
            return {"ok": d.get("status") == "ok", "models": d.get("models"),
                    "model_loaded": d.get("model_loaded"), "engine": "whisperflow",
                    "version": d.get("version")}
    except Exception as e:
        installed = Path(config.SPEECH_PYTHON).is_file()
        return {"ok": False, "engine": "whisperflow", "installed": installed,
                "detail": ("not running yet - it starts on first use" if installed else
                           f"whisperflow is not installed ({config.SPEECH_PYTHON} missing)")
                          if not isinstance(e, httpx.HTTPStatusError) else str(e)}


async def ensure_running() -> bool:
    """Start the whisperflow sidecar if it is not up, and wait for its model."""
    global _last_start
    if (await status())["ok"]:
        return True
    if not config.AUTOSTART_SPEECH or not Path(config.SPEECH_PYTHON).is_file():
        return False
    async with _start_lock:
        if (await status())["ok"]:
            return True
        if time.monotonic() - _last_start > 60:
            _last_start = time.monotonic()
            u = urlparse(config.SPEECH_URL)
            flags = 0
            if os.name == "nt":
                flags = (subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
                         | subprocess.CREATE_NO_WINDOW)
            log = open(config.DATA_DIR / "whisperflow.log", "ab")   # noqa: SIM115
            subprocess.Popen(
                [config.SPEECH_PYTHON, "-m", "uvicorn", "whisperflow.fast_server:app",
                 "--host", u.hostname or "127.0.0.1", "--port", str(u.port or 8181)],
                stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                creationflags=flags, close_fds=True)
        for _ in range(120):                     # the model takes a while to load
            await asyncio.sleep(0.5)
            if (await status())["ok"]:
                return True
    return False


def vocabulary(subject_id: str | None = None) -> str:
    """Words the student is likely to say, to bias recognition: subject and
    module names, and the most frequent long words in their questions."""
    if subject_id:
        names = [r["name"] for r in db.rows(
            "SELECT name FROM subjects WHERE id=? UNION ALL "
            "SELECT name FROM modules WHERE subject_id=?", (subject_id, subject_id))]
    else:
        names = [r["name"] for r in db.rows(
            "SELECT name FROM subjects WHERE origin IS NULL "
            "UNION ALL SELECT name FROM modules LIMIT 60")]
    words = " ".join(names)
    return words[:780]


async def relay(ws: WebSocket, subject_id: str | None = None):
    """Browser <-> whisperflow, until either side closes."""
    await ws.accept()
    if not await ensure_running():
        await ws.send_json({"type": "error", "message": (await status()).get("detail")
                            or "Voice input is not available."})
        await ws.close()
        return
    try:
        upstream = await websockets.connect(config.SPEECH_URL, max_size=2 ** 22)
    except Exception as e:
        await ws.send_json({"type": "error", "message": f"Cannot reach whisperflow: {e}"})
        await ws.close()
        return

    await upstream.send(json.dumps({"type": "start", "language": "en",
                                    "prompt": vocabulary(subject_id) or None}))
    await ws.send_json({"type": "ready"})

    async def browser_to_whisper():
        try:
            while True:
                msg = await ws.receive()
                if msg.get("type") == "websocket.disconnect":
                    break
                if msg.get("bytes"):
                    await upstream.send(msg["bytes"])
                elif msg.get("text"):
                    ctl = json.loads(msg["text"])
                    if ctl.get("type") in ("flush", "stop"):
                        await upstream.send(json.dumps({"type": ctl["type"]}))
                        if ctl["type"] == "stop":
                            break
        except (WebSocketDisconnect, RuntimeError):
            pass

    async def whisper_to_browser():
        try:
            async for msg in upstream:
                d = json.loads(msg)
                if "data" in d:
                    await ws.send_json({"type": "partial" if d.get("is_partial") else "final",
                                        "text": (d["data"].get("text") or "").strip()})
                elif d.get("type") == "error":
                    await ws.send_json({"type": "error", "message": d.get("message")})
        except (websockets.ConnectionClosed, RuntimeError):
            pass

    up = asyncio.create_task(browser_to_whisper())
    down = asyncio.create_task(whisper_to_browser())
    await up                                  # the browser decides when it is done
    try:
        await asyncio.wait_for(down, timeout=6)  # let the last final arrive
    except asyncio.TimeoutError:
        down.cancel()
    await upstream.close()
    try:
        await ws.send_json({"type": "end"})
        await ws.close()
    except RuntimeError:
        pass
