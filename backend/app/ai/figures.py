"""Real figures, drawn from our own geometry - never from the model's.

A block diagram can be laid out from a list of relationships, because the
shape of a flowchart carries no information beyond the relationships. A heart
cannot. Where the left ventricle sits relative to the aorta is the knowledge,
and a 4B model asked to invent coordinates for it will produce something
confidently wrong - which, for a student revising anatomy, is worse than no
diagram at all.

So the drawing lives here, authored once and correct: the outline strokes and
the anchor point of every part. The model's job is only the part it is good
at - naming the object, choosing which parts matter, and saying what each one
does - using the labelled-figure form it already writes:

    @@DIAGRAM Structure of the heart
    Heart -> Left ventricle : pumps blood into the aorta
    Heart -> Right atrium : receives blood from the vena cava
    @@END

`match()` turns that into a figure with every named part pinned to its real
place. Parts we have no anchor for are dropped from the drawing rather than
guessed at; the step text still explains them. Constraint 2 holds twice over
here: not only does the model not control the rendering, it does not supply a
single coordinate.

Coordinates are in each figure's own box, origin top-left, and are drawn by
the frontend with a rough pen so they look sketched rather than printed.
"""
from __future__ import annotations

import re

# How many labels a figure can carry before it stops being readable.
MAX_PARTS = 12
# Below this many resolved parts it is not worth drawing an anatomical figure;
# the ordinary labelled layout says the same thing without pretending.
MIN_PARTS = 2
# And a figure has to carry most of what the model named. Asked for a heart it
# once listed ten parts of which we could place two: drawing those two and
# dropping the other eight would have been a prettier answer with most of the
# content missing, which is not a trade worth making.
MIN_COVERAGE = 0.6


def _e(cx: float, cy: float, rx: float, ry: float) -> str:
    """An ellipse as a path, so every stroke in a figure is the same kind."""
    return (f"M{cx - rx},{cy} A{rx},{ry} 0 1 1 {cx + rx},{cy} "
            f"A{rx},{ry} 0 1 1 {cx - rx},{cy}")


def _dot(cx: float, cy: float, r: float = 3) -> str:
    return _e(cx, cy, r, r)


# --------------------------------------------------------------------------
# The library. Each figure: the box it is drawn in, the strokes in the order a
# person would draw them, and an anchor for every part it can label.
#   side: which margin the label is written in ("L" or "R"); without it the
#   anchor's own position decides.
# --------------------------------------------------------------------------

NEURON = {
    "id": "neuron",
    "title": "Neuron",
    "names": ["neuron", "nerve cell", "neurone", "structure of a neuron",
              "motor neuron", "typical neuron"],
    "box": {"w": 430, "h": 230},
    "strokes": [
        # dendrites first, the way the drawing grows outward from the body
        {"d": "M100,88 C78,74 60,60 44,48"}, {"d": "M44,48 L24,40"}, {"d": "M44,48 L38,24"},
        {"d": "M90,112 C68,110 48,106 28,100"}, {"d": "M28,100 L10,92"}, {"d": "M28,100 L12,110"},
        {"d": "M100,136 C80,152 64,168 50,182"}, {"d": "M50,182 L32,192"}, {"d": "M50,182 L50,206"},
        {"d": "M126,80 C120,58 114,44 106,28"}, {"d": "M106,28 L88,18"}, {"d": "M106,28 L120,8"},
        {"d": _e(126, 112, 36, 32)},                       # cell body
        {"d": _e(126, 112, 14, 13)},                       # nucleus
        {"d": "M162,112 L372,112"},                        # axon
        {"d": _e(206, 112, 24, 15)},                       # myelin sheaths
        {"d": _e(262, 112, 24, 15)},
        {"d": _e(318, 112, 24, 15)},
        {"d": "M372,112 L400,88"}, {"d": "M372,112 L408,112"}, {"d": "M372,112 L398,138"},
        {"d": _dot(403, 85, 6)}, {"d": _dot(412, 112, 6)}, {"d": _dot(401, 141, 6)},
    ],
    "parts": {
        "dendrite": {"x": 40, "y": 48, "side": "L"},
        "cell body": {"x": 112, "y": 140, "side": "L"},
        "nucleus": {"x": 126, "y": 112, "side": "L"},
        "axon": {"x": 350, "y": 112, "side": "R"},
        "myelin sheath": {"x": 262, "y": 98, "side": "R"},
        "node of ranvier": {"x": 234, "y": 128, "side": "R"},
        "axon terminal": {"x": 406, "y": 112, "side": "R"},
        "axon hillock": {"x": 164, "y": 100, "side": "R"},
    },
    "aliases": {
        "soma": "cell body", "cyton": "cell body", "perikaryon": "cell body",
        "dendrites": "dendrite", "dendron": "dendrite",
        "nerve fibre": "axon", "nerve fiber": "axon", "axon fibre": "axon",
        "myelin": "myelin sheath", "schwann cell": "myelin sheath",
        "nodes of ranvier": "node of ranvier",
        "synaptic terminal": "axon terminal", "synaptic knob": "axon terminal",
        "terminal button": "axon terminal", "synapse": "axon terminal",
        "end plate": "axon terminal",
    },
}

HEART = {
    "id": "heart",
    "title": "Human heart",
    "names": ["heart", "human heart", "mammalian heart", "structure of the heart",
              "structure of heart", "internal structure of the heart", "the heart"],
    "box": {"w": 360, "h": 320},
    "strokes": [
        # The body first, wide at the atria and narrowing to the apex, then
        # what divides it inside, then each vessel as a pair of parallel walls
        # - a single line reads as a scratch, two read as a tube.
        # The body is a cone with a smooth top - no Valentine notch - so the
        # two arteries leaving the top have clear air above them. The veins
        # come in from the sides, which is both true and keeps the top of the
        # drawing from becoming a tangle of crossing tubes.
        {"d": "M110,122 C86,146 80,190 96,232 C112,272 140,296 160,304 "
              "C190,288 238,250 262,210 C282,176 288,144 274,124 "
              "C240,104 148,102 110,122 Z"},
        {"d": "M196,112 C188,170 176,240 160,298"},          # septum
        {"d": "M96,180 C146,204 236,196 284,162"},           # atria / ventricles
        {"d": "M126,186 L138,202 L150,184"},                 # tricuspid valve
        {"d": "M220,174 L232,190 L244,172"},                 # bicuspid valve
        # Each vessel is one stroke: up one wall, round the cut end, back down
        # the other. Two bare parallel lines look exactly like the leader
        # lines pointing at them; a closed end reads as a tube immediately.
        # The aorta leaves the top and hooks over the right shoulder. Drawn as
        # a symmetric arch with both feet on the body it reads as the shackle
        # of a padlock, which is all anyone then sees.
        {"d": "M200,104 C198,62 228,40 268,46 C304,52 318,84 316,118 "
              "A8,8 0 0 1 300,116 C302,90 288,66 264,64 C240,62 226,78 226,104"},
        {"d": "M182,106 L142,24 A14,14 0 0 0 118,36 L158,118"},   # pulmonary artery
        {"d": "M121,107 L49,31 A13,13 0 0 0 31,49 L103,125"},     # superior vena cava
        {"d": "M110,254 L34,296 A13,13 0 0 0 22,276 L98,234"},    # inferior vena cava
        {"d": "M278,176 L330,170 A8,8 0 0 1 332,184 L280,190"},   # pulmonary veins
        {"d": "M276,202 L330,198 A8,8 0 0 1 330,214 L278,216"},
        {"d": "M162,110 L170,120 L178,108"},                 # pulmonary valve
        {"d": "M204,108 L212,118 L220,106"},                 # aortic valve
        # the conduction system: where the beat starts and how it spreads
        {"d": _e(132, 132, 7, 5)},                           # sinoatrial node
        {"d": _e(188, 172, 6, 5)},                           # atrioventricular node
        {"d": "M188,178 C186,192 184,202 182,214"},          # bundle of His
        {"d": "M182,214 C168,238 152,256 138,266"},          # Purkinje fibres
        {"d": "M182,214 C198,234 214,246 228,252"},
        {"d": "M150,254 L140,250"}, {"d": "M160,264 L152,262"},
        {"d": "M212,244 L206,236"}, {"d": "M222,250 L218,242"},
    ],
    "parts": {
        "right atrium": {"x": 130, "y": 150, "side": "L"},
        "left atrium": {"x": 230, "y": 146, "side": "R"},
        "right ventricle": {"x": 140, "y": 226, "side": "L"},
        "left ventricle": {"x": 220, "y": 212, "side": "R"},
        "septum": {"x": 176, "y": 262, "side": "R"},
        "apex": {"x": 160, "y": 302, "side": "L"},
        "aorta": {"x": 306, "y": 64, "side": "R"},
        "pulmonary artery": {"x": 130, "y": 30, "side": "L"},
        "superior vena cava": {"x": 40, "y": 40, "side": "L"},
        "inferior vena cava": {"x": 28, "y": 286, "side": "L"},
        "pulmonary vein": {"x": 330, "y": 178, "side": "R"},
        "tricuspid valve": {"x": 138, "y": 192, "side": "L"},
        "bicuspid valve": {"x": 232, "y": 180, "side": "R"},
        "pulmonary valve": {"x": 170, "y": 116, "side": "L"},
        "aortic valve": {"x": 212, "y": 114, "side": "R"},
        "atria": {"x": 176, "y": 124, "side": "R"},
        "ventricles": {"x": 178, "y": 232, "side": "L"},
        "sinoatrial node": {"x": 132, "y": 132, "side": "L"},
        "atrioventricular node": {"x": 188, "y": 172, "side": "R"},
        "bundle of his": {"x": 184, "y": 200, "side": "R"},
        "purkinje fibres": {"x": 150, "y": 254, "side": "L"},
    },
    "aliases": {
        "right auricle": "right atrium", "left auricle": "left atrium",
        "interventricular septum": "septum", "inter ventricular septum": "septum",
        "sa node": "sinoatrial node", "sinu atrial node": "sinoatrial node",
        "pacemaker": "sinoatrial node", "sinus node": "sinoatrial node",
        "av node": "atrioventricular node",
        "bundle of hi": "bundle of his", "av bundle": "bundle of his",
        "purkinje fibers": "purkinje fibres", "purkinje fibre": "purkinje fibres",
        "semilunar valve": "aortic valve", "aortic semilunar valve": "aortic valve",
        "pulmonic valve": "pulmonary valve",
        "atrium": "atria", "auricles": "atria",
        "ventricle": "ventricles", "heart chambers": "atria",
        "interatrial septum": "septum", "ventricular septum": "septum",
        "apex of the heart": "apex", "cardiac apex": "apex",
        "aortic arch": "aorta", "arch of aorta": "aorta", "dorsal aorta": "aorta",
        "pulmonary trunk": "pulmonary artery", "pulmonary arteries": "pulmonary artery",
        "vena cava": "superior vena cava", "precava": "superior vena cava",
        "postcava": "inferior vena cava", "pulmonary veins": "pulmonary vein",
        "mitral valve": "bicuspid valve", "left av valve": "bicuspid valve",
        "right av valve": "tricuspid valve",
    },
}

BRAIN = {
    "id": "brain",
    "title": "Human brain",
    "names": ["brain", "human brain", "structure of the brain", "parts of the brain",
              "the brain", "cerebrum and cerebellum"],
    "box": {"w": 400, "h": 310},
    "strokes": [
        {"d": "M46,160 C40,92 104,38 186,34 C272,30 334,76 338,140 "
              "C340,174 320,198 290,208"},                  # cerebrum, over the top
        # the underside dips at the front: that lower bulge is the temporal
        # lobe, and without it the whole thing is just an oval
        {"d": "M46,160 C42,194 60,222 96,228 C142,232 206,216 248,198"},
        {"d": "M190,42 C186,74 180,98 170,126"},             # central sulcus
        {"d": "M66,154 C104,188 164,192 210,166"},           # lateral sulcus
        # gyri: the folds, following the curve of the surface they sit on
        {"d": "M72,122 C96,108 116,130 142,114 C164,100 182,124 206,108"},
        {"d": "M82,84 C108,68 128,92 154,76 C176,64 194,88 218,72"},
        {"d": "M118,54 C142,40 160,62 186,48 C208,36 226,58 250,46"},
        {"d": "M224,120 C248,106 266,130 292,114"},
        {"d": "M238,158 C260,146 276,168 300,154"},
        {"d": "M100,182 C124,170 142,190 168,178"},
        {"d": "M232,196 C234,226 232,254 228,286"},          # brain stem
        {"d": "M260,200 C262,228 258,256 252,288"},
        {"d": _e(310, 228, 46, 36)},                         # cerebellum
        {"d": "M274,208 C290,216 304,226 316,240"},          # its striations
        {"d": "M284,198 C300,208 314,220 326,236"},
        {"d": "M296,194 C312,204 326,218 338,232"},
        {"d": "M270,224 C288,230 306,240 320,254"},
    ],
    "parts": {
        "cerebrum": {"x": 160, "y": 92, "side": "L"},
        "frontal lobe": {"x": 88, "y": 110, "side": "L"},
        "parietal lobe": {"x": 238, "y": 58, "side": "R"},
        "occipital lobe": {"x": 324, "y": 132, "side": "R"},
        "temporal lobe": {"x": 130, "y": 206, "side": "L"},
        "cerebellum": {"x": 312, "y": 232, "side": "R"},
        "brain stem": {"x": 244, "y": 250, "side": "R"},
        "medulla oblongata": {"x": 240, "y": 282, "side": "R"},
        "spinal cord": {"x": 240, "y": 298, "side": "L"},
        "central sulcus": {"x": 184, "y": 58, "side": "R"},
        "lateral sulcus": {"x": 140, "y": 182, "side": "L"},
    },
    "aliases": {
        "cerebral hemisphere": "cerebrum", "cerebral cortex": "cerebrum",
        "cerebral hemispheres": "cerebrum", "cortex": "cerebrum",
        "frontal": "frontal lobe", "parietal": "parietal lobe",
        "occipital": "occipital lobe", "temporal": "temporal lobe",
        "little brain": "cerebellum", "medulla": "medulla oblongata",
        "brainstem": "brain stem", "hind brain": "brain stem",
        "hindbrain": "brain stem", "pons": "brain stem",
        "fissure of rolando": "central sulcus",
        "sylvian fissure": "lateral sulcus",
    },
}

EYE = {
    "id": "eye",
    "title": "Human eye",
    "names": ["eye", "human eye", "structure of the eye", "parts of the eye",
              "the eye", "eyeball", "vertical section of the eye",
              "horizontal section of the eye"],
    "box": {"w": 380, "h": 300},
    "strokes": [
        {"d": "M101,88 A124,124 0 1 1 101,212"},             # sclera
        {"d": "M101,88 C62,100 44,124 44,150 C44,176 62,200 101,212"},   # cornea
        {"d": "M108,92 A116,116 0 1 1 108,208"},             # choroid
        {"d": "M115,96 A108,108 0 1 1 115,204"},             # retina
        {"d": "M101,88 L126,118"}, {"d": "M101,212 L126,182"},   # iris
        {"d": _e(140, 150, 22, 38)},                         # lens
        {"d": "M126,118 C132,122 134,126 136,132"},          # ciliary body
        {"d": "M126,182 C132,178 134,174 136,168"},
        {"d": "M284,232 C308,252 324,268 338,282"},          # optic nerve
        {"d": "M306,214 C330,234 346,250 358,264"},
    ],
    "parts": {
        "cornea": {"x": 46, "y": 150, "side": "L"},
        "pupil": {"x": 104, "y": 150, "side": "L"},
        "iris": {"x": 112, "y": 108, "side": "L"},
        "lens": {"x": 140, "y": 150, "side": "L"},
        "aqueous humour": {"x": 86, "y": 178, "side": "L"},
        "ciliary body": {"x": 134, "y": 186, "side": "L"},
        "vitreous humour": {"x": 206, "y": 150, "side": "R"},
        "retina": {"x": 302, "y": 112, "side": "R"},
        "choroid": {"x": 308, "y": 92, "side": "R"},
        "sclera": {"x": 300, "y": 68, "side": "R"},
        "optic nerve": {"x": 332, "y": 268, "side": "R"},
        "blind spot": {"x": 292, "y": 224, "side": "R"},
        "yellow spot": {"x": 320, "y": 160, "side": "R"},
    },
    "aliases": {
        "conjunctiva": "cornea", "crystalline lens": "lens", "eye lens": "lens",
        "aqueous chamber": "aqueous humour", "aqueous humor": "aqueous humour",
        "vitreous humor": "vitreous humour", "vitreous chamber": "vitreous humour",
        "ciliary muscle": "ciliary body", "ciliary muscles": "ciliary body",
        "suspensory ligament": "ciliary body",
        "optic disc": "blind spot", "macula": "yellow spot",
        "fovea": "yellow spot", "fovea centralis": "yellow spot",
        "white of the eye": "sclera", "sclerotic": "sclera",
    },
}

ANIMAL_CELL = {
    "id": "animal-cell",
    "title": "Animal cell",
    "names": ["animal cell", "a typical animal cell", "structure of an animal cell",
              "eukaryotic cell", "typical animal cell", "cell"],
    "box": {"w": 380, "h": 300},
    "strokes": [
        {"d": "M20,150 C20,80 96,22 190,22 C284,22 360,80 360,150 "
              "C360,220 284,278 190,278 C96,278 20,220 20,150 Z"},   # membrane
        {"d": _e(150, 130, 50, 44)},                         # nucleus
        {"d": _e(150, 130, 46, 40)},                         # its envelope
        {"d": _e(156, 126, 15, 15)},                         # nucleolus
        # the ER as folded sheets beside the nucleus: a single squiggle at
        # this size is just a scribble, and a scribble is not a label
        {"d": "M206,100 C228,110 228,126 206,134 C228,142 228,158 206,166"},
        {"d": "M216,96 C240,108 240,126 216,134 C240,144 240,160 216,170"},
        {"d": _dot(210, 102)}, {"d": _dot(220, 120)}, {"d": _dot(208, 150)},
        {"d": _dot(224, 160)}, {"d": _dot(214, 132)},        # ribosomes on it
        {"d": _e(300, 100, 36, 19)},                         # mitochondria
        {"d": "M272,92 C282,104 290,90 300,102 C308,112 316,96 328,106"},
        {"d": _e(118, 238, 36, 19)},
        {"d": "M90,230 C100,242 108,228 118,240 C126,250 134,234 146,244"},
        {"d": "M256,180 C276,168 308,168 330,178"},          # golgi
        {"d": "M258,191 C278,179 310,179 332,189"},
        {"d": "M260,202 C280,190 312,190 334,200"},
        {"d": _dot(342, 166, 5)}, {"d": _dot(344, 208, 4)},
        {"d": _e(214, 244, 15, 15)},                         # lysosome
        {"d": _e(86, 92, 24, 24)},                           # vacuole
        # two centrioles, at right angles, the way they are always drawn
        {"d": "M104,176 L124,184"}, {"d": "M106,170 L126,178"},
        {"d": "M136,170 L130,192"}, {"d": "M142,172 L136,194"},
    ],
    "parts": {
        "cell membrane": {"x": 250, "y": 28, "side": "R"},
        "cytoplasm": {"x": 170, "y": 214, "side": "L"},
        "nucleus": {"x": 134, "y": 160, "side": "L"},
        "nucleolus": {"x": 156, "y": 126, "side": "L"},
        "nuclear membrane": {"x": 110, "y": 106, "side": "L"},
        "mitochondrion": {"x": 300, "y": 100, "side": "R"},
        "golgi apparatus": {"x": 294, "y": 191, "side": "R"},
        "endoplasmic reticulum": {"x": 222, "y": 134, "side": "R"},
        "ribosome": {"x": 224, "y": 160, "side": "R"},
        "lysosome": {"x": 214, "y": 244, "side": "R"},
        "vacuole": {"x": 86, "y": 92, "side": "L"},
        "centrosome": {"x": 120, "y": 180, "side": "L"},
    },
    "aliases": {
        "plasma membrane": "cell membrane", "cell surface membrane": "cell membrane",
        "plasmalemma": "cell membrane", "membrane": "cell membrane",
        "mitochondria": "mitochondrion", "golgi body": "golgi apparatus",
        "golgi complex": "golgi apparatus", "golgi": "golgi apparatus",
        "er": "endoplasmic reticulum",
        "rough endoplasmic reticulum": "endoplasmic reticulum",
        "smooth endoplasmic reticulum": "endoplasmic reticulum",
        "ribosomes": "ribosome", "lysosomes": "lysosome",
        "nuclear envelope": "nuclear membrane", "karyotheca": "nuclear membrane",
        "centriole": "centrosome", "centrioles": "centrosome",
        "cytosol": "cytoplasm",
    },
}

PLANT_CELL = {
    "id": "plant-cell",
    "title": "Plant cell",
    "names": ["plant cell", "a typical plant cell", "structure of a plant cell",
              "typical plant cell"],
    "box": {"w": 380, "h": 300},
    "strokes": [
        # written out in absolute coordinates, like every other stroke here, so
        # a stray number is a number that can be checked against the box
        {"d": "M24,36 L356,36 A16,16 0 0 1 372,52 L372,248 A16,16 0 0 1 356,264 "
              "L24,264 A16,16 0 0 1 8,248 L8,52 A16,16 0 0 1 24,36 Z"},     # cell wall
        {"d": "M34,46 L346,46 A12,12 0 0 1 358,58 L358,242 A12,12 0 0 1 346,254 "
              "L34,254 A12,12 0 0 1 22,242 L22,58 A12,12 0 0 1 34,46 Z"},   # membrane
        {"d": _e(196, 152, 116, 76)},                        # central vacuole
        {"d": _e(196, 152, 110, 70)},                        # tonoplast
        {"d": _e(82, 84, 40, 34)},                           # nucleus
        {"d": _e(86, 82, 13, 13)},                           # nucleolus
        {"d": _e(300, 82, 26, 15)},                          # chloroplasts
        {"d": _dot(288, 80)}, {"d": _dot(299, 86)}, {"d": _dot(310, 78)},
        {"d": _e(310, 214, 26, 15)},
        {"d": _dot(298, 212)}, {"d": _dot(309, 218)}, {"d": _dot(320, 210)},
        {"d": _e(120, 232, 26, 15)},
        {"d": _dot(108, 230)}, {"d": _dot(119, 236)}, {"d": _dot(130, 228)},
        {"d": _e(54, 160, 28, 15)},                          # mitochondrion
        {"d": "M34,153 C42,165 50,153 58,165 C64,173 72,159 78,167"},
    ],
    "parts": {
        "cell wall": {"x": 220, "y": 36, "side": "R"},
        "cell membrane": {"x": 220, "y": 48, "side": "R"},
        "central vacuole": {"x": 196, "y": 152, "side": "R"},
        "tonoplast": {"x": 294, "y": 186, "side": "R"},
        "nucleus": {"x": 68, "y": 100, "side": "L"},
        "nucleolus": {"x": 86, "y": 82, "side": "L"},
        "chloroplast": {"x": 300, "y": 82, "side": "R"},
        "mitochondrion": {"x": 54, "y": 160, "side": "L"},
        "cytoplasm": {"x": 170, "y": 246, "side": "L"},
    },
    "aliases": {
        "cellulose cell wall": "cell wall", "plasma membrane": "cell membrane",
        "cell surface membrane": "cell membrane",
        "vacuole": "central vacuole", "sap vacuole": "central vacuole",
        "cell sap": "central vacuole", "vacuolar membrane": "tonoplast",
        "chloroplasts": "chloroplast", "plastid": "chloroplast",
        "chlorophyll": "chloroplast", "mitochondria": "mitochondrion",
        "nuclear membrane": "nucleus", "cytosol": "cytoplasm",
    },
}

FIGURES = [NEURON, HEART, BRAIN, EYE, ANIMAL_CELL, PLANT_CELL]


# --------------------------------------------------------------------------
# matching
# --------------------------------------------------------------------------

_NOISE = re.compile(
    r"^(the|a|an|structure of|parts of|diagram of|labelled|labeled|"
    r"well labelled|well labeled|neat|sketch of|section of|human|typical)\s+")


def normalise(text: str) -> str:
    """'The Left Ventricles ' -> 'left ventricle'. Spelling, not meaning."""
    s = re.sub(r"[^a-z0-9 ]+", " ", text.lower())
    s = re.sub(r"\s+", " ", s).strip()
    for _ in range(4):                      # "diagram of the human heart"
        new = _NOISE.sub("", s)
        if new == s:
            break
        s = new
    words = []
    for w in s.split():
        # plurals, but not nucleus -> nucleu or process -> proces
        if len(w) > 4 and w.endswith("s") and not w.endswith(("ss", "us", "is", "as")):
            w = w[:-1]
        words.append(w)
    return " ".join(words)


def _index(fig: dict) -> dict:
    """Every spelling of every part of this figure -> its canonical name."""
    if "_index" not in fig:
        idx = {}
        for canon in fig["parts"]:
            idx[normalise(canon)] = canon
        for spelling, canon in fig.get("aliases", {}).items():
            if canon in fig["parts"]:
                idx.setdefault(normalise(spelling), canon)
        fig["_index"] = idx
    return fig["_index"]


def find(whole: str) -> dict | None:
    """The figure a label names, if we can draw it."""
    want = normalise(whole)
    if not want:
        return None
    for fig in FIGURES:
        if any(normalise(n) == want for n in fig["names"]):
            return fig
    # "heart of a mammal", "labelled diagram of neuron" - the object is in there
    for fig in FIGURES:
        for n in fig["names"]:
            nn = normalise(n)
            if len(nn) >= 4 and re.search(rf"\b{re.escape(nn)}\b", want):
                return fig
    return None


def resolve(fig: dict, part: str) -> str | None:
    """Which anchor a part name refers to, or None if we cannot place it."""
    idx = _index(fig)
    want = normalise(part)
    if not want:
        return None
    if want in idx:
        return idx[want]
    # "left ventricle (thick wall)" or "the aorta - largest artery"
    head = re.split(r"\s*[(–:,-]", part, 1)[0]
    if head and head != part:
        return resolve(fig, head)
    # a part named inside a longer phrase: "wall of the left ventricle"
    best = None
    for spelling, canon in idx.items():
        if len(spelling) >= 4 and re.search(rf"\b{re.escape(spelling)}\b", want):
            if best is None or len(spelling) > len(best[0]):
                best = (spelling, canon)
    return best[1] if best else None


def match(whole: str, parts: list[dict]) -> dict | None:
    """Build a drawable figure from a labelled edge list.

    `parts` is [{"label": <part as the model wrote it>, "note": <what it does>}].
    Returns None when this is not a figure we hold, or when too little of it
    resolved to be worth drawing - the caller then falls back to the ordinary
    labelled layout, which is honest about being a diagram of names.
    """
    fig = find(whole)
    if not fig:
        return None
    placed, used, dropped = [], set(), []
    for p in parts:
        canon = resolve(fig, p["label"])
        if not canon or canon in used:
            dropped.append(p["label"])
            continue
        used.add(canon)
        anchor = fig["parts"][canon]
        placed.append({"label": p["label"].strip() or canon,
                       "note": p.get("note", ""),
                       "part": canon,
                       "x": anchor["x"], "y": anchor["y"],
                       "side": anchor.get("side")
                       or ("R" if anchor["x"] > fig["box"]["w"] / 2 else "L")})
        if len(placed) >= MAX_PARTS:
            break
    if len(placed) < MIN_PARTS:
        return None
    if len(placed) < MIN_COVERAGE * (len(placed) + len(dropped)):
        return None
    placed.sort(key=lambda p: (p["side"] == "R", p["y"]))
    return {
        "id": fig["id"],
        "title": fig["title"],
        "box": dict(fig["box"]),
        "strokes": [s["d"] for s in fig["strokes"]],
        "parts": placed,
        "dropped": dropped,
    }


def prompt_hint(text: str) -> str:
    """The labels we can actually place, for the object a question is about.

    Without this the model names whatever it likes - atria, SA node, Purkinje
    fibres - and we either hold the anchor or the student loses the label. The
    list only goes into the prompt when the question is about something we can
    draw, so it costs nothing on the other questions.
    """
    fig = find(text)
    if not fig:
        for word in re.findall(r"[A-Za-z][A-Za-z ]{2,30}", text):
            fig = find(word)
            if fig:
                break
    if not fig:
        return ""
    return (f"We can draw the {fig['names'][0]} properly, so draw it rather "
            f"than describing it. Label it using these names exactly, "
            f"choosing the ones the question needs: "
            + ", ".join(fig["parts"]) + ".")


def names() -> list[str]:
    """What the model may ask for, for the prompt."""
    return [f["names"][0] for f in FIGURES]
