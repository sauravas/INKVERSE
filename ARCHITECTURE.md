# INKWISE — binding architectural constraints

These are enforced, not aspirational. Any change that violates one is a bug.

## 1. Writing must never wait for AI
Stroke capture, canvas rendering and phone sync run on a path that touches no
model code. Pointer events -> local canvas -> WebSocket broadcast. Inference is
triggered only by an explicit user submit, runs async, and is cancellable.
A hung or missing Ollama must leave the notebook fully usable.

## 2. AI must never control the notebook UI
The model's raw output never reaches React. The backend parses the model stream
into **typed structured events** and emits those over SSE:

    {"type":"step_open","index":1,"title":"..."}
    {"type":"segment","index":1,"kind":"text"|"math","value":"..."}
    {"type":"step_close","index":1}
    {"type":"done","usage":{...}}

React decides layout, animation timing, selection and interaction. If the model
emits malformed structure the backend degrades it to a single prose step rather
than passing markup through.

## 3. Progress must be deterministic
Exam readiness, syllabus completion and recall accuracy are computed in SQL/Python
from real rows (question status, revision counts, recall attempts). The model is
never asked whether a student is ready. See `backend/app/readiness.py` — pure
functions, unit-testable, no network.

## Local-first, and its two deliberate exceptions
Everything runs on this machine by default. Two features can send data out, and
both are opt-in with an explicit prompt the first time:
- the Gemini provider (sends the handwritten page), and
- web search (sends the question text to Wikipedia and DuckDuckGo; never
  handwriting or imported notes).
Sharing notes never involves a server outside the LAN: it is a local link, or a
file the student hands over.

## Constraint 3 applies to the question bank too
Practice outcomes are chosen by the student (knew it / needed a hint / needed the
answer). Status and recall change by fixed rules in `routers/practice.py`. A
friend's imported notes start with zero progress, so they cannot inflate
readiness.
