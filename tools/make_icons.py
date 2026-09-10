#!/usr/bin/env python3
"""Generate the site's home-screen icons (docs/icon-192.png, docs/icon-512.png)."""
from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw


def icon(size: int) -> Image.Image:
    s = size
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.22), fill=(28, 28, 28, 255))
    # frame bezel and "paper"
    m = int(s * 0.14)
    d.rounded_rectangle([m, m + int(s * 0.04), s - m, s - m - int(s * 0.04)], radius=int(s * 0.05), fill=(246, 244, 239, 255))
    inner = [m + int(s * 0.05), m + int(s * 0.09), s - m - int(s * 0.05), s - m - int(s * 0.09)]
    d.rectangle(inner, fill=(255, 255, 255, 255))
    # a sun and hills in the six panel colors
    x0, y0, x1, y1 = inner
    w, h = x1 - x0, y1 - y0
    d.ellipse([x0 + int(w * 0.62), y0 + int(h * 0.12), x0 + int(w * 0.84), y0 + int(h * 0.42)], fill=(229, 193, 0, 255))
    d.polygon([(x0, y1), (x0 + int(w * 0.35), y0 + int(h * 0.45)), (x0 + int(w * 0.62), y1)], fill=(47, 125, 74, 255))
    d.polygon([(x0 + int(w * 0.4), y1), (x0 + int(w * 0.72), y0 + int(h * 0.55)), (x1, y1)], fill=(30, 80, 170, 255))
    d.rectangle([x0, y1 - int(h * 0.12), x1, y1], fill=(180, 40, 40, 255))
    return img


def main() -> int:
    out = Path("docs")
    for size in (192, 512):
        icon(size).save(out / f"icon-{size}.png", "PNG", optimize=True)
        print(f"wrote {out / f'icon-{size}.png'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
