"""Local Ollama provider: a two-stage orchestrated pipeline.

Stage 1 (vision)    a small vision model transcribes the handwritten page.
Stage 2 (reasoning) a stronger text model solves the transcribed question.

Splitting the job lets each stage use a model sized for it. On the benchmark
machine that is gemma3:4b + qwen2.5:14b (~12 GB combined) instead of gemma4:26b
doing both (18 GB resident, 219 s cold load). Set vision_model == text_model to
collapse this back to a single model ("heavy" mode).
"""
from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import time
from pathlib import Path
from typing import AsyncIterator

import httpx

from .. import config, obs, resources
from . import http, prompts
from .base import InsufficientMemory, Notice, ProviderError


class OllamaProvider:
    name = "ollama"
    requires_consent = False

    def __init__(self, vision_model: str | None = None,
                 text_model: str | None = None, label: str = "local"):
        self.vision_model = vision_model or config.VISION_MODEL
        self.text_model = text_model or config.TEXT_MODEL
        self.label = label
        self.url = config.OLLAMA_URL
        self._sizes: dict[str, int] = {}
        self._caps: dict[str, set[str]] = {}
        # models pinned to the CPU because the GPU driver cannot run them here
        self._cpu_only: set[str] = set()
        if config.VISION_CPU:
            self._cpu_only.add(self.vision_model)
        # consecutive crashes per model, reset by a successful request
        self._crashes: dict[str, int] = {}

    @property
    def staged(self) -> bool:
        return self.vision_model != self.text_model

    # -- infra -------------------------------------------------------------
    async def _tags(self) -> dict[str, int]:
        async with http.session(5) as c:
            r = await c.get(f"{self.url}/api/tags")
            r.raise_for_status()
            return {m["name"]: m.get("size", 0) for m in r.json().get("models", [])}

    async def _loaded(self) -> set[str]:
        try:
            async with http.session(5) as c:
                r = await c.get(f"{self.url}/api/ps")
                r.raise_for_status()
                return {m["name"] for m in r.json().get("models", [])}
        except Exception:
            return set()

    async def capabilities(self, model: str) -> set[str]:
        """What the model actually supports.

        Sending `think` to a model without the thinking capability kills the
        Ollama runner outright (it does not return a clean error), so every
        optional flag is gated on this.
        """
        if model in self._caps:
            return self._caps[model]
        caps: set[str] = set()
        try:
            async with http.session(20) as c:
                r = await c.post(f"{self.url}/api/show", json={"model": model})
                r.raise_for_status()
                caps = set(r.json().get("capabilities") or [])
        except Exception:
            caps = set()          # unknown: send nothing optional
        self._caps[model] = caps
        return caps

    async def health(self) -> dict:
        mem = resources.memory()
        try:
            sizes = await self._tags()
            self._sizes = sizes
        except Exception as e:
            return {"ok": False, "provider": self.label, "stages": self._stages(),
                    "memory": mem, "models": [],
                    "detail": resources.serve_hint() if resources.ollama_installed()
                    else f"Ollama unreachable: {e}"}

        loaded = await self._loaded()
        missing = [m for m in {self.vision_model, self.text_model}
                   if m not in sizes]
        return {
            "ok": not missing,
            "provider": self.label,
            "stages": self._stages(),
            "cpu_only": sorted(self._cpu_only),
            "models": sorted(sizes),
            "loaded": sorted(loaded),
            "memory": mem,
            "sizes_gb": {m: round(sizes.get(m, 0) / 1024 ** 3, 1)
                         for m in {self.vision_model, self.text_model}},
            "detail": "" if not missing
            else f"Not pulled: {', '.join(missing)}. Run: ollama pull {missing[0]}",
        }

    def _stages(self) -> dict:
        return {"vision": self.vision_model, "text": self.text_model,
                "staged": self.staged}

    _start_lock = asyncio.Lock()
    _last_start = 0.0

    async def _alive(self) -> bool:
        try:
            async with httpx.AsyncClient(timeout=3) as c:
                return (await c.get(f"{self.url}/api/version")).status_code == 200
        except httpx.RequestError:
            return False

    async def _ensure_server(self) -> bool:
        """Start Ollama if it is not running, and wait until it answers.

        On this laptop the Ollama server has been seen to exit mid-session.
        Rather than fail every request until someone restarts it by hand, start
        it again: the desktop app where installed (it keeps a server log), else
        `ollama serve`. At most once a minute, and only on this machine.
        """
        if await self._alive():
            return True
        if not config.AUTOSTART_OLLAMA or not self.url.startswith(
                ("http://127.0.0.1", "http://localhost")):
            return False
        async with OllamaProvider._start_lock:
            if await self._alive():
                return True
            if time.monotonic() - OllamaProvider._last_start > 60:
                OllamaProvider._last_start = time.monotonic()
                exe = shutil.which("ollama")
                if not exe:
                    return False
                app = Path(exe).with_name("ollama app.exe")
                cmd = [str(app)] if app.is_file() else [exe, "serve"]
                flags = 0
                if os.name == "nt":
                    flags = (subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
                             | subprocess.CREATE_NO_WINDOW)
                subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                 stderr=subprocess.DEVNULL, creationflags=flags,
                                 close_fds=True)
            for _ in range(60):                      # up to ~30 s to come up
                await asyncio.sleep(0.5)
                if await self._alive():
                    self._sizes = {}                 # sizes may have changed
                    return True
        return False

    async def _wait_gone(self, model: str, timeout: float = 6.0):
        """After an unload, wait until the model has really left memory."""
        end = time.monotonic() + timeout
        while time.monotonic() < end and model in await self._loaded():
            await asyncio.sleep(0.25)
        await asyncio.sleep(0.4)          # give Windows a moment to reclaim pages

    async def _exclusive(self, model: str):
        """Keep only one stage resident at a time.

        On a shared-memory GPU the vision and text models fit individually but
        not together once the vision encoder allocates its image buffers - the
        runner is killed mid-request ("connection forcibly closed"). Evicting
        the other stage first turns a crash into a predictable reload.
        """
        if not (self.staged and config.EXCLUSIVE_MODELS):
            return
        other = self.text_model if model == self.vision_model else self.vision_model
        if other == model:
            return
        if other in await self._loaded():
            obs.emit("model.evict",
                     f"Evicting {other} so {model} can load (one stage at a time)",
                     model=other, for_model=model)
            await self.unload(other)
            # measuring free memory before the eviction lands would make the
            # RAM guard refuse a model that actually fits
            await self._wait_gone(other)

    async def _guard(self, model: str):
        """Refuse to load a model that would starve the machine."""
        if not config.RAM_GUARD:
            return
        if not await self._ensure_server():
            # with Ollama down, a memory verdict would be about the wrong thing
            raise ProviderError(resources.serve_hint())
        if model in await self._loaded():
            return                       # already resident, no new allocation
        if not self._sizes:
            try:
                self._sizes = await self._tags()
            except Exception:
                return
        size = self._sizes.get(model, 0)
        if not size:
            return
        ok, msg = resources.check(size, config.MIN_FREE_RAM_GB)
        if not ok:
            obs.emit("guard.block", msg, level="error", model=model)
            raise InsufficientMemory(msg)

    async def unload(self, model: str | None = None) -> dict:
        """Evict a model from memory immediately."""
        targets = [model] if model else sorted(await self._loaded())
        done = []
        async with http.session(30) as c:
            for m in targets:
                try:
                    await c.post(f"{self.url}/api/generate",
                                 json={"model": m, "keep_alive": 0})
                    done.append(m)
                except Exception:
                    pass
        return {"unloaded": done, "memory": resources.memory()}

    # Markers that name the GPU driver specifically. The Intel Arc iGPU loses
    # the Vulkan device while encoding an image ("ggml_vulkan: device lost on
    # Vulkan0" in Ollama's server.log), which kills the runner mid-request.
    _GPU_FAULT = ("device lost", "vulkan", "ggml_", "vk_error", "device_lost",
                  "out of device memory", "ggml_backend", "rocm", "hip error",
                  "cuda error")

    @staticmethod
    def _is_runner_crash(detail: str) -> bool:
        """Did the model runner die, as opposed to rejecting the request?

        On shared-memory GPUs the runner is occasionally killed mid-request and
        Ollama surfaces it as a 500 with a socket error. That is retryable; a
        400 about a bad parameter is not.
        """
        d = detail.lower()
        return any(s in d for s in (
            "forcibly closed", "error was encountered while running the model",
            "connection reset", "connection refused", "dial tcp", "health resp",
            "eof", "broken pipe", "runner", "timed out waiting for llama",
            *OllamaProvider._GPU_FAULT))

    @classmethod
    def _is_gpu_fault(cls, detail: str) -> bool:
        d = (detail or "").lower()
        return any(s in d for s in cls._GPU_FAULT)

    def _note_crash(self, model: str, detail: str) -> bool:
        """Record a crash and decide whether to stop using the GPU for it.

        Called from both retry loops so the rule is the same wherever the crash
        is noticed: a crash that names the graphics driver is not transient, and
        neither is a second consecutive crash. Returns True if this call moved
        the model to the CPU.
        """
        self._crashes[model] = self._crashes.get(model, 0) + 1
        if self._is_gpu_fault(detail) or self._crashes[model] >= 2:
            return self._on_gpu_fault(model, detail)
        return False

    def _on_gpu_fault(self, model: str, detail: str) -> bool:
        """Move a model onto the CPU after the GPU driver has dropped it.

        The vision stage is where this actually bites: encoding a page image
        allocates large Vulkan buffers and the driver loses the device, so the
        same request fails the same way however often it is retried. Running
        that one model with num_gpu=0 is slower but finishes, and the text
        stage keeps the GPU to itself. Set INKWISE_VISION_CPU=1 to start there.

        Returns True if this call changed the placement.
        """
        if model in self._cpu_only:
            return False
        self._cpu_only.add(model)
        obs.emit("model.cpu",
                 f"{model} moved to the CPU: this machine's GPU driver drops "
                 f"the device while running it. Slower, but it completes.",
                 level="warn", model=model, detail=obs.preview(detail, 160))
        return True

    async def _stream_chat(self, model: str, messages, *, num_predict=2048,
                           temp=0.3, fmt=None, think=None,
                           attempts=5) -> AsyncIterator[str]:
        await self._exclusive(model)
        await self._guard(model)
        warm = model in await self._loaded()
        obs.emit("model.call",
                 f"{model} {'warm' if warm else 'cold - loading into memory'}",
                 model=model, warm=warm, provider=self.label)
        body = {
            "model": model, "messages": messages, "stream": True,
            "keep_alive": config.OLLAMA_KEEP_ALIVE,
            "options": {"num_ctx": max(4096, config.OLLAMA_NUM_CTX),
                        "num_predict": num_predict,
                        "temperature": temp, "top_p": 0.95},
        }
        if model in self._cpu_only:
            # offload nothing to the GPU: the driver here cannot survive it
            body["options"]["num_gpu"] = 0
        # only models that advertise thinking may be sent the flag at all
        if "thinking" in await self.capabilities(model):
            body["think"] = config.OLLAMA_THINK if think is None else think
        if fmt is not None:
            body["format"] = fmt

        last = ""
        for attempt in range(attempts):
            produced = False
            # placement can change between attempts, so set it per request
            body["options"].pop("num_gpu", None)
            if model in self._cpu_only:
                body["options"]["num_gpu"] = 0
            try:
                async with http.session(config.REQUEST_TIMEOUT) as c:
                    async with c.stream("POST", f"{self.url}/api/chat",
                                        json=body) as r:
                        if r.status_code >= 400:
                            last = (await r.aread()).decode()[:300]
                            if not self._is_runner_crash(last):
                                raise ProviderError(
                                    f"Ollama {r.status_code}: {last}")
                        else:
                            async for line in r.aiter_lines():
                                if not line.strip():
                                    continue
                                d = json.loads(line)
                                if d.get("error"):
                                    last = str(d["error"])
                                    # tokens are already on screen: a restart
                                    # would duplicate them, so this one is fatal
                                    if produced or not self._is_runner_crash(last):
                                        raise ProviderError(last)
                                    break
                                piece = (d.get("message") or {}).get("content")
                                if piece:
                                    if not produced:
                                        self._crashes[model] = 0
                                    produced = True
                                    yield piece
                            if produced or not last:
                                return
            except httpx.RequestError as e:
                last = str(e)
                if produced or attempt == attempts - 1:
                    raise ProviderError(
                        resources.serve_hint() if resources.ollama_installed()
                        else f"Cannot reach Ollama at {self.url}: {e}") from e
                if isinstance(e, httpx.ConnectError) and await self._ensure_server():
                    continue                  # the server is back: retry at once

            if attempt == attempts - 1:
                break

            # The runner died before emitting anything. Unload and try again:
            # on this hardware (shared-memory iGPU) that sometimes clears a
            # transient driver fault, so back off a little longer each time
            # rather than hammering a wedged driver. Only the model in use is
            # evicted, not whatever the other stage has loaded. A crash the
            # driver will keep repeating moves the model onto the CPU instead.
            moved = self._note_crash(model, last)
            if moved:
                yield Notice(
                    f"The graphics driver dropped {model} part-way through, so "
                    f"it is running on the CPU instead. This is slower.")
            obs.emit("model.retry",
                     f"{model} runner crashed - retry {attempt + 2}/{attempts}"
                     + (" on the CPU" if moved else ""),
                     level="warn", model=model, detail=obs.preview(last, 120))
            await asyncio.sleep(0.5 if moved else 2.5 * (attempt + 1))
            try:
                await self.unload(model)
                await self._wait_gone(model)
            except Exception:
                pass

        raise ProviderError(self._exhausted(model, attempts, last))

    def _exhausted(self, model: str, attempts: int, detail: str) -> str:
        where = "on the CPU" if model in self._cpu_only else "on the GPU"
        extra = ("" if model in self._cpu_only else
                 " or set INKWISE_VISION_CPU=1 in .env to keep the page reader "
                 "off the graphics driver entirely")
        return (f"{model} crashed {attempts} times in a row {where} and could "
                f"not recover. Wait a few seconds and try again; if it keeps "
                f"happening, restart `ollama serve`{extra}. "
                f"(Last error: {obs.preview(detail, 160)})")

    # -- stage 1: vision ---------------------------------------------------
    async def _complete(self, model: str, messages, *, attempts=5,
                        **kw) -> str:
        """Buffered request that restarts from scratch on a runner crash.

        _stream_chat cannot retry once it has yielded tokens, because for
        solve/explain those tokens are already on the student's screen. A
        buffered caller has shown nothing yet, so a crash part-way through the
        reply is safe to retry - and on this hardware that is the common case:
        the vision runner often dies after emitting a few tokens.
        """
        last = ""
        for attempt in range(attempts):
            acc: list[str] = []
            try:
                async for piece in self._stream_chat(model, messages,
                                                     attempts=1, **kw):
                    if not isinstance(piece, Notice):
                        acc.append(piece)
                return "".join(acc)
            except ProviderError as e:
                last = str(e)
                if not self._is_runner_crash(last) or attempt == attempts - 1:
                    break
            # same placement rule as the streaming loop: a crash the driver
            # will repeat moves this model to the CPU for the next attempt
            moved = self._note_crash(model, last)
            await asyncio.sleep(0.5 if moved else 2.5 * (attempt + 1))
            try:
                await self.unload(model)
                await self._wait_gone(model)
            except Exception:
                pass
        if self._is_runner_crash(last):
            raise ProviderError(self._exhausted(model, attempts, last))
        raise ProviderError(last)

    async def _read_once(self, image_b64: str, user: str, temp: float) -> dict:
        raw = await self._complete(
            self.vision_model,
            [{"role": "system", "content": prompts.EXTRACT_SYSTEM},
             {"role": "user", "content": user, "images": [image_b64]}],
            num_predict=600, temp=temp,
        )
        return prompts.parse_extraction(raw)

    async def extract(self, image_b64: str, hint: str = "",
                      verify: bool | None = None) -> dict:
        """Transcribe the page, and on anything numeric, read it twice.

        A misread coefficient is the worst failure mode here: it is invisible in
        the answer and invalidates every step. A second independent reading does
        not fix the misread, but it reliably *detects* disagreement, which is
        enough to put the choice in front of the student.
        """
        t0 = time.perf_counter()
        user = prompts.EXTRACT_USER + (f"\nStudent hint: {hint}\n" if hint else "")
        data = await self._read_once(image_b64, user, temp=0.1)

        do_verify = (config.VERIFY_MATH if verify is None else verify)
        if do_verify and prompts.looks_mathematical(data.get("question", "")):
            data = prompts.merge_readings(data, await self.reread(image_b64))

        data.update({
            "latency_s": round(time.perf_counter() - t0, 2),
            "provider": self.label, "model": self.vision_model,
            "stage": "vision",
        })
        return data

    async def reread(self, image_b64: str) -> dict:
        """An independent second reading, used by the Verifier agent."""
        return await self._read_once(image_b64, prompts.VERIFY_USER, temp=0.0)

    # -- stage 2: reasoning ------------------------------------------------
    async def _text(self, messages, **kw) -> AsyncIterator[str]:
        """Run a text stage; if the text model will not fit, use the small one.

        A shorter answer from the small model is more use to a student than an
        error. The switch happens before any output (the RAM guard runs first),
        and the student is told which model answered.
        """
        try:
            async for piece in self._stream_chat(self.text_model, messages, **kw):
                yield piece
            return
        except InsufficientMemory as e:
            fallback = self.vision_model
            if not (config.LOW_MEMORY_FALLBACK and self.staged and fallback != self.text_model):
                raise
            why = str(e).split(". ")[0]
        yield Notice(f"{why}. Answering with the smaller {fallback} model instead, so "
                     "this may be less thorough - close some apps and ask again for "
                     "the full answer.")
        async for piece in self._stream_chat(fallback, messages, **kw):
            yield piece

    def solve(self, question: str, subject: str = "", context: str = "",
              session: list | None = None) -> AsyncIterator[str]:
        sl = f"Subject: {subject}\n\n" if subject else ""
        return self._text(
            [{"role": "system", "content": prompts.SOLVE_SYSTEM},
             {"role": "user", "content": prompts.SOLVE_USER.format(
                 question=question, subject_line=sl,
                 context_block=prompts.context_block(context),
                 session_block=prompts.session_block(session or []))}],
            num_predict=2048, temp=0.3, think=False)

    def explain(self, question: str, answer: str, step: str,
                ask: str, context: str = "",
                history: list | None = None, focus: str = "") -> AsyncIterator[str]:
        return self._text(
            [{"role": "system", "content": prompts.EXPLAIN_SYSTEM},
             {"role": "user", "content": prompts.EXPLAIN_USER.format(
                 question=question, answer=answer[:6000], step=step, ask=ask,
                 history_block=prompts.history_block(history or []),
                 focus_block=prompts.focus_block(focus),
                 context_block=prompts.context_block(context))}],
            num_predict=900, temp=0.3, think=False)

    def notes(self, subject: str, module: str, material: str = "",
              questions: list | None = None) -> AsyncIterator[str]:
        mb, qb = prompts.notes_material(material, questions or [])
        return self._text(
            [{"role": "system", "content": prompts.NOTES_SYSTEM},
             {"role": "user", "content": prompts.NOTES_USER.format(
                 subject=subject, module=module, material_block=mb, questions_block=qb)}],
            num_predict=2600, temp=0.3, think=False)

    def hint(self, question: str, context: str = "") -> AsyncIterator[str]:
        return self._text(
            [{"role": "system", "content": prompts.HINT_SYSTEM},
             {"role": "user", "content": prompts.HINT_USER.format(
                 question=question, context_block=prompts.context_block(context))}],
            num_predict=220, temp=0.4, think=False)
