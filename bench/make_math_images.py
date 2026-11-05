"""Handwritten math samples that stress digit/exponent reading."""
import math, random
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).parent / "math_images"
OUT.mkdir(exist_ok=True)
FONTS = [r"C:\Windows\Fonts\Inkfree.ttf", r"C:\Windows\Fonts\segoesc.ttf"]

CASES = {
    "deriv4x2":  ("Find the derivative of 4x^2", "4x^2"),
    "deriv7x3":  ("Differentiate 7x^3 + 2x", "7x^3"),
    "integ3x2":  ("Evaluate the integral of 3x^2 dx", "3x^2"),
    "quad":      ("Solve 2x^2 - 7x + 3 = 0", "2x^2 - 7x + 3"),
    "frac":      ("Simplify (8x^4) / (2x^2)", "8x^4"),
}


def render(name, text, font_path, seed, w=1000, h=300):
    img = Image.new("RGB", (w, h), (253, 252, 248))
    d = ImageDraw.Draw(img)
    for y in range(70, h, 56):
        d.line([(30, y), (w - 30, y)], fill=(222, 230, 242), width=2)
    d._image = img
    font = ImageFont.truetype(font_path, 52)
    rnd = random.Random(seed)
    cx = 60.0
    for ch in text:
        if ch == " ":
            cx += font.getlength(" ") * rnd.uniform(0.9, 1.3)
            continue
        gw = font.getlength(ch)
        g = Image.new("RGBA", (int(gw) + 26, font.size + 34), (0, 0, 0, 0))
        ImageDraw.Draw(g).text((12, 10), ch, font=font, fill=(26, 32, 54, 255))
        g = g.rotate(rnd.uniform(-5, 5), resample=Image.BICUBIC)
        dy = int(rnd.uniform(-4, 4) + 3 * math.sin(cx / 70))
        img.paste(g, (int(cx) - 12, 96 + dy), g)
        cx += gw * rnd.uniform(0.94, 1.06)
    p = OUT / f"{name}.png"
    img.save(p)
    return p


if __name__ == "__main__":
    for i, (name, (text, _)) in enumerate(CASES.items()):
        print("wrote", render(name, text, FONTS[i % len(FONTS)], 500 + i))
