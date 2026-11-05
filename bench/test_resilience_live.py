"""Live: INKWISE recovers from Ollama being down, and degrades instead of
failing when memory is short. Stops Ollama on purpose (it is restarted by the
code under test). Needs Ollama installed."""
import asyncio
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from app import config  # noqa: E402
from app.ai.base import Notice  # noqa: E402
from app.ai.ollama_provider import OllamaProvider  # noqa: E402

ok = True


def check(name, cond, detail=""):
    global ok
    ok &= bool(cond)
    print(f"{'PASS' if cond else 'FAIL'}  {name}{('  ' + detail) if detail else ''}", flush=True)


async def collect(agen):
    notes, text = [], []
    async for piece in agen:
        (notes if isinstance(piece, Notice) else text).append(str(piece))
    return notes, "".join(text)


def stop_ollama():
    subprocess.run(["powershell", "-NoProfile", "-Command",
                    "Stop-Process -Name 'ollama','ollama app' -Force -ErrorAction SilentlyContinue"],
                   capture_output=True)


async def main():
    p = OllamaProvider()

    # 1. Ollama not running: the first request brings it back
    stop_ollama()
    await asyncio.sleep(2)
    check("Ollama is down before the request", not await p._alive())
    t0 = time.perf_counter()
    notes, text = await collect(p.hint("What is 7 times 8?"))
    check("request succeeded after starting Ollama itself", bool(text.strip()),
          f"{time.perf_counter() - t0:.0f}s, {len(text)} chars")
    check("Ollama is running again", await p._alive())

    # 2. Not enough memory for the text model: answer with the small model
    from app import resources
    await p.unload()
    await asyncio.sleep(2)
    sizes = await p._tags()
    need_text = sizes[config.TEXT_MODEL] / 1024 ** 3 * 1.1
    free = resources.memory()["free_gb"]
    saved = config.MIN_FREE_RAM_GB
    # reserve chosen so the text model misses by 0.5 GB but the small one fits:
    # the situation of a laptop with a browser full of tabs open
    config.MIN_FREE_RAM_GB = free - need_text + 0.5
    print(f"      free {free:.1f} GB, text model needs {need_text:.1f} GB, "
          f"reserve set to {config.MIN_FREE_RAM_GB:.1f} GB", flush=True)
    try:
        notes, text = await collect(p.hint("What is the capital of France?"))
    finally:
        config.MIN_FREE_RAM_GB = saved
    check("short on memory: the student is told", any("smaller" in n for n in notes),
          notes[0][:90] if notes else "no notice")
    check("short on memory: an answer still arrives", bool(text.strip()), text.strip()[:60])
    loaded = await p._loaded()
    check("the answer came from the small model", config.VISION_MODEL in loaded
          and config.TEXT_MODEL not in loaded, str(sorted(loaded)))

    print("\nRESILIENCE RESULT:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
