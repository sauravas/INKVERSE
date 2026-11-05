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
import time
from typing import AsyncIterator

import httpx

from .. import config, obs, resources
from . import prompts
from .base import ProviderError


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

    @property
    def staged(self) -> bool:
        return self.vision_model != self.text_model

    # -- infra -------------------------------------------------------------
    async def _tags(self) -> dict[str, int]:
        async with httpx.AsyncClient(timeout=5) as c:
            r = await c.get(f"{self.url}/api/tags")
            r.raise_for_status()
            return {m["name"]: m.get("size", 0) for m in r.json().get("models", [])}

    async def _loaded(self) -> set[str]:
        try:
            async with httpx.AsyncClient(timeout=5) as c:
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
            async with httpx.AsyncClient(timeout=20) as c:
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

    async def _guard(self, model: str):
        """Refuse to load a model that would starve the machine."""
        if not config.RAM_GUARD:
            return
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
            raise ProviderError(msg)

    async def unload(self, model: str | None = None) -> dict:
        """Evict a model from memory immediately."""
        targets = [model] if model else sorted(await self._loaded())
        done = []
        async with httpx.AsyncClient(timeout=30) as c:
            for m in targets:
                try:
                    await c.post(f"{self.url}/api/generate",
                                 json={"model": m, "keep_alive": 0})
                    done.append(m)
                except Exception:
                    pass
        return {"unloaded": done, "memory": resources.memory()}

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
            "eof", "broken pipe", "runner", "timed out waiting for llama"))

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
        # only models that advertise thinking may be sent the flag at all
        if "thinking" in await self.capabilities(model):
            body["think"] = config.OLLAMA_THINK if think is None else think
        if fmt is not None:
            body["format"] = fmt

        last = ""
        for attempt in range(attempts):
            produced = False
            try:
                async with httpx.AsyncClient(timeout=config.REQUEST_TIMEOUT) as c:
                    async with c.stream("POST", f"{self.url}/api/chat",
                                        json=body) as r:
                        if r.status_code >= 400:
                            last = (await r.aread()).decode()[:300]
                            if not (self._is_runner_crash(last)
                                    and attempt < attempts - 1):
                                raise ProviderError(
                                    f"Ollama {r.status_code}: {last}")
                        else:
                            async for line in r.aiter_lines():
                                if not line.strip():
                                    continue
                                d = json.loads(line)
                                if d.get("error"):
                                    last = str(d["error"])
                                    if (self._is_runner_crash(last)
                                            and not produced
                                            and attempt < attempts - 1):
                                        break
                                    raise ProviderError(last)
                                piece = (d.get("message") or {}).get("content")
                                if piece:
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

            # The runner died before emitting anything. On this hardware
            # (shared-memory iGPU) the crash is often a transient driver fault
            # rather than a resource problem, and unload+reload of the SAME
            # model sometimes clears it, sometimes not - so back off longer on
            # each attempt rather than hammering a wedged driver. Only the
            # model actually in use is evicted, not whatever the other stage
            # has loaded (a concurrent request may depend on that).
            obs.emit("model.retry",
                     f"{model} runner crashed - retry {attempt + 2}/{attempts}",
                     level="warn", model=model, detail=obs.preview(last, 120))
            await asyncio.sleep(2.5 * (attempt + 1))
            try:
                await self.unload(model)
            except Exception:
                pass

        raise ProviderError(
            f"{model} crashed {attempts} times in a row on this machine's GPU "
            "driver and could not recover. This is usually transient - wait a "
            "few seconds and press Solve again. If it keeps happening, switch "
            "to the \"heavy\" provider or restart `ollama serve`.")

    # -- stage 1: vision ---------------------------------------------------
    async def _read_once(self, image_b64: str, user: str, temp: float) -> dict:
        acc = []
        async for piece in self._stream_chat(
            self.vision_model,
            [{"role": "system", "content": prompts.EXTRACT_SYSTEM},
             {"role": "user", "content": user, "images": [image_b64]}],
            num_predict=600, temp=temp,
        ):
            acc.append(piece)
        return prompts.parse_extraction("".join(acc))

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
    def solve(self, question: str, subject: str = "") -> AsyncIterator[str]:
        sl = f"Subject: {subject}\n\n" if subject else ""
        return self._stream_chat(
            self.text_model,
            [{"role": "system", "content": prompts.SOLVE_SYSTEM},
             {"role": "user", "content": prompts.SOLVE_USER.format(
                 question=question, subject_line=sl)}],
            num_predict=2048, temp=0.3, think=False)

    def explain(self, question: str, answer: str, step: str,
                ask: str) -> AsyncIterator[str]:
        return self._stream_chat(
            self.text_model,
            [{"role": "system", "content": prompts.EXPLAIN_SYSTEM},
             {"role": "user", "content": prompts.EXPLAIN_USER.format(
                 question=question, answer=answer[:6000], step=step, ask=ask)}],
            num_predict=900, temp=0.3, think=False)
