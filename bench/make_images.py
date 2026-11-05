"""Generate handwriting-style question images for benchmarking.

These use Windows handwriting fonts with per-glyph jitter/rotation as a stand-in
for real pen input. They are a proxy: good enough for latency/RAM numbers and a
rough accuracy signal, but real stylus handwriting is messier.
"""
import math, random, sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).parent / "images"
OUT.mkdir(exist_ok=True)

FONTS = [
    r"C:\Windows\Fonts\Inkfree.ttf",
    r"C:\Windows\Fonts\segoesc.ttf",
    r"C:\Windows\Fonts\segoepr.ttf",
]

W, H = 1240, 1754  # A4 at 150dpi
INK = (26, 32, 54)


def ruled(img):
    d = ImageDraw.Draw(img)
    for y in range(140, H, 56):
        d.line([(80, y), (W - 60, y)], fill=(222, 230, 242), width=2)
    d.line([(110, 60), (110, H - 60)], fill=(246, 206, 206), width=2)
    return d


def write_line(d, text, x, y, font, seed):
    rnd = random.Random(seed)
    cx = x
    for ch in text:
        if ch == " ":
            cx += font.getlength(" ") * rnd.uniform(0.9, 1.3)
            continue
        w = font.getlength(ch)
        glyph = Image.new("RGBA", (int(w) + 24, font.size + 30), (0, 0, 0, 0))
        gd = ImageDraw.Draw(glyph)
        gd.text((12, 10), ch, font=font, fill=INK + (255,))
        glyph = glyph.rotate(rnd.uniform(-5.5, 5.5), resample=Image.BICUBIC, expand=False)
        dy = int(rnd.uniform(-4, 4) + 3 * math.sin(cx / 70.0))
        d._image.paste(glyph, (int(cx) - 12, int(y) - 10 + dy), glyph)
        cx += w * rnd.uniform(0.94, 1.06)
    return cx


SAMPLES = {
    "calculus": [
        "Q1. Evaluate the integral",
        "   I = $ x^2 . e^(3x) dx",
        "using integration by parts.",
        "Show all steps clearly.",
    ],
    "physics": [
        "Q2. A block of mass m = 5 kg rests",
        "on a rough incline of angle 30 deg.",
        "If mu = 0.25, find the acceleration",
        "of the block down the incline.",
        "Take g = 9.8 m/s^2.",
    ],
    "theory": [
        "Q3. Explain the difference between",
        "process and thread in an operating",
        "system. Mention context switching",
        "overhead and shared memory.",
    ],
    "algebra": [
        "Q4. Solve for x :",
        "   2x^2 - 7x + 3 = 0",
        "Hence find the sum and product",
        "of the roots.",
    ],
}


def build(name, lines, font_path, seed):
    img = Image.new("RGB", (W, H), (253, 252, 248))
    d = ruled(img)
    d._image = img
    font = ImageFont.truetype(font_path, 46)
    y = 190
    for i, ln in enumerate(lines):
        write_line(d, ln, 150, y, font, seed + i)
        y += 86
    p = OUT / f"{name}.png"
    img.save(p)
    return p


if __name__ == "__main__":
    for i, (name, lines) in enumerate(SAMPLES.items()):
        p = build(name, lines, FONTS[i % len(FONTS)], 1000 + i * 37)
        print("wrote", p)
