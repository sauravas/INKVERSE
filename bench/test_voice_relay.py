"""Voice through INKWISE: browser-shaped client -> /ws/speech -> whisperflow.

Exercises the relay exactly as the frontend uses it (binary PCM frames, a
stop control frame, typed partial/final/end messages back), including the
sidecar being started on demand if it is not already running.
"""
import asyncio
import json
import sys
import time
import wave

import httpx
import websockets

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
BASE = "127.0.0.1:8000"


async def ask(path):
    with wave.open(path, "rb") as w:
        pcm = w.readframes(w.getnframes())
    t0 = time.perf_counter()
    partials, finals, ready_at = [], [], None
    async with websockets.connect(f"ws://{BASE}/ws/speech", max_size=2 ** 22,
                                  open_timeout=120) as ws:
        first = json.loads(await asyncio.wait_for(ws.recv(), 120))
        if first.get("type") == "error":
            return None, first.get("message")
        ready_at = time.perf_counter() - t0

        async def reader():
            async for m in ws:
                d = json.loads(m)
                if d["type"] == "partial":
                    partials.append(d["text"])
                elif d["type"] == "final" and d["text"]:
                    finals.append(d["text"])
                elif d["type"] == "end":
                    return

        task = asyncio.create_task(reader())
        for i in range(0, len(pcm), 3200):
            await ws.send(pcm[i:i + 3200])
            await asyncio.sleep(0.1)
        await asyncio.sleep(1.2)
        await ws.send(json.dumps({"type": "stop"}))
        await asyncio.wait_for(task, 20)
    return {"ready_s": round(ready_at, 1), "partials": len(partials),
            "first_partial": partials[0] if partials else None,
            "text": " ".join(finals)}, None


async def main():
    st = httpx.get(f"http://{BASE}/api/speech/status").json()
    print("sidecar before first use:", "running" if st["ok"] else f"down ({st.get('detail')})")
    d = sys.argv[1]
    ok = True
    for name, want in [("q1", "derivative"), ("q2", "laplace"), ("q3", "thread")]:
        res, err = await ask(f"{d}/{name}.wav")
        if err:
            print(f"FAIL  {name}: {err}"); ok = False; continue
        good = want in res["text"].lower()
        ok &= good
        print(f"{'PASS' if good else 'FAIL'}  {name}: ready after {res['ready_s']}s, "
              f"{res['partials']} partials (first: {res['first_partial']!r}) -> {res['text']!r}")
    st = httpx.get(f"http://{BASE}/api/speech/status").json()
    print("sidecar after:", "running" if st["ok"] else "down")
    print("\nVOICE RELAY:", "PASS" if ok else "FAIL")


if __name__ == "__main__":
    asyncio.run(main())
