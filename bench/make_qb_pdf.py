"""Make a realistic scanned question paper to import.

Deliberately an image-only PDF: no text layer, so importing it has to go
through Tesseract, which is the path a student actually uses when they
photograph or scan a paper handed out in class. A PDF exported from Word
would exercise almost nothing.

    .venv\\Scripts\\python.exe bench\\make_qb_pdf.py [out.pdf]
"""
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

W, H = 1654, 2339            # A4 at 200 dpi
MARGIN = 150

PAGES = [
    [("DEPARTMENT OF ELECTRONICS AND COMMUNICATION", "head"),
     ("BEC24502 - DIGITAL SIGNAL PROCESSING", "head"),
     ("Question Bank", "head"),
     ("", "gap"),
     ("MODULE-2", "module"),
     ("Explain the overlap add method of filtering long data sequences.", "q"),
     ("Explain the overlap save method with a neat block diagram.", "q"),
     ("Derive the decimation in time FFT algorithm for N = 8.", "q"),
     ("Compute the 8 point DFT of x(n) = {1, 2, 3, 4, 4, 3, 2, 1} using DIT FFT.", "q"),
     ("Compare DIT and DIF FFT algorithms.", "q"),
     ("Determine the number of complex multiplications saved by FFT over", "q"),
     ("   direct DFT computation for N = 64.", "cont"),
     ("State and prove the symmetry property of the twiddle factor.", "q"),
     ],
    [("MODULE-3", "module"),
     ("Explain the design of FIR filters using the window method.", "q"),
     ("Compare rectangular, Hamming and Hanning windows.", "q"),
     ("Design a linear phase FIR low pass filter of length 7 with cutoff", "q"),
     ("   frequency 1 rad/sec using a Hamming window.", "cont"),
     ("Explain the frequency sampling method of FIR filter design.", "q"),
     ("What are the advantages of FIR filters over IIR filters?", "q"),
     ("Realise the given FIR system in direct form I and direct form II.", "q"),
     ],
]


def _font(size: int, bold: bool = False):
    for name in (("arialbd.ttf", "calibrib.ttf") if bold else ("arial.ttf", "calibri.ttf")):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def render_page(lines) -> Image.Image:
    im = Image.new("RGB", (W, H), "white")
    d = ImageDraw.Draw(im)
    body, head, mod = _font(40), _font(46, True), _font(44, True)
    y = MARGIN
    for text, kind in lines:
        if kind == "gap":
            y += 50
            continue
        if kind == "head":
            w = d.textlength(text, font=head)
            d.text(((W - w) / 2, y), text, font=head, fill="black")
            y += 70
        elif kind == "module":
            y += 40
            d.text((MARGIN, y), text, font=mod, fill="black")
            y += 80
        elif kind == "cont":
            d.text((MARGIN, y), text, font=body, fill="black")
            y += 62
        else:
            d.text((MARGIN, y), text, font=body, fill="black")
            y += 62
    # a scan is never perfectly clean or perfectly square
    return im.rotate(0.35, resample=Image.BICUBIC, fillcolor="white")


def main() -> int:
    out = Path(sys.argv[1] if len(sys.argv) > 1
               else Path(__file__).with_name("sample-qb.pdf"))
    pages = [render_page(p) for p in PAGES]
    pages[0].save(out, "PDF", resolution=200.0, save_all=True,
                  append_images=pages[1:])
    print(f"wrote {out}  ({len(pages)} pages, image-only - needs OCR)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
