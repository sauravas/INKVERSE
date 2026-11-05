"""Incremental parser: model text stream -> typed structured events.

Enforces constraint 2 (ARCHITECTURE.md). React receives only the events this
module emits; raw model output never leaves the backend. Malformed model output
degrades to a single "Solution" step rather than leaking markup.
"""
from __future__ import annotations

import re

STEP_RE = re.compile(r"^\s*@@STEP\b[:\-]?\s*(.*)$")
FINAL_RE = re.compile(r"^\s*@@FINAL\b[:\-]?\s*(.*)$")

# Models disagree on math delimiters: qwen2.5 emits \( \) and \[ \], gemma and
# most others use $ and $$. Both are accepted. Display forms are matched first
# so they win over the inline forms.
MATH_RE = re.compile(
    r"\$\$(?P<d1>.+?)\$\$"          # $$ ... $$
    r"|\\\[(?P<d2>.+?)\\\]"         # \[ ... \]
    r"|\\\((?P<i1>.+?)\\\)"         # \( ... \)
    r"|\$(?P<i2>[^$\n]+?)\$",       # $ ... $
    re.S,
)
DISPLAY_GROUPS = ("d1", "d2")
INLINE_GROUPS = ("i1", "i2")

# strip markdown the model may emit despite instructions
CLEAN_RE = re.compile(r"^\s{0,3}#{1,6}\s*|^\s*```.*$|\*\*", re.M)

DISPLAY_OPENERS = (("$$", "$$"), (r"\[", r"\]"))


class StepStreamParser:
    """Feed it text chunks, collect typed events.

    Events:
      {"type":"step_open","index":int,"title":str,"final":bool}
      {"type":"segment","index":int,"kind":"text"|"math"|"break","value":str,"display":bool}
      {"type":"step_close","index":int}
    """

    def __init__(self):
        self.buf = ""
        self.index = 0
        self.open = False
        self.in_display = False       # inside a multi-line display block
        self.display_close = "$$"     # delimiter that will close it
        self.display_acc: list[str] = []
        self.plain = []               # accumulated raw text, for persistence

    # -- public ------------------------------------------------------------
    def feed(self, chunk: str) -> list[dict]:
        self.plain.append(chunk)
        self.buf += chunk
        out: list[dict] = []
        while True:
            nl = self.buf.find("\n")
            if nl < 0:
                break
            line, self.buf = self.buf[:nl], self.buf[nl + 1:]
            out.extend(self._line(line))
        return out

    def finish(self) -> list[dict]:
        out: list[dict] = []
        if self.buf.strip():
            out.extend(self._line(self.buf))
        self.buf = ""
        if self.in_display and self.display_acc:
            out.append(self._math("\n".join(self.display_acc), True))
            self.display_acc, self.in_display = [], False
        if self.open:
            out.append({"type": "step_close", "index": self.index})
            self.open = False
        return out

    def text(self) -> str:
        return "".join(self.plain)

    # -- internals ---------------------------------------------------------
    def _open_step(self, title: str, final: bool = False) -> list[dict]:
        out = []
        if self.open:
            out.append({"type": "step_close", "index": self.index})
        self.index += 1
        self.open = True
        out.append({"type": "step_open", "index": self.index,
                    "title": title.strip(), "final": final})
        return out

    def _math(self, value: str, display: bool) -> dict:
        return {"type": "segment", "index": self.index, "kind": "math",
                "value": (value or "").strip(), "display": display}

    def _text(self, value: str) -> dict:
        return {"type": "segment", "index": self.index, "kind": "text",
                "value": value, "display": False}

    def _line(self, raw: str) -> list[dict]:
        out: list[dict] = []
        line = raw.rstrip("\r")

        # an open multi-line display block swallows everything until its closer
        if self.in_display:
            closer = self.display_close
            if closer in line:
                head, _, tail = line.partition(closer)
                self.display_acc.append(head)
                out.append(self._math("\n".join(self.display_acc), True))
                self.display_acc, self.in_display = [], False
                if tail.strip():
                    out.extend(self._inline(tail))
            else:
                self.display_acc.append(line)
            return out

        m = STEP_RE.match(line)
        if m:
            return self._open_step(m.group(1) or "Step")
        m = FINAL_RE.match(line)
        if m:
            return self._open_step(m.group(1).strip() or "Final answer", final=True)

        line = CLEAN_RE.sub("", line)
        if not line.strip():
            if self.open:
                out.append({"type": "segment", "index": self.index,
                            "kind": "break", "value": "", "display": False})
            return out

        if not self.open:
            out.extend(self._open_step("Solution"))

        # an unbalanced display opener starts a multi-line block
        for opener, closer in DISPLAY_OPENERS:
            if opener == "$$":
                unbalanced = line.count("$$") % 2 == 1
            else:
                unbalanced = line.count(opener) > line.count(closer)
            if unbalanced:
                head, _, tail = line.partition(opener)
                if head.strip():
                    out.extend(self._inline(head))
                self.in_display = True
                self.display_close = closer
                self.display_acc = [tail] if tail.strip() else []
                return out

        out.extend(self._inline(line))
        return out

    def _inline(self, line: str) -> list[dict]:
        out, pos = [], 0
        for m in MATH_RE.finditer(line):
            pre = line[pos:m.start()]
            if pre:
                out.append(self._text(pre))
            value, display = None, False
            for g in DISPLAY_GROUPS:
                if m.group(g) is not None:
                    value, display = m.group(g), True
                    break
            if value is None:
                for g in INLINE_GROUPS:
                    if m.group(g) is not None:
                        value = m.group(g)
                        break
            out.append(self._math(value, display))
            pos = m.end()
        tail = line[pos:]
        if tail:
            out.append(self._text(tail))
        out.append(self._text("\n"))
        return out


def events_to_steps(events: list[dict]) -> list[dict]:
    """Fold an event list into persisted step objects."""
    steps, cur = [], None
    for e in events:
        if e["type"] == "step_open":
            cur = {"index": e["index"], "title": e["title"],
                   "final": e.get("final", False), "segments": []}
            steps.append(cur)
        elif e["type"] == "segment" and cur is not None:
            cur["segments"].append({"kind": e["kind"], "value": e["value"],
                                    "display": e.get("display", False)})
    return steps
