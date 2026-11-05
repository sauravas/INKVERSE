"""Stream recorded speech to a whisperflow server and report what it hears.

Usage: test_whisperflow.py <ws-url> <wav files...>
Streams 100 ms chunks at real-time pace, the way a microphone would, with a
vocabulary prompt of subject terms, then flushes and stops.
"""
import asyncio
import json
import sys
import time
import wave

import websockets

sys.stdout.reconfigure(encoding="utf-8", errors="replace")
VOCAB = "Laplace transform, shifting theorem, derivative, sine, cosine, integral, thread, process"


async def run(url, path):
    with wave.open(path, "rb") as w:
        assert w.getframerate() == 16000 and w.getnchannels() == 1 and w.getsampwidth() == 2
        pcm = w.readframes(w.getnframes())
    chunk = 3200                                   # 100 ms of 16 kHz int16 mono
    finals, partials, first_partial = [], 0, None
    t0 = time.perf_counter()
    async with websockets.connect(url, max_size=2 ** 22) as ws:
        await ws.send(json.dumps({"type": "start", "prompt": VOCAB}))

        async def reader():
            nonlocal partials, first_partial
            async for msg in ws:
                d = json.loads(msg)
                if "data" not in d:
                    continue
                if d.get("is_partial"):
                    partials += 1
                    first_partial = first_partial or time.perf_counter() - t0
                else:
                    finals.append(d["data"].get("text", "").strip())

        task = asyncio.create_task(reader())
        for i in range(0, len(pcm), chunk):
            await ws.send(pcm[i:i + chunk])
            await asyncio.sleep(0.1)               # real-time pace
        await ws.send(json.dumps({"type": "flush"}))
        await asyncio.sleep(2.5)
        await ws.send(json.dumps({"type": "stop"}))
        try:
            await asyncio.wait_for(task, 10)
        except (asyncio.TimeoutError, websockets.ConnectionClosed):
            pass
    audio_s = len(pcm) / 32000
    text = " ".join(t for t in finals if t)
    print(f"{path.rsplit(chr(92), 1)[-1]:8} audio {audio_s:4.1f}s  first partial "
          f"{(first_partial or 0):4.1f}s  partials {partials:2}  -> {text!r}", flush=True)
    return text


async def main():
    url, files = sys.argv[1], sys.argv[2:]
    for f in files:
        await run(url, f)


if __name__ == "__main__":
    asyncio.run(main())
