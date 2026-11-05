"""Optional Gemini provider.

Opt-in only. The key is read from the GEMINI_API_KEY environment variable and is
never written to disk or returned by any endpoint. Notebook images are only sent
here when the request carries an explicit user consent flag — see routers/ai.py.
"""
from __future__ import annotations

import json
import time
from typing import AsyncIterator

import httpx

from .. import config, obs
from .base import ProviderError
from . import prompts


class GeminiProvider:
    name = "gemini"
    requires_consent = True

    def __init__(self, model: str | None = None):
        self.model = model or config.GEMINI_MODEL

    @property
    def _key(self) -> str:
        key = config.GEMINI_API_KEY
        if not key:
            raise ProviderError(
                "GEMINI_API_KEY is not set. Export it in the environment to enable "
                "the Gemini provider; it is never stored by INKWISE.")
        return key

    async def health(self) -> dict:
        if not config.GEMINI_API_KEY:
            return {"ok": False, "provider": "gemini", "model": self.model,
                    "detail": "GEMINI_API_KEY not set"}
        return {"ok": True, "provider": "gemini", "model": self.model,
                "detail": "key present (not validated until first use)"}

    async def _stream(self, system: str, parts: list[dict],
                      *, temp=0.3, max_tokens=2048,
                      schema: dict | None = None) -> AsyncIterator[str]:
        cfg: dict = {"temperature": temp, "maxOutputTokens": max_tokens}
        if schema is not None:
            cfg["responseMimeType"] = "application/json"
            cfg["responseSchema"] = schema
        body = {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": parts}],
            "generationConfig": cfg,
        }
        url = (f"{config.GEMINI_URL}/{self.model}:streamGenerateContent?alt=sse")
        obs.emit("model.call", f"{self.model} (cloud, user consented)",
                 model=self.model, warm=True, provider="gemini")
        try:
            async with httpx.AsyncClient(timeout=config.REQUEST_TIMEOUT) as c:
                async with c.stream("POST", url, json=body,
                                    headers={"x-goog-api-key": self._key}) as r:
                    if r.status_code >= 400:
                        detail = (await r.aread()).decode()[:300]
                        raise ProviderError(f"Gemini {r.status_code}: {detail}")
                    async for line in r.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        payload = line[5:].strip()
                        if not payload or payload == "[DONE]":
                            continue
                        d = json.loads(payload)
                        for cand in d.get("candidates", []):
                            for p in (cand.get("content") or {}).get("parts", []):
                                if p.get("text"):
                                    yield p["text"]
        except httpx.RequestError as e:
            raise ProviderError(f"Cannot reach Gemini: {e}") from e

    async def extract(self, image_b64: str, hint: str = "",
                      verify: bool | None = None) -> dict:
        t0 = time.perf_counter()
        user = prompts.EXTRACT_USER + (f"\nStudent hint: {hint}\n" if hint else "")
        acc = []
        async for piece in self._stream(
            prompts.EXTRACT_SYSTEM,
            [{"text": user},
             {"inlineData": {"mimeType": "image/png", "data": image_b64}}],
            temp=0.1, max_tokens=800,
        ):
            acc.append(piece)
        data = prompts.parse_extraction("".join(acc))
        data.update({
            "latency_s": round(time.perf_counter() - t0, 2),
            "provider": self.name, "model": self.model,
            "stage": "vision",
        })
        return data

    async def reread(self, image_b64: str) -> dict:
        """An independent second reading, used by the Verifier agent."""
        acc = []
        async for piece in self._stream(
            prompts.EXTRACT_SYSTEM,
            [{"text": prompts.VERIFY_USER},
             {"inlineData": {"mimeType": "image/png", "data": image_b64}}],
            temp=0.0, max_tokens=800,
        ):
            acc.append(piece)
        return prompts.parse_extraction("".join(acc))

    def solve(self, question: str, subject: str = "") -> AsyncIterator[str]:
        sl = f"Subject: {subject}\n\n" if subject else ""
        return self._stream(prompts.SOLVE_SYSTEM,
                            [{"text": prompts.SOLVE_USER.format(
                                question=question, subject_line=sl)}],
                            max_tokens=2048)

    def explain(self, question: str, answer: str, step: str, ask: str) -> AsyncIterator[str]:
        return self._stream(prompts.EXPLAIN_SYSTEM,
                            [{"text": prompts.EXPLAIN_USER.format(
                                question=question, answer=answer[:6000],
                                step=step, ask=ask)}],
                            max_tokens=900)
