#!/usr/bin/env python3
"""Convert inbox images into the e-paper panel's six-color packed format.

Reads
    inbox/<id>.<jpg|png|...>      source image as uploaded
    inbox/<id>.json               optional sidecar: {"name", "caption", "fit", "uploaded_at"}
    frame/settings.json           rotation, palette, enhance, default_fit
Writes
    frame/img/<id>.bin            960,000 bytes: panel-native portrait 1200x1600, two pixels
                                  per byte, high nibble = left pixel, color codes
                                  black 0, white 1, yellow 2, red 3, blue 5, green 6
    frame/img/<id>_thumb.jpg      400 px wide, original look
    frame/img/<id>_preview.png    800 px wide, the dithered result in palette colors
    frame/manifest.json           what the frame and the website read

Incremental: an image is re-converted only when its source bytes or the settings changed,
or with --force. Outputs whose source disappeared from the inbox are deleted.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image, ImageEnhance, ImageOps

PANEL_W, PANEL_H = 1200, 1600  # native portrait orientation of the driver
BIN_SIZE = PANEL_W * PANEL_H // 2  # 960,000 bytes
COLOR_ORDER = ["black", "white", "yellow", "red", "blue", "green"]
COLOR_CODE = {"black": 0x0, "white": 0x1, "yellow": 0x2, "red": 0x3, "blue": 0x5, "green": 0x6}
SOURCE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif", ".tif", ".tiff"}

DEFAULT_SETTINGS = {
    # Degrees counter-clockwise applied to the picture as the viewer sees it, to land it in the
    # driver's portrait buffer. 90 or 270 = frame hangs landscape; 0 or 180 = portrait.
    "rotation": 90,
    "palette": {
        "black": [0, 0, 0],
        "white": [255, 255, 255],
        "yellow": [255, 255, 0],
        "red": [255, 0, 0],
        "blue": [0, 0, 255],
        "green": [0, 255, 0],
    },
    "enhance": {"autocontrast": True, "autocontrast_cutoff": 1, "saturation": 1.25},
    "default_fit": "cover",  # cover = crop to fill, contain = letterbox on white
}


def log(msg: str) -> None:
    print(msg, flush=True)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_settings(path: Path) -> dict:
    settings = json.loads(json.dumps(DEFAULT_SETTINGS))
    if path.exists():
        user = json.loads(path.read_text(encoding="utf-8"))
        for key, value in user.items():
            if isinstance(value, dict) and isinstance(settings.get(key), dict):
                settings[key].update(value)
            else:
                settings[key] = value
    if settings["rotation"] not in (0, 90, 180, 270):
        raise SystemExit(f"settings.rotation must be 0, 90, 180 or 270, got {settings['rotation']}")
    return settings


def settings_hash(settings: dict) -> str:
    relevant = {k: settings[k] for k in ("rotation", "palette", "enhance", "default_fit")}
    return hashlib.sha256(json.dumps(relevant, sort_keys=True).encode()).hexdigest()[:12]


def target_size(rotation: int) -> tuple[int, int]:
    """Size of the picture as viewed: landscape when the buffer gets a 90/270 turn."""
    return (PANEL_H, PANEL_W) if rotation in (90, 270) else (PANEL_W, PANEL_H)


def palette_image(palette: dict) -> Image.Image:
    flat: list[int] = []
    for name in COLOR_ORDER:
        flat.extend(int(c) for c in palette[name])
    flat.extend([0, 0, 0] * (256 - len(COLOR_ORDER)))  # pad with black
    pal = Image.new("P", (1, 1))
    pal.putpalette(flat)
    return pal


def fit_image(img: Image.Image, size: tuple[int, int], fit: str) -> Image.Image:
    if fit == "contain":
        inner = ImageOps.contain(img, size, Image.Resampling.LANCZOS)
        canvas = Image.new("RGB", size, (255, 255, 255))
        canvas.paste(inner, ((size[0] - inner.width) // 2, (size[1] - inner.height) // 2))
        return canvas
    return ImageOps.fit(img, size, Image.Resampling.LANCZOS, centering=(0.5, 0.5))


def enhance_image(img: Image.Image, enhance: dict) -> Image.Image:
    if enhance.get("autocontrast"):
        img = ImageOps.autocontrast(img, cutoff=float(enhance.get("autocontrast_cutoff", 1)))
    saturation = float(enhance.get("saturation", 1.0))
    if abs(saturation - 1.0) > 1e-6:
        img = ImageEnhance.Color(img).enhance(saturation)
    return img


def dither(img: Image.Image, pal: Image.Image) -> Image.Image:
    """Floyd-Steinberg to the fixed six-color palette. Returns a 'P' image."""
    return img.convert("RGB").quantize(palette=pal, dither=Image.Dither.FLOYDSTEINBERG)


def pack_native(q: Image.Image) -> bytes:
    """Palette indexes -> panel color codes -> two pixels per byte, high nibble first."""
    if q.size != (PANEL_W, PANEL_H):
        raise ValueError(f"expected native {PANEL_W}x{PANEL_H}, got {q.size}")
    table = bytes(COLOR_CODE[COLOR_ORDER[i]] if i < len(COLOR_ORDER) else COLOR_CODE["black"] for i in range(256))
    codes = q.tobytes().translate(table)
    hi, lo = codes[0::2], codes[1::2]
    packed = bytes((h << 4) | l for h, l in zip(hi, lo))
    if len(packed) != BIN_SIZE:
        raise ValueError(f"packed {len(packed)} bytes, expected {BIN_SIZE}")
    return packed


def read_sidecar(src: Path) -> dict:
    sidecar = src.with_suffix(".json")
    if sidecar.exists():
        try:
            return json.loads(sidecar.read_text(encoding="utf-8"))
        except json.JSONDecodeError as e:
            log(f"  warning: bad sidecar {sidecar.name}: {e}")
    return {}


def iso_utc(ts: float) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def convert_one(src: Path, meta: dict, settings: dict, img_dir: Path, pal: Image.Image) -> dict:
    image_id = src.stem
    fit = meta.get("fit") or settings["default_fit"]
    if fit not in ("cover", "contain"):
        fit = settings["default_fit"]
    rotation = int(settings["rotation"])
    size = target_size(rotation)

    with Image.open(src) as opened:
        img = ImageOps.exif_transpose(opened).convert("RGB")
    fitted = fit_image(img, size, fit)

    thumb = fitted.copy()
    thumb.thumbnail((400, 400), Image.Resampling.LANCZOS)
    thumb_path = img_dir / f"{image_id}_thumb.jpg"
    thumb.save(thumb_path, "JPEG", quality=85, optimize=True)

    enhanced = enhance_image(fitted, settings["enhance"])
    q = dither(enhanced, pal)  # as viewed

    preview = q.convert("RGB")
    preview.thumbnail((800, 800), Image.Resampling.NEAREST)
    preview_path = img_dir / f"{image_id}_preview.png"
    preview.save(preview_path, "PNG", optimize=True)

    native = q.rotate(rotation, expand=True) if rotation else q
    packed = pack_native(native)
    bin_path = img_dir / f"{image_id}.bin"
    bin_path.write_bytes(packed)

    return {
        "id": image_id,
        "name": meta.get("name") or src.name,
        "caption": meta.get("caption", ""),
        "fit": fit,
        "uploaded_at": meta.get("uploaded_at") or iso_utc(src.stat().st_mtime),
        "source": f"inbox/{src.name}",
        "source_sha256": sha256_file(src),
        "settings_hash": settings_hash(settings),
        "bin": f"img/{bin_path.name}",
        "bin_sha256": hashlib.sha256(packed).hexdigest(),
        "size": len(packed),
        "thumb": f"img/{thumb_path.name}",
        "preview": f"img/{preview_path.name}",
        "width": size[0],
        "height": size[1],
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--inbox", default="inbox", type=Path)
    ap.add_argument("--out", default="frame", type=Path)
    ap.add_argument("--settings", default=None, type=Path, help="default: <out>/settings.json")
    ap.add_argument("--force", action="store_true", help="re-convert everything")
    args = ap.parse_args()

    settings_path = args.settings or (args.out / "settings.json")
    settings = load_settings(settings_path)
    shash = settings_hash(settings)
    pal = palette_image(settings["palette"])
    img_dir = args.out / "img"
    img_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = args.out / "manifest.json"

    previous: dict[str, dict] = {}
    if manifest_path.exists() and not args.force:
        try:
            for entry in json.loads(manifest_path.read_text(encoding="utf-8")).get("images", []):
                previous[entry["id"]] = entry
        except (json.JSONDecodeError, KeyError, TypeError):
            log("warning: existing manifest unreadable, rebuilding everything")

    sources = sorted(p for p in args.inbox.iterdir() if p.suffix.lower() in SOURCE_EXT) if args.inbox.exists() else []
    entries: list[dict] = []
    converted = reused = failed = 0
    for src in sources:
        meta = read_sidecar(src)
        old = previous.get(src.stem)
        outputs_exist = old and all((args.out / old[k]).exists() for k in ("bin", "thumb", "preview"))
        if old and outputs_exist and old.get("settings_hash") == shash and old.get("source_sha256") == sha256_file(src):
            # Sidecar text (name, caption) may still have changed; refresh it without re-converting.
            old = dict(old)
            old["name"] = meta.get("name") or old.get("name") or src.name
            old["caption"] = meta.get("caption", old.get("caption", ""))
            entries.append(old)
            reused += 1
            continue
        log(f"converting {src.name} ...")
        try:
            entries.append(convert_one(src, meta, settings, img_dir, pal))
            converted += 1
        except Exception as e:  # keep going; one bad upload must not block the rest
            failed += 1
            log(f"  FAILED {src.name}: {e}")

    keep = {e["id"] for e in entries}
    removed = 0
    for path in img_dir.iterdir():
        stem = path.name.split("_")[0].split(".")[0]
        if path.name != ".gitkeep" and stem not in keep:
            path.unlink()
            removed += 1

    entries.sort(key=lambda e: (e.get("uploaded_at", ""), e["id"]))
    manifest = {
        "version": 1,
        "generated_at": iso_utc(datetime.now(tz=timezone.utc).timestamp()),
        "rotation": int(settings["rotation"]),
        "panel": {"width": PANEL_W, "height": PANEL_H, "bin_size": BIN_SIZE},
        "settings_hash": shash,
        "count": len(entries),
        "images": entries,
    }
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    log(f"done: {converted} converted, {reused} reused, {removed} stale files removed, {failed} failed, {len(entries)} images in manifest")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
