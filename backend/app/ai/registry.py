from __future__ import annotations

from .. import config
from .base import ProviderError
from .gemini_provider import GeminiProvider
from .ollama_provider import OllamaProvider

_cache: dict[str, object] = {}

NAMES = ("local", "heavy", "gemini")


def get(name: str | None = None):
    """Resolve a provider. The local two-stage pipeline is the default."""
    name = (name or config.PROVIDER or "local").lower()
    if name == "ollama":          # back-compat alias
        name = "local"
    if name not in NAMES:
        raise ProviderError(f"Unknown provider {name!r}; expected one of {NAMES}")
    if name not in _cache:
        if name == "local":
            _cache[name] = OllamaProvider(config.VISION_MODEL,
                                          config.TEXT_MODEL, label="local")
        elif name == "heavy":
            _cache[name] = OllamaProvider(config.HEAVY_MODEL,
                                          config.HEAVY_MODEL, label="heavy")
        else:
            _cache[name] = GeminiProvider()
    return _cache[name]


def available() -> list[dict]:
    return [
        {
            "name": "local", "label": "Local pipeline", "default": True,
            "requires_consent": False, "configured": True,
            "vision": config.VISION_MODEL, "text": config.TEXT_MODEL,
            "note": "Small vision model transcribes, stronger text model solves.",
        },
        {
            "name": "heavy", "label": "Local high accuracy (slow)", "default": False,
            "requires_consent": False, "configured": True,
            "vision": config.HEAVY_MODEL, "text": config.HEAVY_MODEL,
            "note": "One large model does both. Minutes per question, high RAM.",
        },
        {
            "name": "gemini", "label": "Google Gemini (cloud)", "default": False,
            "requires_consent": True, "configured": bool(config.GEMINI_API_KEY),
            "vision": config.GEMINI_MODEL, "text": config.GEMINI_MODEL,
            "note": "Sends your notebook off this machine. Needs GEMINI_API_KEY.",
        },
    ]
