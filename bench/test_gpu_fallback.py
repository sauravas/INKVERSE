"""The GPU driver drops the device; the model finishes on the CPU.

This is the failure this machine actually hits. Ollama's server.log shows

    slot encode_mtmd_: id 0 | task 0 | encoding mtmd batch from idx = 40
    [GIN] 500 | 5.67s | POST "/api/chat"
    ggml_vulkan: device lost on Vulkan0

while the vision model encodes a page image. Retrying on the GPU fails the same
way every time, so the provider must stop retrying and re-issue the request with
num_gpu=0. Checked here without a GPU by faking Ollama's HTTP responses.

    .venv\\Scripts\\python.exe bench\\test_gpu_fallback.py
"""
import asyncio
import copy
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from app.ai import http, ollama_provider as op   # noqa: E402
from app.ai.base import Notice, ProviderError     # noqa: E402

VULKAN = ("an error was encountered while running the model: "
          "ggml_vulkan: device lost on Vulkan0")
SOCKET = ("an error was encountered while running the model: wsarecv: An "
          "existing connection was forcibly closed by the remote host.")

fails = 0


def check(name, cond, detail=""):
    global fails
    print(("  ok   " if cond else "  FAIL ") + name
          + (f"  ({detail})" if detail and not cond else ""))
    fails += 0 if cond else 1


# --------------------------------------------------------------- fake Ollama
class FakeResponse:
    def __init__(self, lines, status=200):
        self.status_code = status
        self._lines = lines

    async def aiter_lines(self):
        for line in self._lines:
            yield line

    async def aread(self):
        return b""

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


class FakeClient:
    """Answers /api/chat the way Ollama does when the runner dies."""

    def __init__(self, error, gpu_only=True):
        self.error = error
        self.gpu_only = gpu_only
        self.bodies = []

    def stream(self, method, url, json=None, **kw):
        # the provider reuses one body dict, so keep a snapshot per attempt
        self.bodies.append(copy.deepcopy(json))
        on_cpu = (json or {}).get("options", {}).get("num_gpu") == 0
        if self.error and not (self.gpu_only and on_cpu):
            return FakeResponse([_line(error=self.error)])
        return FakeResponse([_line(content="x = 2"), _line(done=True)])

    async def post(self, *a, **kw):
        return FakeResponse([])

    async def get(self, *a, **kw):
        return FakeResponse([])

    async def __aenter__(self):
        return self

    async def __aexit__(self, *a):
        return False


def _line(content=None, error=None, done=False):
    if error:
        return json.dumps({"error": error})
    return json.dumps({"message": {"content": content or ""}, "done": done})


def provider(client, cpu_first=False):
    # the shipped default keeps the reader on the CPU; these cases are about
    # what happens when a model is on the GPU and the driver drops it
    op.config.VISION_CPU = cpu_first
    p = op.OllamaProvider("gemma3:4b", "qwen2.5:14b")
    http.session = lambda *a, **kw: client          # every call shares it
    p._loaded = lambda: _done(set())
    p.capabilities = lambda m: _done(set())
    p._exclusive = lambda m: _done(None)
    p._guard = lambda m: _done(None)
    p.unload = lambda m=None: _done({"unloaded": [], "memory": {}})
    p._wait_gone = lambda m, timeout=6.0: _done(None)
    return p


async def _done(value):
    return value


async def collect(agen):
    out, notices = [], []
    async for chunk in agen:
        (notices if isinstance(chunk, Notice) else out).append(str(chunk))
    return "".join(out), notices


# --------------------------------------------------------------------- cases
async def main():
    print("a named GPU fault moves the model to the CPU and retries there")
    c = FakeClient(VULKAN)
    p = provider(c)
    text, notices = await collect(
        p._stream_chat("gemma3:4b", [{"role": "user", "content": "q"}]))
    check("request completed", text == "x = 2", repr(text))
    check("second attempt asked for num_gpu=0",
          c.bodies[1]["options"].get("num_gpu") == 0, c.bodies[1]["options"])
    check("first attempt did not", "num_gpu" not in c.bodies[0]["options"])
    check("one attempt was enough after moving", len(c.bodies) == 2, len(c.bodies))
    check("student was told why it is slower",
          len(notices) == 1 and "CPU" in notices[0], notices)
    check("model is pinned for the rest of the session",
          "gemma3:4b" in p._cpu_only)

    print("the pin holds: later requests start on the CPU")
    text, notices = await collect(
        p._stream_chat("gemma3:4b", [{"role": "user", "content": "q"}]))
    check("no second failure", text == "x = 2")
    check("went straight to the CPU",
          c.bodies[2]["options"].get("num_gpu") == 0)
    check("no repeated notice", notices == [], notices)

    print("the text model keeps the GPU to itself")
    check("only the crashing model moved", "qwen2.5:14b" not in p._cpu_only)

    print("an unnamed crash is retried on the GPU once before moving")
    c = FakeClient(SOCKET)
    p = provider(c)
    text, _ = await collect(
        p._stream_chat("qwen2.5:14b", [{"role": "user", "content": "q"}]))
    check("completed", text == "x = 2")
    check("first retry stayed on the GPU",
          "num_gpu" not in c.bodies[1]["options"], c.bodies[1]["options"])
    check("moved on the second", c.bodies[2]["options"].get("num_gpu") == 0)

    print("a fault the CPU cannot fix still fails, and says so")
    c = FakeClient(VULKAN, gpu_only=False)       # broken everywhere
    p = provider(c)
    try:
        await collect(p._stream_chat("gemma3:4b", [{"role": "user", "content": "q"}],
                                     attempts=3))
        check("raises", False, "no error raised")
    except ProviderError as e:
        check("raises ProviderError", True)
        check("names the CPU it ended up on", "on the CPU" in str(e), str(e))
        # already on the CPU, so pointing at INKWISE_VISION_CPU would be noise
        check("does not suggest a setting that is already in effect",
              "INKWISE_VISION_CPU" not in str(e), str(e))
        check("gives a way out", "ollama serve" in str(e))
        check("keeps the real driver error", "device lost" in str(e), str(e))

    print("INKWISE_VISION_CPU=1 skips the first failure altogether")
    try:
        c = FakeClient(VULKAN)
        p = provider(c, cpu_first=True)
        text, _ = await collect(
            p._stream_chat("gemma3:4b", [{"role": "user", "content": "q"}]))
        check("worked first time", text == "x = 2")
        check("one attempt only", len(c.bodies) == 1, len(c.bodies))
    finally:
        op.config.VISION_CPU = False

    print("\nrunning out of memory: our own model goes before the user's apps")
    real_memory = op.resources.memory
    try:
        for name, free_before, free_after, expect_evict, expect_raise in [
            ("tight, but evicting ourselves is enough", 5.7, 16.7, True, False),
            ("plenty of room: nothing is disturbed", 20.0, 20.0, False, False),
            ("not even our own memory is enough", 3.5, 4.0, True, True),
        ]:
            # not provider(): that helper stubs _guard out, which is the one
            # thing these cases are about
            p = op.OllamaProvider("gemma3:4b", "qwen2.5:14b")
            loaded = {"qwen2.5:14b"}
            evicted = []
            p._sizes = {"gemma3:4b": 3_100_000_000, "qwen2.5:14b": 10_000_000_000}

            async def _loaded(_l=loaded):
                return set(_l)

            async def _ensure():
                return True

            async def _unload(m=None, _l=loaded, _e=evicted):
                _l.discard(m)
                _e.append(m)
                return {}

            async def _wait_gone(m):
                return None

            p._loaded, p._ensure_server = _loaded, _ensure
            p.unload, p._wait_gone = _unload, _wait_gone
            op.resources.memory = lambda _l=loaded, a=free_before, b=free_after: {
                "total_gb": 31.5, "free_gb": a if _l else b}

            print(f"  {name}")
            raised = None
            try:
                await p._guard("gemma3:4b")
            except op.InsufficientMemory as e:
                raised = e
            check("    evicted the other stage" if expect_evict
                  else "    left the other stage alone",
                  bool(evicted) == expect_evict, evicted)
            check("    refused the load" if expect_raise else "    allowed the load",
                  (raised is not None) == expect_raise, str(raised))
            if expect_raise:
                check("    and still says what to do", "Close some applications"
                      in str(raised))
    finally:
        op.resources.memory = real_memory

    print("\n" + ("ALL PASSED" if not fails else f"{fails} FAILED"))
    return 1 if fails else 0


sys.exit(asyncio.run(main()))
