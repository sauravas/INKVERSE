from __future__ import annotations
from typing import AsyncIterator, Protocol


class AIProvider(Protocol):
    name: str
    requires_consent: bool

    async def health(self) -> dict: ...

    async def extract(self, image_b64: str, hint: str = "") -> dict:
        """Return {question, subject_guess, diagram, confidence, latency_s}."""
        ...

    def solve(self, question: str, subject: str = "") -> AsyncIterator[str]:
        """Yield raw model text chunks. Parsing happens in the router."""
        ...

    def explain(self, question: str, answer: str, step: str, ask: str) -> AsyncIterator[str]:
        ...


class ProviderError(RuntimeError):
    pass
