#!/usr/bin/env python3
"""Generate a test card for the frame: the six panel colors, gradients, and orientation labels.

    python tools/make_testcard.py --out inbox/testcard.png [--portrait]

Shows on the panel which way is up, whether the colors map correctly, and how dithering handles
gradients. Landscape (1600x1200) by default.
"""
from __future__ import annotations

import argparse
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

COLORS = [
    ("black", (0, 0, 0)), ("white", (255, 255, 255)), ("yellow", (255, 255, 0)),
    ("red", (255, 0, 0)), ("blue", (0, 0, 255)), ("green", (0, 255, 0)),
]


def font(size: int):
    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # very old Pillow
        return ImageFont.load_default()


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", type=Path, default=Path("inbox/testcard.png"))
    ap.add_argument("--portrait", action="store_true")
    args = ap.parse_args()

    w, h = (1200, 1600) if args.portrait else (1600, 1200)
    img = Image.new("RGB", (w, h), (255, 255, 255))
    d = ImageDraw.Draw(img)
    big, mid, small = font(96), font(48), font(32)

    # Color bars across the top third
    bar_h = h // 3
    bar_w = w // len(COLORS)
    for i, (name, rgb) in enumerate(COLORS):
        d.rectangle([i * bar_w, 0, (i + 1) * bar_w - 1, bar_h], fill=rgb)
        d.text((i * bar_w + 16, bar_h - 56), name, fill=(128, 128, 128) if name in ("white", "yellow") else (255, 255, 255), font=small)

    # Gray ramp and hue sweep in the middle third
    ramp_top = bar_h + 20
    ramp_h = (h // 3 - 40) // 2
    for x in range(w):
        g = int(255 * x / (w - 1))
        d.line([(x, ramp_top), (x, ramp_top + ramp_h)], fill=(g, g, g))
    hue_top = ramp_top + ramp_h + 10
    for x in range(w):
        hsv = Image.new("HSV", (1, 1), (int(255 * x / (w - 1)), 255, 255)).convert("RGB").getpixel((0, 0))
        d.line([(x, hue_top), (x, hue_top + ramp_h)], fill=hsv)

    # Labels and a border in the bottom third
    d.rectangle([8, 8, w - 9, h - 9], outline=(0, 0, 0), width=6)
    d.text((w // 2, 2 * h // 3 + 40), "eink-frame test card", fill=(0, 0, 0), font=big, anchor="mt")
    d.text((w // 2, 2 * h // 3 + 160), f"{w} x {h}", fill=(0, 0, 255), font=mid, anchor="mt")
    d.text((w // 2, 30), "TOP", fill=(255, 255, 255), font=mid, anchor="mt")
    d.text((w // 2, h - 30), "BOTTOM", fill=(0, 0, 0), font=mid, anchor="mb")
    d.text((30, h // 2), "LEFT", fill=(255, 0, 0), font=mid, anchor="lm")
    d.text((w - 30, h // 2), "RIGHT", fill=(255, 0, 0), font=mid, anchor="rm")

    # Checkerboards of increasing fineness
    y0 = h - 200
    for k, cell in enumerate((32, 16, 8, 4)):
        x0 = 60 + k * 240
        for yy in range(0, 160, cell):
            for xx in range(0, 200, cell):
                if ((xx // cell) + (yy // cell)) % 2 == 0:
                    d.rectangle([x0 + xx, y0 + yy, x0 + xx + cell - 1, y0 + yy + cell - 1], fill=(0, 0, 0))

    args.out.parent.mkdir(parents=True, exist_ok=True)
    img.save(args.out, "PNG", optimize=True)
    print(f"wrote {args.out} ({w}x{h})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
