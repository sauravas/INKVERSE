"""The figure library draws real things, so it has to be really right.

Two kinds of mistake matter here and neither shows up in a code review. One is
a typed coordinate that lands outside the drawing, so a leader line points at
nothing. The other is an alias naming a part that does not exist, so a student
writing "mitral valve" silently gets no label. Both are caught by arithmetic
over the library itself, which is why this test reads every figure rather than
a sample.

    .venv\\Scripts\\python.exe bench\\test_figures.py
"""
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from app.ai import figures as F          # noqa: E402
from app.ai.diagram import describe, parse_edge_list  # noqa: E402

fails = 0


def check(name, cond, detail=""):
    global fails
    print(("  ok   " if cond else "  FAIL ") + name
          + (f"  ({detail})" if detail and not cond else ""))
    fails += 0 if cond else 1


NUM = re.compile(r"-?\d+(?:\.\d+)?")

print("every figure in the library is drawable")
for fig in F.FIGURES:
    w, h = fig["box"]["w"], fig["box"]["h"]
    check(f"{fig['id']}: has strokes and parts",
          len(fig["strokes"]) >= 3 and len(fig["parts"]) >= F.MIN_PARTS)

    # a stroke must start with a move, or the path begins wherever the last
    # one ended and the figure comes apart
    bad_start = [s["d"][:12] for s in fig["strokes"] if not s["d"].startswith("M")]
    check(f"{fig['id']}: every stroke starts at a stated point", not bad_start, bad_start)

    # Relative commands would make the numbers below deltas rather than
    # coordinates, and the box check meaningless, so the library does not use
    # them: every stroke says where it is, not where it is going next.
    rel = [s["d"][:24] for s in fig["strokes"]
           if re.search(r"(?<![a-zA-Z])[hvlcasqt](?=[\s\d.-])", s["d"])]
    check(f"{fig['id']}: strokes are in absolute coordinates", not rel, rel[:3])

    # a coordinate well outside the box is a typo; the drawing would be clipped
    # or the leader would point off the page
    out = []
    for s in fig["strokes"]:
        for n in NUM.findall(s["d"]):
            v = float(n)
            if v < -40 or v > max(w, h) + 40:
                out.append((s["d"][:24], v))
    check(f"{fig['id']}: every stroke stays near its box", not out, out[:3])

    off = [(p, a) for p, a in fig["parts"].items()
           if not (0 <= a["x"] <= w and 0 <= a["y"] <= h)]
    check(f"{fig['id']}: every anchor is inside the box", not off, off[:3])

    sides = {p: a.get("side") for p, a in fig["parts"].items()}
    check(f"{fig['id']}: sides are L or R where given",
          all(v in (None, "L", "R") for v in sides.values()))

    # an alias for a part we do not hold is a label that silently never appears
    orphans = [a for a, canon in fig.get("aliases", {}).items()
               if canon not in fig["parts"]]
    check(f"{fig['id']}: no alias points at a missing part", not orphans, orphans)

    # two parts that normalise the same would shadow each other
    norms = [F.normalise(p) for p in fig["parts"]]
    check(f"{fig['id']}: part names stay distinct once normalised",
          len(set(norms)) == len(norms))

print("\nnaming the object, however the student's book words it")
for whole, want in [("Heart", "heart"), ("the human heart", "heart"),
                    ("Structure of the Heart", "heart"),
                    ("Labelled diagram of a neuron", "neuron"),
                    ("Nerve cell", "neuron"), ("Human brain", "brain"),
                    ("A typical plant cell", "plant-cell"),
                    ("Animal cell", "animal-cell"), ("Eyeball", "eye")]:
    got = F.find(whole)
    check(f"{whole!r} -> {want}", got is not None and got["id"] == want,
          got["id"] if got else None)

check("a block diagram is not an anatomy figure", F.find("CPU") is None)
check("nor is an empty title", F.find("") is None)

print("\nparts, in the words a model actually uses")
heart = F.find("Heart")
for part, want in [("Mitral valve", "bicuspid valve"), ("right auricle", "right atrium"),
                   ("the Aorta", "aorta"), ("Interventricular septum", "septum"),
                   ("left ventricle (thick muscular wall)", "left ventricle"),
                   ("Superior vena cava", "superior vena cava")]:
    check(f"{part!r} -> {want}", F.resolve(heart, part) == want, F.resolve(heart, part))
check("a part we hold no anchor for is refused, not guessed",
      F.resolve(heart, "pericardium") is None)

print("\nfrom an edge list to a drawing")
d = parse_edge_list("Structure of the heart", [
    "Heart -> Left ventricle : pumps blood into the aorta",
    "Heart -> Right atrium : receives blood from the vena cava",
    "Heart -> Aorta : the largest artery",
    "Heart -> Pericardium : the sac around it",
])
check("it is a figure", d and d["kind"] == "figure")
check("with our geometry attached", bool(d["figure"]["strokes"]))
check("the parts it could place are placed", len(d["figure"]["parts"]) == 3,
      [p["part"] for p in d["figure"]["parts"]])
check("the one it could not is dropped, not invented",
      d["figure"]["dropped"] == ["Pericardium"], d["figure"]["dropped"])
check("the model's own wording is kept on the label",
      d["figure"]["parts"][0]["label"][0].isupper())
check("what each part does is kept too",
      any("pumps blood" in p["note"] for p in d["figure"]["parts"]))
check("labels are ordered down each margin",
      [p["y"] for p in d["figure"]["parts"] if p["side"] == "R"]
      == sorted(p["y"] for p in d["figure"]["parts"] if p["side"] == "R"))
check("and a later prompt can see what was drawn",
      "Human heart" in describe(d) and "Left ventricle" in describe(d), describe(d))

print("\nwhat the model really wrote, when asked")
# Both of these came back from qwen2.5:14b on the live pipeline and neither
# was drawn: the first named ten parts we had no anchors for, the second was
# a little tree rather than a star. They are here so they stay fixed.
real_heart = parse_edge_list("Parts of the Human Heart", [
    "Heart -> Atria : Receive blood from veins",
    "Heart -> Ventricles : Pump blood to arteries",
    "Heart -> Tricuspid Valve : Regulates flow to the right ventricle",
    "Heart -> Mitral Valve : Regulates flow to the left ventricle",
    "Heart -> Pulmonary Valve : Regulates flow to the lungs",
    "Heart -> Aortic Valve : Regulates flow into the aorta",
    "Heart -> Sinoatrial Node (SA Node) : Initiates heart contractions",
    "Heart -> Atrioventricular Node (AV Node) : Transmits electrical signals",
    "Heart -> Bundle of His : Conducts electrical impulses",
    "Heart -> Purkinje Fibers : Distributes impulses to muscle fibres",
])
check("the heart the model actually described is drawn",
      real_heart["kind"] == "figure", real_heart["kind"])
check("and every part it named was placed",
      not real_heart.get("figure", {}).get("dropped", ["?"]),
      real_heart.get("figure", {}).get("dropped"))

real_neuron = parse_edge_list("Neuron Structure", [
    "Neuron -> Cell Body : Contains nucleus and organelles",
    "Cell Body -> Dendrites : Receive signals",
    "Cell Body -> Axon : Transmit signals",
    "Axon -> Synapse : Release neurotransmitters",
])
check("a tree hanging off the object is drawn too",
      real_neuron["kind"] == "figure", real_neuron["kind"])
check("with the parts from every level of it",
      len(real_neuron.get("figure", {}).get("parts", [])) == 4)

print("\nthe model is told which labels we can place")
hint = F.prompt_hint("Draw a labelled diagram of the human heart")
check("the hint names the object", "heart" in hint)
check("and lists parts it would otherwise invent names for",
      "sinoatrial node" in hint and "left ventricle" in hint)
check("a question about something else gets no hint",
      F.prompt_hint("Derive the transfer function of an RC low pass filter") == "",
      F.prompt_hint("Derive the transfer function of an RC low pass filter"))

print("\nwhat must NOT become a figure")
flow = parse_edge_list("Blood flow", [
    "Start -> Right atrium", "Right atrium -> Right ventricle",
    "Right ventricle -> Lungs", "Lungs -> Left atrium"])
check("a flow through the heart stays a flow, not a labelled figure",
      flow["kind"] != "figure", flow["kind"])

cpu = parse_edge_list("Parts of a CPU", [
    "CPU -> ALU : arithmetic", "CPU -> Control Unit : decodes",
    "CPU -> Registers : fastest storage"])
check("a CPU is still the ordinary labelled layout", cpu["kind"] == "labelled", cpu["kind"])

thin = parse_edge_list("Heart", [
    "Heart -> Aorta : the largest artery", "Heart -> Pericardium : the sac",
    "Heart -> Vagus nerve : slows it down"])
check("one placeable part is not enough to draw a heart",
      thin["kind"] != "figure", thin["kind"])

print("\nthe prompt lists what the library can draw")
from app.ai import prompts            # noqa: E402
check("every figure is offered to the model",
      all(n in prompts._BLOCK_RULES for n in F.names()))
check("and no placeholder was left behind", "{FIGURES}" not in prompts._BLOCK_RULES)

print("\n" + (f"{fails} FAILED" if fails else "ALL PASSED"))
sys.exit(1 if fails else 0)
