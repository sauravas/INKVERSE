from __future__ import annotations

import contextlib
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from . import config, db, resources
from .routers import ai, imports, notebook, notes, pair, practice, study
from .ws import hub


@contextlib.asynccontextmanager
async def lifespan(app: FastAPI):
    db.init()
    yield


app = FastAPI(title="INKWISE", version="1.0", lifespan=lifespan)

# the phone joins from another LAN origin, and Vite dev runs on :5173
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_credentials=False,
    allow_methods=["*"], allow_headers=["*"],
)

app.include_router(ai.router)
app.include_router(study.router)
app.include_router(notebook.router)
app.include_router(pair.router)
app.include_router(imports.router)
app.include_router(practice.router)
app.include_router(notes.router)


@app.get("/api/status")
async def status():
    return {
        "app": "INKWISE",
        "provider_default": config.PROVIDER,
        "vision_model": config.VISION_MODEL,
        "text_model": config.TEXT_MODEL,
        "heavy_model": config.HEAVY_MODEL,
        "memory": resources.memory(),
        "rooms": {rid: {"pages": len(r.pages), "peers": len(r.clients)}
                  for rid, r in hub.rooms.items()},
    }


@app.websocket("/ws/{room}")
async def ws_endpoint(ws: WebSocket, room: str, role: str = "laptop",
                      name: str = ""):
    await ws.accept()
    client = await hub.join(room, ws, role=role, name=name)
    try:
        while True:
            msg = await ws.receive_json()
            await hub.handle(room, client, msg)
    except WebSocketDisconnect:
        pass
    except Exception:
        pass
    finally:
        await hub.leave(room, client.id)


# --- static frontend -------------------------------------------------------
DIST = Path(__file__).resolve().parents[2] / "frontend" / "dist"

if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/{full_path:path}")
    async def spa(full_path: str):
        if full_path.startswith("api/"):
            return JSONResponse({"detail": "Not found"}, status_code=404)
        candidate = DIST / full_path
        if full_path and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(DIST / "index.html")
else:
    @app.get("/")
    async def no_build():
        return JSONResponse({
            "detail": "Frontend not built. Run `npm install && npm run build` "
                      "in frontend/, or use the Vite dev server on :5173.",
        }, status_code=503)
