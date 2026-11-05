# INKWISE

A local-first handwriting study workspace. Write a question with a stylus, finger
or phone S Pen; the app reads it, solves it, and writes the solution back out by
hand on notebook paper. Progress is tracked deterministically, so "EXAM READY"
means something.

Everything runs on your machine. The cloud provider is optional, off by default,
and never receives anything without an explicit confirmation.

---

## Quick start

```powershell
# one command: builds the frontend if needed, then serves app + API + WebSocket
.\start.ps1
```

Open <http://localhost:8000>. For the phone, click **Connect phone** and scan.

Requirements: Python 3.11+, Node 18+, and [Ollama](https://ollama.com) running
with the two models below already pulled.

```powershell
ollama pull gemma3:4b      # 3.3 GB - reads handwriting
ollama pull qwen2.5:14b    # 9.0 GB - solves the question
```

Dev mode (Vite on :5173 with hot reload, API on :8000):

```powershell
.\start.ps1 -Dev
```

---

## How the AI is wired

INKWISE uses a **two-stage local pipeline** rather than one large model:

```
handwritten page ──> gemma3:4b (vision) ──> question text ──> qwen2.5:14b ──> solution
                      transcribe only                          reason only
```

This was a measured decision, not a preference. The original plan was a single
26B model doing both jobs. Benchmarked on the target machine (Intel Arc 140V,
32 GB shared RAM):

| | gemma4:26b (one model) | gemma3:4b + qwen2.5:14b |
|---|---|---|
| cold load | 219 s | ~15 s + ~40 s |
| one vision read | 270 s total | ~20 s warm |
| resident RAM | 18 GB (4.4 GB free → machine thrashes) | ~12 GB combined |
| handwriting accuracy | better on messy math | good on text, weaker on math |

Full numbers in [`bench/RESULTS.md`](bench/RESULTS.md). gemma4:26b is still
available as an opt-in **"Local high accuracy (slow)"** provider when a question
is worth the wait.

Because the small vision model does misread mathematics sometimes, the
transcription is **always shown for you to correct before solving**. That review
step is not optional polish; it is how the accuracy gap is absorbed.

**Numbers are read twice.** A misread coefficient (`4x^2` seen as `2x^2`) is the
worst failure here: it is invisible in the answer and invalidates every step
after it. Any question containing digits is therefore transcribed a second time,
independently. If the two readings disagree, confidence is capped and *both* are
put in front of you to choose between. This costs a second vision pass; set
`INKWISE_VERIFY_MATH=0` to turn it off.

**Stages are exclusive.** On a 16 GB shared GPU the two models fit individually
but not together — the vision encoder's buffers push it over and the runner is
killed mid-request. INKWISE evicts the other stage before running one, which
trades a model reload for not crashing. Runner crashes are also retried
automatically. See `bench/RESULTS.md`.

### Switching providers

Pick from the dropdown in the top bar, or set `INKWISE_PROVIDER`:

- `local` *(default)* — the two-stage pipeline above.
- `heavy` — gemma4:26b for both stages. Slow, high RAM, better at math.
- `gemini` — Google Gemini. Requires `GEMINI_API_KEY` in the environment, and
  prompts for confirmation before the first upload. Nothing is sent otherwise.

A **RAM guard** refuses to load a model that would leave less than
`INKWISE_MIN_FREE_RAM_GB` (default 3 GB) free, with a message instead of a frozen
laptop. The top bar shows free RAM and an **unload** button.

See [`.env.example`](.env.example) for every setting.

---

## Agents and orchestration

INKWISE runs **five agents**, each with exactly one job. A sixth, the
Examiner, is registered as *planned* and is never called.

| Agent | Job | Backed by | Called when |
|---|---|---|---|
| **Reader** | Transcribe the handwritten page into an editable question | vision model | Solve is pressed; or the Explainer gets a handwritten follow-up |
| **Verifier** | Read the page again, independently, and flag disagreement | vision model | the Reader's question contains digits or maths |
| **Tutor** | Stream a step-by-step solution | text model | the student confirms the question |
| **Explainer** | Explain one selected step, never the whole answer again | text model | the student asks about a step |
| **Mentor** | Exam readiness and the named blockers | rules over SQLite, **no model** | the dashboard opens |
| Examiner *(planned)* | Mark the student's own handwritten attempt | text model | not built yet |

**The orchestrator is code, not a model.** Routing is deterministic: no LLM
decides which agent runs. The orchestrator ([`backend/app/agents.py`](backend/app/agents.py),
called from [`routers/ai.py`](backend/app/routers/ai.py)) owns:

- the **consent gate**: a cloud provider is refused until the student consents
- **blank-page and crop** checks before any model is touched
- **routing and hand-offs**:
  - read = Reader -> Verifier (if digits) -> student review
  - solve = Tutor -> parser -> typed events
  - ask = Reader (if handwritten) -> Explainer
  - dashboard = Mentor
- **model scheduling**, through the provider: one stage resident at a time,
  RAM guard, crash retry

```
Student --> Orchestrator --+--> Reader --(digits)--> Verifier    vision model
 (canvas,   (code: consent, |       ^
  phone)     crop, routing, +--> Tutor                            text model
             scheduling)    +--> Explainer --(handwritten ask)    text model
                            +--> Mentor                           SQLite, rules
                            +..> Examiner (planned)
```

### Live observability

Every request is one **run** (a trace id). Each agent invocation inside it is a
**span**. Runs, spans, routing decisions, model calls (warm or cold),
evictions, retries, RAM-guard blocks and consent blocks are emitted as typed
events by [`backend/app/obs.py`](backend/app/obs.py). The buffer is in memory
and bounded. Events carry only short previews of questions, never images.

| Endpoint | What |
|---|---|
| `GET /api/obs/agents` | agent count, graph edges, the models behind each stage, per-agent call stats |
| `GET /api/obs/stream` | server-sent events: recent buffer replayed, then live |
| `GET /api/obs/recent` | the buffer as JSON |

In the notebook, the empty desk space beside the page shows them:

- **left margin**:
  - the orchestration graph. Nodes pulse while running and edges animate along
    the route taken.
  - a **per-agent activity** table: calls, errors, average and last latency.
    Click an agent for its role, who calls it and its last result.
  - the model scheduler: which model is resident in memory right now.
- **right margin, top**: **Live flow**, the current request step by step. Each
  orchestration step shows done ✓, running ● (with an elapsed timer), skipped
  (with the reason, e.g. "no digits - verification not needed") or failed.
  Click any run header in the log to pin that run here.
- **right margin, bottom**: the live agent log, grouped by run. Click a graph
  node to filter it to one agent.

On a window too narrow for side margins, both open from an **Agents** button
instead.

---

## The three rules this is built on

Spelled out in [`ARCHITECTURE.md`](ARCHITECTURE.md), and enforced:

1. **Writing never waits for AI.** Stroke capture, rendering and phone sync share
   no code path with inference. Kill Ollama mid-session and the notebook keeps
   working; only the Solve button reports an error.
2. **The AI never controls the UI.** The model's raw text stops at the backend,
   which parses it into typed events (`step_open`, `segment{kind:text|math}`)
   streamed over SSE. React decides all layout and animation. Malformed model
   output degrades to a single prose step rather than leaking markup.
3. **Progress is deterministic.** Readiness is computed in
   [`backend/app/readiness.py`](backend/app/readiness.py) — pure functions over
   question rows. The model is never asked whether you are ready.

---

## Features

**Notebook** — pressure-sensitive canvas over Pointer Events, with coalesced-event
capture for full stylus sample rate, velocity-based width when a device reports no
pressure, palm rejection while a pen is in use, stylus-eraser-button support,
highlighter, per-author undo/redo, multiple pages.

**Phone companion** — scan the QR, and the phone becomes a second pen on the *same*
page. The server holds authoritative page state, so a phone joining late receives
the full snapshot. Measured relay latency 0.3 ms, ~25,000 messages/sec locally.

**Reading your handwriting** — the page is cropped to its ink bounding box before
being sent to the model (a typical page shrinks from 1240×1754 to about 594×377),
which cuts prefill cost substantially. Inference is triggered on submit, never per
stroke.

**Handwritten answers, on the page** — the solution is written down the same
ruled sheet, directly below your question, not in a chat panel. Every character
gets a small deterministic wobble in angle, baseline and ink weight, because
uniform glyphs are what make a handwriting font look machine-made. Mathematics
is typeset with KaTeX. The writing animation runs on its own clock and simply
writes faster when the model gets ahead, so inference latency never stutters
the text.

**Ask about one step** — select any step, write or type a follow-up beside it, and
get an explanation of *that step only*. The original question, the full answer and
the selected step go along as context; the answer is not regenerated.

**Dashboard** — subjects → modules → questions, each Pending / Studied / Revised /
Mastered, with important flags and active-recall logging. EXAM READY appears only
when syllabus coverage, important-question mastery and recall accuracy all clear
their thresholds, and every failure is listed as a named blocker.

---

## Layout

```
backend/app/
  main.py          FastAPI app, WebSocket endpoint, serves the built frontend
  agents.py        the five agents, topology, orchestration flows
  obs.py           observability event bus (runs, spans, model events)
  readiness.py     deterministic progress maths (pure, no I/O)
  ws.py            shared-workspace stroke sync hub
  imaging.py       ink-bbox cropping before vision
  resources.py     RAM guard
  ai/
    registry.py    provider selection
    ollama_provider.py   two-stage local pipeline + model scheduling
    gemini_provider.py   optional cloud provider
    parser.py      model stream -> typed events
    prompts.py
  routers/         ai, study, notebook, pair, obs
frontend/src/
  lib/ink.js       stroke geometry, pressure, rendering, PNG export
  lib/sync.js      WebSocket client with backoff
  lib/obs.js       live agent feed (SSE) and derived graph state
  components/      InkCanvas, AnswerSheet, Dashboard, MiniPad, PairPanel,
                   AgentRails (agent graph + log in the page margins)
bench/             benchmarks and end-to-end tests
```

---

## Tests

With the backend running on :8000:

```powershell
.\.venv\Scripts\python.exe bench\test_parser.py     # stream parser, chunk-boundary safety
.\.venv\Scripts\python.exe bench\test_agents.py     # orchestration + observability (no server, no Ollama)
.\.venv\Scripts\python.exe bench\test_sync.py       # two clients, one workspace
.\.venv\Scripts\python.exe bench\seed_demo.py       # readiness rules + demo data
.\.venv\Scripts\python.exe bench\test_pipeline.py   # full AI pipeline (needs Ollama)
node frontend\shot.mjs                              # screenshots all three screens
```

---

## Troubleshooting

**Phone cannot open the page.** Both devices must be on the same Wi-Fi, and
Windows Firewall must allow port 8000 on private networks. If the QR shows the
wrong address, set `INKWISE_PUBLIC_HOST` to the right LAN IP.

**"Not enough free memory to load this model."** The RAM guard is doing its job.
Unload from the top bar, close something, or switch to the `local` provider.

**Ollama 500 / connection forcibly closed.** The model runner crashed. Usually a
model being sent a parameter it does not support; INKWISE queries
`/api/show` and only sends `think` to models that advertise it. If it persists,
restart `ollama serve`.

**Maths transcribed wrongly.** Expected sometimes with the 4B vision model. The
double-read catches many cases and will show you both readings; otherwise fix it
in the review box before solving, or switch to the `heavy` provider.

**Transcription feels slow (around a minute).** Two things are in play: the
verification pass doubles the vision work, and stage exclusivity means a model
reload between transcribing and solving. Set `INKWISE_VERIFY_MATH=0` and/or
`INKWISE_EXCLUSIVE_MODELS=0` (the latter only if you have spare VRAM).

---

## Planned next

- **Web search** so answers can draw on current information.
- **RAG over your own syllabus** — import module notes and past papers, and
  ground answers in them.
- **Two notebooks**: the current free-form one, plus a question-bank notebook
  that shows a prewritten question, lets you attempt it first, offers AI help
  only if you want it, and keeps your annotated attempts as revision notes.
