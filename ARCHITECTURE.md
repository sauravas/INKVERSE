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
