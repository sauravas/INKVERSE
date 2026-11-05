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


class InsufficientMemory(ProviderError):
    """Loading the model would starve the machine (raised before any output)."""


class Notice(str):
    """A message for the student, yielded in-band by a provider stream.

    The router turns it into a typed "notice" event; it never reaches the
    answer parser, so it cannot end up written into the answer.
    """
