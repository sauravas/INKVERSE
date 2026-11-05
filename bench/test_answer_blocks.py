"""Diagram kinds and tables: classification, validation, and streaming safety."""
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from app.ai.diagram import parse_edge_list  # noqa: E402
from app.ai.parser import StepStreamParser, events_to_steps, parse_table  # noqa: E402

ok = True


def check(name, cond, detail=""):
    global ok
    ok &= bool(cond)
    print(f"{'PASS' if cond else 'FAIL'}  {name}{('  ' + detail) if detail else ''}")


def kind(lines):
    d = parse_edge_list("t", lines)
    return d and d["kind"], d


# --- diagram kinds, from shape alone -----------------------------------------
k, d = kind(["Start -> Read n", "Read n -> P{Is n prime?}", "P -> Print prime : yes",
             "P -> Print composite : no", "Print prime -> End", "Print composite -> End"])
check("decision block -> flowchart", k == "flowchart", k)
check("flowchart terminals drawn rounded",
      {n["label"]: n["shape"] for n in d["nodes"]}.get("Start") == "round"
      and {n["label"]: n["shape"] for n in d["nodes"]}.get("End") == "round")
k, _ = kind(["Plan -> Do", "Do -> Check", "Check -> Act", "Act -> Plan"])
check("closed ring -> cycle", k == "cycle", k)
k, _ = kind(["CPU -> ALU : arithmetic", "CPU -> Control Unit : sequencing",
             "CPU -> Registers : fast storage", "CPU -> Cache : recent data"])
check("one object and its parts -> labelled", k == "labelled", k)
k, _ = kind(["Root -> A", "Root -> B", "A -> A1", "A -> A2", "B -> B1"])
check("tree -> hierarchy", k == "hierarchy", k)
k, _ = kind(["New -> Ready", "Ready -> Running", "Running -> Ready", "Running -> Waiting",
             "Waiting -> Ready", "Running -> Done"])
check("anything else -> block", k == "block", k)
_, d = kind(["A -> B", "A -> B", "A -> B : x", "B -> C"])
check("duplicate edges dropped, labelled variant kept", len(d["edges"]) == 3, str(d["edges"]))

# --- tables -----------------------------------------------------------------
t = parse_table(["| Aspect | Process | Thread |", "|---|---|:---:|",
                 "| Memory | Separate | Shared |", "| Switch cost | High |"])
check("header taken from the row above ---", t and t["header"] == ["Aspect", "Process", "Thread"])
check("ragged rows padded to the header", t["rows"][1] == ["Switch cost", "High", ""])
t = parse_table(["| a | b |", "| $\\|x\\|$ | 2 |"])
check("escaped pipes stay inside a cell", t and t["rows"][0][0] == "$|x|$", str(t))
check("single column is not a table", parse_table(["| x |", "| y |"]) is None)
check("header with no rows is not a table", parse_table(["| a | b |", "|---|---|"]) is None)

STREAM = """@@STEP Compare them
A process and a thread differ in what they share.
| Aspect | Process | Thread |
|---|---|---|
| Memory | Separate address space | Shared with its process |
| Creation cost | High | Low ($\\approx 10\\times$ cheaper) |
Threads are lighter but less isolated.
@@STEP Absolute value is not a table
|x| < 1
@@STEP Table straight before a heading
| a | b |
| 1 | 2 |
@@FINAL
| Kind | Count |
|---|---|
| Steps | 3 |
"""


def run(chunks):
    p = StepStreamParser()
    ev = []
    for c in chunks:
        ev += p.feed(c)
    return events_to_steps(ev + p.finish())


steps = run([STREAM])
kinds0 = [s["kind"] for s in steps[0]["segments"] if s["kind"] != "text" or s["value"].strip()]
check("table sits between the text around it", kinds0 == ["text", "table", "text"], str(kinds0))
tbl = next(s for s in steps[0]["segments"] if s["kind"] == "table")["table"]
check("maths inside a cell preserved", "$\\approx 10\\times$" in tbl["rows"][1][2], tbl["rows"][1][2])
check("|x| < 1 stays text", all(s["kind"] != "table" for s in steps[1]["segments"])
      and any("|x| < 1" in s["value"] for s in steps[1]["segments"]))
check("table closed by the next heading", any(s["kind"] == "table" for s in steps[2]["segments"]))
check("table closed by the end of the stream", steps[3]["final"]
      and any(s["kind"] == "table" for s in steps[3]["segments"]))
stable = all(run([STREAM[i:i + n] for i in range(0, len(STREAM), n)]) == steps
             for n in range(1, 9))
rnd_ok = True
for seed in range(30):
    cuts = sorted(random.Random(seed).sample(range(1, len(STREAM)), 20))
    rnd_ok &= run([STREAM[a:b] for a, b in zip([0] + cuts, cuts + [len(STREAM)])]) == steps
check("identical across fixed and random chunkings", stable and rnd_ok)

print("\nANSWER BLOCKS RESULT:", "PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
