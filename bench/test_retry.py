"""Deterministic check of crash recovery, without needing the GPU to crash.

Simulates the failure seen live: the vision runner emits a few tokens, then
dies. Buffered extraction must restart cleanly and return only the complete
reply - no partial text duplicated into the result.
"""
import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from app.ai import ollama_provider as op  # noqa: E402
from app.ai.base import ProviderError     # noqa: E402

CRASH = ("an error was encountered while running the model: read tcp "
         "127.0.0.1:63575->127.0.0.1:52337: wsarecv: An existing connection "
         "was forcibly closed by the remote host.")
REPLY = "QUESTION:\nFind the derivative of $4x^2$\nEND\nCONFIDENCE: 0.9"


def fake(failures_before_success, partial=True):
    calls = {"n": 0}

    async def stream(self, model, messages, **kw):
        calls["n"] += 1
        if calls["n"] <= failures_before_success:
            if partial:
                yield "QUESTION:\nFind the"   # tokens, then the runner dies
            raise ProviderError(CRASH)
        for ch in (REPLY[:20], REPLY[20:]):
            yield ch
    return stream, calls


async def run(case, failures, attempts=5, partial=True, error=CRASH):
    p = op.OllamaProvider("gemma3:4b", "qwen2.5:14b")
    stream, calls = fake(failures, partial)
    if error is not CRASH:
        async def stream(self, model, messages, **kw):  # noqa: F811
            calls["n"] += 1
            raise ProviderError(error)
            yield ""
    p._stream_chat = stream.__get__(p)
    async def no_unload(model=None):
        return {}
    p.unload = no_unload
    real_sleep = asyncio.sleep
    op.asyncio.sleep = lambda s: real_sleep(0)   # don't actually back off
    try:
        out = await p._complete("gemma3:4b", [], attempts=attempts)
        return out, calls["n"], None
    except ProviderError as e:
        return None, calls["n"], str(e)
    finally:
        op.asyncio.sleep = real_sleep


async def main():
    ok = True

    out, n, err = await run("partial crash x2", failures=2)
    good = out == REPLY
    print(f"{'PASS' if good else 'FAIL'}  crash after partial output, twice -> "
          f"recovered on attempt {n}, clean reply={good}")
    ok &= good and n == 3

    out, n, err = await run("crash with no output", failures=1, partial=False)
    good = out == REPLY
    print(f"{'PASS' if good else 'FAIL'}  crash before any output -> "
          f"recovered on attempt {n}")
    ok &= good

    out, n, err = await run("never recovers", failures=99)
    good = out is None and n == 5 and "crashed 5 times" in (err or "")
    print(f"{'PASS' if good else 'FAIL'}  persistent crash -> gives up after "
          f"{n} attempts with a readable message")
    ok &= good

    out, n, err = await run("bad request", failures=0,
                            error="model 'x' does not support images")
    good = out is None and n == 1
    print(f"{'PASS' if good else 'FAIL'}  non-crash error -> not retried "
          f"({n} call), surfaced as-is")
    ok &= good

    print("\nRETRY RESULT:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
