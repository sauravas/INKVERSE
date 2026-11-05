"""Edge-list diagrams: the model writes relationships, never drawing code.

    @@DIAGRAM Process states
    direction: LR
    New -> Ready : admitted
    Ready -> Running : dispatch
    @@END

This module turns those lines into validated structure. Constraint 2 holds: the
model's text never reaches React, and anything that does not parse into a
sensible graph returns None so the caller can fall back to plain text.

Accepted, because models drift into them: Mermaid node syntax (A[CPU],
B(Memory), C{Decision}, D((Bus))), -->/==>/=>/unicode arrows, pipe labels
(A -->|bus| B), dash labels (A -- bus --> B), chains (A -> B -> C), and
"graph LR" / "flowchart TD" headers.
"""
from __future__ import annotations

import re

MAX_NODES = 24
MAX_EDGES = 40
MAX_LABEL = 48

ARROW = r"(?:-{1,2}>|={1,2}>|\u2192|\u27f6)"
ARROW_RE = re.compile(rf"\s*{ARROW}\s*")
DIRECTION_RE = re.compile(
    r"^(?:direction\s*[:=]?\s*|graph\s+|flowchart\s+)(LR|RL|TB|TD|BT)\b", re.I)
PIPE_LABEL_RE = re.compile(rf"^(.+?)\s*{ARROW}\s*\|([^|]*)\|\s*(.+)$")
DASH_LABEL_RE = re.compile(rf"^(.+?)\s+--\s+(.+?)\s+{ARROW}\s*(.+)$")
# id[Label]  id(Label)  id{{Label}}  id((Label))  id[[Label]]  id["Label"]
NODE_RE = re.compile(
    r"^([A-Za-z0-9_]+)\s*(\[\(|\(\(|\[\[|\[|\(|\{)\s*\"?(.+?)\"?\s*"
    r"(\)\]|\)\)|\]\]|\]|\)|\})$")
SHAPES = {"[": "box", "[[": "box", "(": "round", "((": "circle", "{": "diamond",
          "[(": "store"}
SKIP_RE = re.compile(r"^(```|classDef|class |style |linkStyle|%%|subgraph|end$)", re.I)


def _clean_label(s: str) -> str:
    s = re.sub(r"\s+", " ", s.strip().strip('"\'`*_')).strip()
    s = s.replace("$", "")          # inline maths in a box label is noise here
    return s[:MAX_LABEL].rstrip()


def _node(token: str, nodes: dict, order: list) -> str | None:
    token = token.strip().rstrip(";").strip()
    if not token:
        return None
    m = NODE_RE.match(token)
    if m:
        nid, opener, label = m.group(1), m.group(2), _clean_label(m.group(3))
        shape = SHAPES.get(opener, "box")
    else:
        label = _clean_label(token)
        nid, shape = None, None
    if not label:
        return None
    if nid is None:
        # a bare token may be the id of a block declared earlier (CPU after
        # CPU[Central Processing Unit]); match ids exactly, then case-blind
        if label in nodes:
            return label
        for known in nodes:
            if known.lower() == label.lower():
                return known
        # otherwise the label is its own id: the same words, the same block
        nid = re.sub(r"\W+", "_", label.lower()).strip("_")[:40] or f"n{len(order)}"
        if nid in nodes:
            return nid
        shape = "box"
    if nid in nodes:
        # a later definition may give a node its proper label or shape
        if m and nodes[nid]["label"] == nid:
            nodes[nid].update(label=label, shape=shape)
        return nid
    nodes[nid] = {"id": nid, "label": label, "shape": shape}
    order.append(nid)
    return nid


BRACKETED_RE = re.compile(
    r"^(\s*[A-Za-z0-9_]+\s*(?:\[\(|\(\(|\[\[|\[|\(|\{).*?(?:\)\]|\)\)|\]\]|\]|\)|\}))"
    r"\s*:\s*(.+)$")


def _split_label(token: str) -> tuple[str, str]:
    """'Running : dispatch' -> ('Running', 'dispatch'), but a colon inside a
    bracketed label (B[Step 1: Init]) belongs to the label, not the edge."""
    t = token.strip().rstrip(";")
    if NODE_RE.match(t):
        return t, ""
    m = BRACKETED_RE.match(t)
    if m:
        return m.group(1), m.group(2)
    head, sep, tail = t.partition(":")
    if sep and head.strip() and tail.strip():
        return head, tail
    return t, ""


def parse_edge_list(title: str, lines: list[str]) -> dict | None:
    direction = "TB"
    nodes: dict[str, dict] = {}
    order: list[str] = []
    edges: list[dict] = []

    for raw in lines:
        line = raw.strip().rstrip(";").strip()
        if not line or SKIP_RE.match(line):
            continue
        d = DIRECTION_RE.match(line)
        if d:
            direction = {"TD": "TB"}.get(d.group(1).upper(), d.group(1).upper())
            continue

        label = ""
        m = PIPE_LABEL_RE.match(line)
        if m:
            parts, label = [m.group(1), m.group(3)], m.group(2)
        else:
            m = DASH_LABEL_RE.match(line)
            if m:
                parts, label = [m.group(1), m.group(3)], m.group(2)
            else:
                parts = ARROW_RE.split(line)
                if len(parts) >= 2:
                    parts[-1], label = _split_label(parts[-1])

        if len(parts) == 1:
            _node(parts[0], nodes, order)          # a block declared on its own
            continue
        ids = [_node(p, nodes, order) for p in parts]
        for a, b in zip(ids, ids[1:]):
            if a and b and a != b and len(edges) < MAX_EDGES:
                edges.append({"from": a, "to": b, "label": _clean_label(label)})
        if len(order) > MAX_NODES:
            break

    if len(order) < 2 or not edges:
        return None
    keep = set(order[:MAX_NODES])
    seen, unique = set(), []
    for e in edges:
        key = (e["from"], e["to"], e["label"].lower())
        if e["from"] in keep and e["to"] in keep and key not in seen:
            seen.add(key)
            unique.append(e)
    if not unique:
        return None
    # a single arrow between two blocks is a sentence, not a figure
    if len(keep) == 2 and len(unique) == 1:
        return None
    node_list = [nodes[i] for i in order[:MAX_NODES]]
    kind = classify(node_list, unique)
    if kind == "flowchart":
        for n in node_list:
            # Start / End terminals are drawn rounded, as flowcharts expect
            if n["shape"] == "box" and re.fullmatch(r"(start|begin|end|stop|exit)",
                                                    n["label"], re.I):
                n["shape"] = "round"
    return {
        "title": _clean_label(title) or "Diagram",
        "kind": kind,
        "direction": direction if direction in ("LR", "RL", "TB", "BT") else "TB",
        "nodes": node_list,
        "edges": unique,
    }


def classify(nodes: list[dict], edges: list[dict]) -> str:
    """What kind of picture this graph is, judged from its shape alone.

    The model is never asked to name a type: the edge-list protocol stays as
    it is, and the same list of relationships tells us how to draw it.
    """
    ids = [n["id"] for n in nodes]
    out = {i: [] for i in ids}
    indeg = {i: 0 for i in ids}
    for e in edges:
        out[e["from"]].append(e["to"])
        indeg[e["to"]] += 1

    if any(n["shape"] == "diamond" for n in nodes) or sum(
            1 for e in edges if e["label"].lower() in ("yes", "no", "true", "false")) >= 2:
        return "flowchart"

    # a ring: every block has exactly one way in and one way out, all connected
    if len(nodes) >= 3 and len(edges) == len(nodes) and all(
            len(out[i]) == 1 and indeg[i] == 1 for i in ids):
        seen, cur = set(), ids[0]
        while cur not in seen:
            seen.add(cur)
            cur = out[cur][0]
        if len(seen) == len(ids):
            return "cycle"

    roots = [i for i in ids if indeg[i] == 0]
    is_tree = len(roots) == 1 and len(edges) == len(nodes) - 1 and all(
        indeg[i] <= 1 for i in ids)
    if is_tree:
        hub = roots[0]
        if len(out[hub]) >= 3 and all(not out[c] for c in out[hub]):
            return "labelled"         # one object and its named parts
        return "hierarchy"
    return "block"


def describe(d: dict) -> str:
    """Plain-text form, so follow-up prompts can see what was drawn."""
    labels = {n["id"]: n["label"] for n in d["nodes"]}
    rel = "; ".join(
        f"{labels[e['from']]} -> {labels[e['to']]}" + (f" ({e['label']})" if e["label"] else "")
        for e in d["edges"])
    return f"[Diagram: {d['title']}. {rel}]"
