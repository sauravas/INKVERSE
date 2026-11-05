import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = Path(os.getenv("INKWISE_DATA", ROOT / "data"))
DATA_DIR.mkdir(parents=True, exist_ok=True)
DB_PATH = DATA_DIR / "inkwise.db"

HOST = os.getenv("INKWISE_HOST", "0.0.0.0")
PORT = int(os.getenv("INKWISE_PORT", "8000"))
# When the Vite dev server is used, the QR must point at it instead of FastAPI.
PUBLIC_PORT = int(os.getenv("INKWISE_PUBLIC_PORT", str(PORT)))
PUBLIC_HOST = os.getenv("INKWISE_PUBLIC_HOST", "")  # auto-detect LAN IP if blank

# --- AI providers -----------------------------------------------------------
PROVIDER = os.getenv("INKWISE_PROVIDER", "local")  # local | heavy | gemini
OLLAMA_URL = os.getenv("OLLAMA_URL", "http://127.0.0.1:11434")

# Two-stage local pipeline. A small vision model transcribes handwriting, a
# stronger text model does the reasoning. Benchmarked alternative (gemma4:26b
# doing both) needs 219s to load and 18GB resident - see bench/RESULTS.md.
VISION_MODEL = os.getenv("INKWISE_VISION_MODEL", "gemma3:4b")
TEXT_MODEL = os.getenv("INKWISE_TEXT_MODEL", "qwen2.5:14b")
# Opt-in single-model mode: accurate, slow, memory-hungry.
HEAVY_MODEL = os.getenv("INKWISE_HEAVY_MODEL", "gemma4:26b")
OLLAMA_MODEL = TEXT_MODEL  # back-compat alias
OLLAMA_NUM_CTX = int(os.getenv("INKWISE_NUM_CTX", "8192"))
# gemma4 defaults thinking ON, which roughly triples latency. Off unless asked.
OLLAMA_THINK = os.getenv("INKWISE_THINK", "0") == "1"
OLLAMA_KEEP_ALIVE = os.getenv("INKWISE_KEEP_ALIVE", "10m")

# RAM guard: refuse to load a model that would leave less than this free.
MIN_FREE_RAM_GB = float(os.getenv("INKWISE_MIN_FREE_RAM_GB", "3.0"))
RAM_GUARD = os.getenv("INKWISE_RAM_GUARD", "1") == "1"

# Keep only one pipeline stage resident at a time. Required on shared-memory
# GPUs, where vision + text co-resident crashes the runner during image
# encoding. Set to 0 if you have enough VRAM to keep both warm.
EXCLUSIVE_MODELS = os.getenv("INKWISE_EXCLUSIVE_MODELS", "1") == "1"

# Read numeric questions twice and flag disagreement. Costs a second vision
# pass (a few seconds) and catches misread coefficients, which are otherwise
# invisible and invalidate the whole solution.
VERIFY_MATH = os.getenv("INKWISE_VERIFY_MATH", "1") == "1"

# Gemini is opt-in and never receives notebook content without explicit consent.
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL = os.getenv("INKWISE_GEMINI_MODEL", "gemini-2.5-flash")
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models"

REQUEST_TIMEOUT = float(os.getenv("INKWISE_TIMEOUT", "900"))
