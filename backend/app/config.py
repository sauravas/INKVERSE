import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]

# Settings may live in a .env next to the project (see .env.example). Values
# already set in the real environment win, so a shell override still works.
try:
    from dotenv import load_dotenv
    load_dotenv(ROOT / ".env", override=False)
except ImportError:  # pragma: no cover - python-dotenv ships with uvicorn[standard]
    pass
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
# Context size. Measured: reading the prompt costs 0.1-0.6s out of a ~50s
# answer, so shrinking this buys nothing - and because num_ctx is a load-time
# parameter, *changing* it between requests forces a full 15s reload. Keep it
# one value for every request type.
OLLAMA_NUM_CTX = int(os.getenv("INKWISE_NUM_CTX", "8192"))
# gemma4 defaults thinking ON, which roughly triples latency. Off unless asked.
OLLAMA_THINK = os.getenv("INKWISE_THINK", "0") == "1"
# How long a model stays in memory after a request. Loading the 14b takes
# about 15 seconds on this machine, which is the whole of the wait before an
# answer starts, so letting it fall out of memory between questions is the
# most expensive setting in the file.
OLLAMA_KEEP_ALIVE = os.getenv("INKWISE_KEEP_ALIVE", "60m")

# RAM guard: refuse to load a model that would leave less than this free.
MIN_FREE_RAM_GB = float(os.getenv("INKWISE_MIN_FREE_RAM_GB", "3.0"))
RAM_GUARD = os.getenv("INKWISE_RAM_GUARD", "1") == "1"

# Keep only one pipeline stage resident at a time. Required on shared-memory
# GPUs, where vision + text co-resident crashes the runner during image
# encoding. Set to 0 if you have enough VRAM to keep both warm.
EXCLUSIVE_MODELS = os.getenv("INKWISE_EXCLUSIVE_MODELS", "1") == "1"

# When the text model will not fit in free memory, answer with the (smaller)
# vision model and say so, rather than failing the request.
LOW_MEMORY_FALLBACK = os.getenv("INKWISE_LOW_MEMORY_FALLBACK", "1") == "1"
# Start Ollama automatically if it is not running (once a minute at most).
AUTOSTART_OLLAMA = os.getenv("INKWISE_AUTOSTART_OLLAMA", "1") == "1"

# Run the vision stage on the CPU from the start. Some graphics drivers (the
# Intel Arc iGPU here) lose the device while encoding a page image, which kills
# the model runner; INKWISE detects that and moves the model across on its own,
# so this is only needed to skip the first failure.
VISION_CPU = os.getenv("INKWISE_VISION_CPU", "0") == "1"

# Leave the GPU to the screen. On a laptop with integrated graphics the model
# and the display are the same chip, and a model that fills it can make the
# desktop tear, shimmer or flash while it works - something no amount of work
# in the browser can fix, because it happens below it. Setting this runs both
# stages on the CPU: slower answers, a steady screen.
CPU_ONLY = os.getenv("INKWISE_CPU_ONLY", "0") == "1"

# Longest side of the page image sent to the vision model. Smaller images mean
# smaller encoder allocations, which is what the driver above chokes on.
VISION_MAX_SIDE = int(os.getenv("INKWISE_VISION_MAX_SIDE", "1100"))

# Read numeric questions twice and flag disagreement. Costs a second vision
# pass (a few seconds) and catches misread coefficients, which are otherwise
# invisible and invalidate the whole solution.
VERIFY_MATH = os.getenv("INKWISE_VERIFY_MATH", "1") == "1"

# Gemini is opt-in and never receives notebook content without explicit consent.
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL = os.getenv("INKWISE_GEMINI_MODEL", "gemini-2.5-flash")
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models"

# --- web search --------------------------------------------------------------
# Tavily is a search API built for LLMs: one request returns ranked, already
# summarised results. Optional - without a key, INKWISE falls back to Wikipedia
# and DuckDuckGo, which need no account. The key is read from the environment
# and is never written to disk or returned by any endpoint.
TAVILY_API_KEY = os.getenv("TAVILY_API_KEY", "")
TAVILY_URL = "https://api.tavily.com/search"
# basic (fast, cheap) or advanced (slower, better for exam-style questions)
TAVILY_DEPTH = os.getenv("INKWISE_TAVILY_DEPTH", "basic")
TAVILY_MAX_RESULTS = int(os.getenv("INKWISE_TAVILY_RESULTS", "5"))

REQUEST_TIMEOUT = float(os.getenv("INKWISE_TIMEOUT", "900"))

# --- voice (whisperflow sidecar) ---------------------------------------------
# whisperflow runs in its own environment (speech/.venv, Python 3.11) because it
# pins its own FastAPI and needs PyTorch; INKWISE relays audio to it.
SPEECH_URL = os.getenv("INKWISE_SPEECH_URL", "ws://127.0.0.1:8181/ws")
SPEECH_PYTHON = os.getenv("INKWISE_SPEECH_PYTHON",
                          str(ROOT / "speech" / ".venv" / "Scripts" / "python.exe"))
AUTOSTART_SPEECH = os.getenv("INKWISE_AUTOSTART_SPEECH", "1") == "1"

# --- importing ---------------------------------------------------------------
# Path to tesseract.exe. Auto-detected in the usual install locations if unset.
TESSERACT_CMD = os.getenv("INKWISE_TESSERACT", "")
