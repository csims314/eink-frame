#!/usr/bin/env python3
"""Decode a panel .bin (or Waveshare's ImageData.c) back into a PNG, for eyeballing.

    python tools/decode_bin.py frame/img/<id>.bin -o out.png
    python tools/decode_bin.py path/to/ImageData.c -o waveshare.png
    python tools/decode_bin.py x.bin --rotation 90 -o viewed.png   # undo the buffer rotation

The .bin is panel-native portrait 1200x1600, two pixels per byte, high nibble first,
codes black 0, white 1, yellow 2, red 3, blue 5, green 6. Unknown codes come out magenta.
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

from PIL import Image

PANEL_W, PANEL_H = 1200, 1600
BIN_SIZE = PANEL_W * PANEL_H // 2

CODE_RGB = {
    0x0: (0, 0, 0),
    0x1: (255, 255, 255),
    0x2: (255, 255, 0),
    0x3: (255, 0, 0),
    0x5: (0, 0, 255),
    0x6: (0, 255, 0),
}
UNKNOWN = (255, 0, 255)


def load_bytes(path: Path) -> bytes:
    if path.suffix.lower() in (".c", ".h", ".txt"):
        text = path.read_text(encoding="utf-8", errors="replace")
        start = text.find("Image6color")
        if start < 0:
            start = 0
        tokens = re.findall(r"0[xX][0-9a-fA-F]{1,2}", text[start:])
        return bytes(int(t, 16) for t in tokens)
    return path.read_bytes()


def decode(data: bytes) -> Image.Image:
    if len(data) != BIN_SIZE:
        print(f"warning: {len(data)} bytes, expected {BIN_SIZE}", file=sys.stderr)
        data = data[:BIN_SIZE].ljust(BIN_SIZE, b"\x11")
    lut = []
    for b in range(256):
        hi, lo = CODE_RGB.get(b >> 4, UNKNOWN), CODE_RGB.get(b & 0xF, UNKNOWN)
        lut.append(bytes(hi + lo))
    rgb = b"".join(map(lut.__getitem__, data))
    return Image.frombytes("RGB", (PANEL_W, PANEL_H), rgb)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("input", type=Path)
    ap.add_argument("-o", "--out", type=Path, default=None)
    ap.add_argument("--rotation", type=int, default=0, help="settings.rotation used when encoding; undone here")
    args = ap.parse_args()

    data = load_bytes(args.input)
    img = decode(data)
    if args.rotation:
        img = img.rotate(-args.rotation, expand=True)
    out = args.out or args.input.with_suffix(".png")
    img.save(out, "PNG", optimize=True)
    counts: dict[int, int] = {}
    for b in data:
        counts[b >> 4] = counts.get(b >> 4, 0) + 1
        counts[b & 0xF] = counts.get(b & 0xF, 0) + 1
    names = {0: "black", 1: "white", 2: "yellow", 3: "red", 5: "blue", 6: "green"}
    summary = ", ".join(f"{names.get(k, f'code{k}')}={v}" for k, v in sorted(counts.items()))
    print(f"wrote {out} ({img.size[0]}x{img.size[1]}); pixel codes: {summary}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
