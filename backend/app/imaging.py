"""Notebook image preprocessing before vision inference.

A notebook page is mostly blank. Sending the whole page wastes prefill tokens and
hurts accuracy, so we crop to the inked bounding box and cap the long side.
"""
from __future__ import annotations

import base64
import io

from PIL import Image

# ruled lines are pale; real ink is dark. Anything darker than this is ink.
INK_THRESHOLD = 170
PAD = 36
MAX_SIDE = 1400


def decode(data: str | bytes) -> Image.Image:
    if isinstance(data, str):
        if "," in data and data.strip().startswith("data:"):
            data = data.split(",", 1)[1]
        data = base64.b64decode(data)
    im = Image.open(io.BytesIO(data))
    if im.mode in ("RGBA", "LA", "P"):
        bg = Image.new("RGB", im.size, (255, 255, 255))
        im = im.convert("RGBA")
        bg.paste(im, mask=im.split()[-1])
        im = bg
    return im.convert("RGB")


def ink_bbox(im: Image.Image, threshold: int = INK_THRESHOLD):
    mask = im.convert("L").point(lambda v: 255 if v < threshold else 0, "L")
    return mask.getbbox()


def prepare(im: Image.Image, pad: int = PAD, max_side: int = MAX_SIDE) -> tuple[Image.Image, dict]:
    """Crop to ink and downscale. Returns (image, info)."""
    info: dict = {"original": im.size, "cropped": False, "scaled": False}
    box = ink_bbox(im)
    if box:
        l, t, r, b = box
        im = im.crop((max(0, l - pad), max(0, t - pad),
                      min(im.width, r + pad), min(im.height, b + pad)))
        info["cropped"] = True
        info["ink_box"] = [l, t, r, b]
    else:
        info["blank"] = True

    if max(im.size) > max_side:
        s = max_side / max(im.size)
        im = im.resize((max(1, int(im.width * s)), max(1, int(im.height * s))),
                       Image.LANCZOS)
        info["scaled"] = True
    info["sent"] = im.size
    return im, info


def to_b64(im: Image.Image) -> str:
    buf = io.BytesIO()
    im.save(buf, format="PNG", optimize=True)
    return base64.b64encode(buf.getvalue()).decode()


def prepare_b64(data: str | bytes) -> tuple[str, dict]:
    im, info = prepare(decode(data))
    b64 = to_b64(im)
    info["bytes"] = len(b64) * 3 // 4
    return b64, info


def is_effectively_blank(data: str | bytes, min_ink_px: int = 60) -> bool:
    im = decode(data)
    mask = im.convert("L").point(lambda v: 255 if v < INK_THRESHOLD else 0, "L")
    hist = mask.histogram()
    return hist[255] < min_ink_px
