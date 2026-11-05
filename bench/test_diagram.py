"""Edge-list diagram parsing: the forms models actually write, and streaming."""
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from app.ai.diagram import describe, parse_edge_list  # noqa: E402
from app.ai.parser import StepStreamParser, events_to_steps  # noqa: E402

ok = True


def check(name, cond, detail=""):
    global ok
    ok &= bool(cond)
    print(f"{'PASS' if cond else 'FAIL'}  {name}{('  ' + detail) if detail else ''}")


def edges(d):
    lab = {n["id"]: n["label"] for n in d["nodes"]}
    return [(lab[e["from"]], lab[e["to"]], e["label"]) for e in d["edges"]]


# 1. the protocol as specified
d = parse_edge_list("Process states", [
    "direction: LR",
    "New -> Ready : admitted",
    "Ready -> Running : scheduler dispatch",
    "Running -> Waiting : I/O request",
    "Waiting -> Ready : I/O done",
    "Running -> Terminated : exit",
])
check("plain edge list", d and d["direction"] == "LR" and len(d["nodes"]) == 5
      and len(d["edges"]) == 5, str(edges(d)[:2]))
check("same words are the same block", sum(1 for n in d["nodes"] if n["label"] == "Ready") == 1)
check("edge labels kept", ("Running", "Waiting", "I/O request") in edges(d))

# 2. Mermaid drift: ids with labels, shapes, pipe labels, headers, fences
d = parse_edge_list("Von Neumann", [
    "```mermaid", "graph TD",
    "CPU[Central Processing Unit] -->|address bus| MEM[(Main Memory)]",
    "CPU -->|control| IO{I/O Controller}",
    "MEM --> CPU",
    "```",
])
check("mermaid header sets direction", d and d["direction"] == "TB")
labels = {n["id"]: (n["label"], n["shape"]) for n in d["nodes"]}
check("id[label] and shapes understood",
      labels.get("CPU") == ("Central Processing Unit", "box")
      and labels.get("MEM") == ("Main Memory", "store") and len(labels) == 3
      and labels.get("IO") == ("I/O Controller", "diamond"), str(labels))
check("pipe labels", ("Central Processing Unit", "I/O Controller", "control") in edges(d))

# 3. dash labels, chains, unicode arrows, colon inside a bracketed label
d = parse_edge_list("Compiler", [
    "Source -- tokens --> Lexer",
    "Lexer -> Parser -> Semantic Analyser",
    "Semantic Analyser → B[Step 4: Code generation] : IR",
])
e = edges(d)
check("dash label", ("Source", "Lexer", "tokens") in e)
check("chain becomes consecutive edges",
      ("Lexer", "Parser", "") in e and ("Parser", "Semantic Analyser", "") in e)
check("colon inside a bracket stays in the label",
      ("Semantic Analyser", "Step 4: Code generation", "IR") in e, str(e[-1]))

# 4. garbage degrades to None (caller falls back to text)
check("prose is not a diagram", parse_edge_list("x", ["The CPU fetches instructions."]) is None)
check("one node is not a diagram", parse_edge_list("x", ["A -> A"]) is None)
check("a single arrow is a sentence, not a figure", parse_edge_list("x", ["A -> B"]) is None)
check("empty is not a diagram", parse_edge_list("x", []) is None)

# 5. size limits hold
big = parse_edge_list("big", [f"N{i} -> N{i + 1}" for i in range(80)])
check("node and edge caps enforced", len(big["nodes"]) <= 24 and len(big["edges"]) <= 40,
      f"{len(big['nodes'])} nodes")

# 6. inside the stream parser, across arbitrary chunk boundaries
STREAM = """@@STEP Structure of an OS
The kernel sits between hardware and applications.
@@DIAGRAM Layers of an operating system
direction: TB
User Applications -> System Call Interface : requests
System Call Interface -> Kernel
Kernel -> Hardware : drivers
@@END
Each layer only talks to the one below it.
@@STEP Missing end marker
@@DIAGRAM Unclosed
A -> B
B -> C
@@FINAL
Done.
"""


def run(chunks):
    p = StepStreamParser()
    ev = []
    for c in chunks:
        ev += p.feed(c)
    return events_to_steps(ev + p.finish())


whole = run([STREAM])
segs = whole[0]["segments"]
kinds = [s["kind"] for s in segs if s["value"].strip() or s["kind"] != "text"]
check("diagram sits between the text that surrounds it",
      kinds.index("diagram") > 0 and "text" in kinds[kinds.index("diagram") + 1:], str(kinds))
dg = next(s for s in segs if s["kind"] == "diagram")
check("diagram carried as structure", dg["diagram"]["title"] == "Layers of an operating system"
      and len(dg["diagram"]["edges"]) == 3)
check("an unclosed diagram is closed by the next step",
      any(s["kind"] == "diagram" for s in whole[1]["segments"]) and whole[2]["final"])
stable = all(run([STREAM[i:i + n] for i in range(0, len(STREAM), n)]) == whole
             for n in range(1, 9)) and all(
    run(_chunks) == whole for _chunks in
    ([STREAM[a:b] for a, b in zip([0] + cuts, cuts + [len(STREAM)])]
     for cuts in (sorted(random.Random(s).sample(range(1, len(STREAM)), 25))
                  for s in range(30))))
check("identical across fixed and random chunkings", stable)
print("\ndescribe():", describe(dg["diagram"]))

print("\nDIAGRAM RESULT:", "PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
