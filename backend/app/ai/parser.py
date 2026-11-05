"""Incremental parser: model text stream -> typed structured events.

Enforces constraint 2 (ARCHITECTURE.md). React receives only the events this
module emits; raw model output never leaves the backend. Malformed model output
degrades to a single "Solution" step rather than leaking markup.
"""
from __future__ import annotations

import re

from .diagram import parse_edge_list

STEP_RE = re.compile(r"^\s*@@STEP\b[:\-]?\s*(.*)$")
FINAL_RE = re.compile(r"^\s*@@FINAL\b[:\-]?\s*(.*)$")
DIAGRAM_RE = re.compile(r"^\s*@@DIAGRAM\b[:\-]?\s*(.*)$")
CODE_RE = re.compile(r"^\s*@@CODE\b[:\-]?\s*(.*)$")
MAX_CODE_LINES = 60
END_RE = re.compile(r"^\s*@@END\b")
# a Markdown pipe-table row; a table needs at least two columns to count
TABLE_ROW_RE = re.compile(r"^\s*\|.*\|\s*$")
TABLE_SEP_RE = re.compile(r"^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$")
MAX_TABLE_COLS = 12
MAX_TABLE_ROWS = 30


def parse_table(lines: list[str]) -> dict | None:
    """Rows of a pipe table -> {"header": [...], "rows": [[...]]}, or None."""
    rows: list[list[str]] = []
    header = None
    for raw in lines:
        if TABLE_SEP_RE.match(raw):
            if rows and header is None:
                header = rows.pop()
            continue
        body = raw.strip().strip("|").replace("\\|", "\u0000")
        rows.append([c.strip().replace("\u0000", "|") for c in body.split("|")])
    if header is None and rows:
        header = rows.pop(0)
    if not header or len(header) < 2 or not rows:
        return None
    n = min(len(header), MAX_TABLE_COLS)
    return {
        "header": [h[:120] for h in header[:n]],
        "rows": [[c[:160] for c in (r + [""] * n)[:n]] for r in rows[:MAX_TABLE_ROWS]],
    }

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
        self.in_diagram = False       # inside @@DIAGRAM ... @@END
        self.diagram_title = ""
        self.diagram_lines: list[str] = []
        self.table_lines: list[str] = []   # pipe-table rows awaiting their end
        self.in_code = False          # inside @@CODE ... @@END
        self.code_lang = ""
        self.code_lines: list[str] = []

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
        if self.in_code:
            out.extend(self._close_code())
        if self.table_lines:
            out.extend(self._close_table())
        if self.in_diagram:
            out.extend(self._close_diagram())
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

    def _close_table(self) -> list[dict]:
        lines, self.table_lines = self.table_lines, []
        t = parse_table(lines)
        if t is None:
            # one column, or a lone |x|: not a table, so it stays text
            out = []
            for line in lines:
                out.extend(self._inline(line.strip()))
            return out
        return [{"type": "segment", "index": self.index, "kind": "table",
                 "value": "", "display": True, "table": t}]

    def _close_diagram(self) -> list[dict]:
        self.in_diagram = False
        d = parse_edge_list(self.diagram_title, self.diagram_lines)
        lines, self.diagram_lines = self.diagram_lines, []
        if d is None:
            # not a usable graph: keep what the model meant, as plain text
            out = []
            for line in lines:
                if line.strip():
                    out.append(self._text(line.strip()))
                    out.append(self._text("\n"))
            return out
        return [{"type": "segment", "index": self.index, "kind": "diagram",
                 "value": d["title"], "display": True, "diagram": d}]

    def _close_code(self) -> list[dict]:
        """Emit the collected lines verbatim.

        Code is the one block that must not be touched on the way through: no
        markdown stripping, no math splitting. A line like `next_node = x` is
        valid Python and invalid LaTeX, and the whole reason this block exists
        is that models otherwise wrap code in $$ \text{...} $$ and KaTeX fails
        on exactly that underscore.
        """
        self.in_code = False
        lines, self.code_lines = self.code_lines[:MAX_CODE_LINES], []
        while lines and not lines[0].strip():
            lines.pop(0)
        while lines and not lines[-1].strip():
            lines.pop()
        if not lines:
            return []
        # drop the indentation the whole block shares, keeping relative depth
        pad = min((len(l) - len(l.lstrip()) for l in lines if l.strip()),
                  default=0)
        code = "\n".join(l[pad:] if l.strip() else "" for l in lines)
        lang = self.code_lang
        self.code_lang = ""
        return [{"type": "segment", "index": self.index, "kind": "code",
                 "value": lang, "display": True,
                 "code": {"language": lang, "text": code}}]

    def _text(self, value: str) -> dict:
        return {"type": "segment", "index": self.index, "kind": "text",
                "value": value, "display": False}

    def _line(self, raw: str) -> list[dict]:
        out: list[dict] = []
        line = raw.rstrip("\r")

        # a code block takes every line verbatim until @@END (or the next step,
        # if the model forgets to close it)
        if self.in_code:
            if END_RE.match(line):
                return self._close_code()
            if STEP_RE.match(line) or FINAL_RE.match(line):
                out.extend(self._close_code())
            else:
                self.code_lines.append(line)
                return out
        m = CODE_RE.match(line)
        if m:
            if self.table_lines:
                out.extend(self._close_table())
            if not self.open:
                out.extend(self._open_step("Solution"))
            self.in_code = True
            self.code_lang = (m.group(1) or "").strip().lower()[:20]
            self.code_lines = []
            return out

        # the first line that is not a table row ends the table being collected
        if (self.table_lines and not self.in_diagram and not self.in_display
                and not TABLE_ROW_RE.match(line)):
            out.extend(self._close_table())

        # a diagram collects its edge list until @@END (or the next step, if the
        # model forgets to close it)
        if self.in_diagram:
            if END_RE.match(line):
                return out + self._close_diagram()
            if STEP_RE.match(line) or FINAL_RE.match(line):
                out.extend(self._close_diagram())
            else:
                self.diagram_lines.append(line)
                return out
        m = DIAGRAM_RE.match(line)
        if m:
            if not self.open:
                out.extend(self._open_step("Solution"))
            self.in_diagram = True
            self.diagram_title = m.group(1).strip()
            self.diagram_lines = []
            return out

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

        if TABLE_ROW_RE.match(line):
            if not self.open:
                out.extend(self._open_step("Solution"))
            self.table_lines.append(line)
            return out

        m = STEP_RE.match(line)
        if m:
            # `out` may hold a diagram this heading just closed; keep it
            return out + self._open_step(m.group(1) or "Step")
        m = FINAL_RE.match(line)
        if m:
            return out + self._open_step(m.group(1).strip() or "Final answer", final=True)

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
            seg = {"kind": e["kind"], "value": e["value"],
                   "display": e.get("display", False)}
            if e.get("diagram"):
                seg["diagram"] = e["diagram"]
            if e.get("table"):
                seg["table"] = e["table"]
            if e.get("code"):
                seg["code"] = e["code"]
            cur["segments"].append(seg)
    return steps
