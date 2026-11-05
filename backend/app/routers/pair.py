"""Phone pairing: QR code + LAN address discovery."""
from __future__ import annotations

import socket
import uuid

import qrcode
from fastapi import APIRouter, HTTPException

from .. import config
from ..ws import hub

router = APIRouter(prefix="/api/pair", tags=["pair"])


def lan_ip() -> str:
    if config.PUBLIC_HOST:
        return config.PUBLIC_HOST
    # pick the interface that would be used to reach the outside world; no
    # packet is actually sent by connect() on a UDP socket
    for probe in ("10.255.255.255", "192.168.1.1", "8.8.8.8"):
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.settimeout(0.2)
            s.connect((probe, 1))
            ip = s.getsockname()[0]
            if not ip.startswith("127."):
                return ip
        except OSError:
            continue
        finally:
            s.close()
    try:
        return socket.gethostbyname(socket.gethostname())
    except OSError:
        return "127.0.0.1"


def qr_svg(data: str, box: int = 8, quiet: int = 2) -> str:
    """Build an SVG QR with no image-library dependency."""
    q = qrcode.QRCode(border=quiet, box_size=1,
                      error_correction=qrcode.constants.ERROR_CORRECT_M)
    q.add_data(data)
    q.make(fit=True)
    m = q.get_matrix()
    n = len(m)
    side = n * box
    rects = []
    for y, row in enumerate(m):
        x = 0
        while x < n:
            if row[x]:
                run = 1
                while x + run < n and row[x + run]:
                    run += 1
                rects.append(
                    f'<rect x="{x * box}" y="{y * box}" '
                    f'width="{run * box}" height="{box}"/>')
                x += run
            else:
                x += 1
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{side}" height="{side}" '
        f'viewBox="0 0 {side} {side}" shape-rendering="crispEdges">'
        f'<rect width="{side}" height="{side}" fill="#ffffff"/>'
        f'<g fill="#0f172a">{"".join(rects)}</g></svg>')


@router.post("/session")
async def create_session(room: str | None = None):
    """Create (or reuse) a workspace and return the QR the phone scans."""
    rid = room or uuid.uuid4().hex[:8]
    hub.room(rid)                       # materialise it so the phone can join
    ip = lan_ip()
    url = f"http://{ip}:{config.PUBLIC_PORT}/phone?room={rid}"
    return {
        "room": rid, "url": url, "host": ip, "port": config.PUBLIC_PORT,
        "svg": qr_svg(url),
        "ws": f"ws://{ip}:{config.PUBLIC_PORT}/ws/{rid}",
    }


@router.get("/session/{rid}")
async def session_info(rid: str):
    r = hub.rooms.get(rid)
    if not r:
        raise HTTPException(404, "No such workspace")
    return {"room": rid, "peers": r.peers(), "pages": len(r.pages),
            "active": r.active,
            "strokes": sum(len(p["strokes"]) for p in r.pages)}
