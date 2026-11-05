"""End-to-end stroke sync test: a phone client and a laptop client on one room."""
import asyncio
import json
import time

import httpx
import websockets

BASE = "http://127.0.0.1:8000"
WS = "ws://127.0.0.1:8000/ws"


async def recv_until(ws, want, timeout=5.0):
    """Collect messages until one of type `want` arrives."""
    got = []
    end = time.perf_counter() + timeout
    while time.perf_counter() < end:
        try:
            raw = await asyncio.wait_for(ws.recv(), timeout=end - time.perf_counter())
        except asyncio.TimeoutError:
            break
        m = json.loads(raw)
        got.append(m)
        if m.get("t") == want:
            return m, got
    return None, got


async def main():
    ok = True

    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.post(f"{BASE}/api/pair/session")
        sess = r.json()
    room = sess["room"]
    print(f"1. pairing session   room={room}")
    print(f"   url  {sess['url']}")
    print(f"   qr   {len(sess['svg'])} bytes of SVG")
    assert sess["svg"].startswith("<svg"), "QR must be SVG"

    laptop = await websockets.connect(f"{WS}/{room}?role=laptop")
    wl = json.loads(await laptop.recv())
    page = wl["snapshot"]["pages"][0]["id"]
    print(f"2. laptop joined     client={wl['clientId']} page={page}")

    phone = await websockets.connect(f"{WS}/{room}?role=phone")
    wp = json.loads(await phone.recv())
    print(f"3. phone joined      client={wp['clientId']} "
          f"sees {len(wp['snapshot']['pages'])} page(s), peers={len(wp['peers'])}")

    # --- phone writes, laptop must receive -------------------------------
    t0 = time.perf_counter()
    await phone.send(json.dumps({"t": "stroke_begin", "id": "s1", "pageId": page,
                                 "tool": "pen", "color": "#16213a", "size": 2.4,
                                 "pts": [[100, 100, 0.5, 0]]}))
    m, _ = await recv_until(laptop, "stroke_begin")
    lat = (time.perf_counter() - t0) * 1000
    print(f"4. phone->laptop     stroke_begin relayed in {lat:.1f} ms "
          f"(author role={m['role']})" if m else "4. FAILED stroke_begin")
    ok &= m is not None

    for i in range(5):
        await phone.send(json.dumps({"t": "stroke_points", "id": "s1",
                                     "pts": [[100 + i * 7, 120 + i * 3, 0.6, i]]}))
    await phone.send(json.dumps({"t": "stroke_end", "id": "s1"}))
    m, _ = await recv_until(laptop, "stroke_end")
    print(f"5. stroke_end        received={m is not None}")
    ok &= m is not None

    # --- laptop writes, phone must receive -------------------------------
    await laptop.send(json.dumps({"t": "stroke_begin", "id": "s2", "pageId": page,
                                  "pts": [[300, 300, 0.9, 0]]}))
    await laptop.send(json.dumps({"t": "stroke_end", "id": "s2"}))
    m, _ = await recv_until(phone, "stroke_end")
    print(f"6. laptop->phone     received={m is not None}")
    ok &= m is not None

    # --- shared state: a late joiner sees both strokes --------------------
    late = await websockets.connect(f"{WS}/{room}?role=phone")
    wlate = json.loads(await late.recv())
    strokes = wlate["snapshot"]["pages"][0]["strokes"]
    ids = sorted(s["id"] for s in strokes)
    print(f"7. late joiner       snapshot has strokes {ids} "
          f"({len(strokes[0]['pts'])} pts on s1)")
    ok &= ids == ["s1", "s2"]

    # --- per-author undo: phone undo must not remove the laptop stroke ----
    await phone.send(json.dumps({"t": "undo"}))
    m, _ = await recv_until(laptop, "erase")
    removed = m["ids"] if m else []
    print(f"8. phone undo        erased {removed} (must be ['s1'], not s2)")
    ok &= removed == ["s1"]

    await phone.send(json.dumps({"t": "redo"}))
    m, _ = await recv_until(laptop, "restore")
    print(f"9. phone redo        restored "
          f"{[s['id'] for s in m['strokes']] if m else None}")
    ok &= m is not None and [s["id"] for s in m["strokes"]] == ["s1"]

    # --- pages ------------------------------------------------------------
    await laptop.send(json.dumps({"t": "page_add"}))
    m, _ = await recv_until(phone, "pages")
    print(f"10. page_add         phone now sees "
          f"{len(m['snapshot']['pages']) if m else 0} pages")
    ok &= m is not None and len(m["snapshot"]["pages"]) == 2

    # --- throughput -------------------------------------------------------
    N = 300
    t0 = time.perf_counter()
    await phone.send(json.dumps({"t": "stroke_begin", "id": "s3",
                                 "pageId": page, "pts": []}))
    for i in range(N):
        await phone.send(json.dumps({"t": "stroke_points", "id": "s3",
                                     "pts": [[i, i, 0.5, i]]}))
    await phone.send(json.dumps({"t": "stroke_end", "id": "s3"}))
    m, _ = await recv_until(laptop, "stroke_end", timeout=15)
    dt = time.perf_counter() - t0
    print(f"11. throughput       {N} point msgs round-tripped in {dt * 1000:.0f} ms "
          f"({N / dt:.0f} msg/s)")
    ok &= m is not None

    # --- persistence ------------------------------------------------------
    async with httpx.AsyncClient(timeout=10) as c:
        r = await c.post(f"{BASE}/api/notebook/save", json={"room": room})
        saved = r.json()
        pages = (await c.get(f"{BASE}/api/notebook/pages")).json()
    print(f"12. persistence      saved {saved['count']} pages, "
          f"{len(pages)} in SQLite")
    ok &= saved["count"] == 2

    for w in (laptop, phone, late):
        await w.close()
    print("\nSYNC RESULT:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
