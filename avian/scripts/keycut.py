#!/usr/bin/env python3
"""Deterministic cream-ground removal (no onnxruntime).

The flat cream background is a known, uniform color, so we key it out by
flood-filling the background that is CONNECTED to the image border. That
protects cream/white pixels INSIDE the bird (they aren't border-connected),
which a naive global color threshold would wrongly erase. Edge is feathered
0.8 px to kill the anti-aliased halo, then cropped to the bird with a 2% margin
(matching cutout.py).
"""
from __future__ import annotations
import sys
from pathlib import Path
import numpy as np
from PIL import Image, ImageFilter

try:
    from scipy import ndimage
    HAVE_SCIPY = True
except Exception:
    HAVE_SCIPY = False

TOL = 34          # color distance from cream counted as "ground"
FEATHER = 0.8     # px gaussian to anti-alias the cut edge
MARGIN = 0.02

def keep_large_islands(fg: np.ndarray, min_frac: float = 0.02) -> np.ndarray:
    """Drop small disconnected foreground specks (stray twig/shadow marks the
    color-key left behind). Keep the bird plus any island >= 2% of its area."""
    if not HAVE_SCIPY:
        return fg
    lbl, n = ndimage.label(fg)
    if n <= 1:
        return fg
    counts = np.bincount(lbl.ravel())
    counts[0] = 0  # background label
    keep = np.where(counts >= max(1, min_frac * counts.max()))[0]
    return np.isin(lbl, keep)


def border_connected_bg(bgmask: np.ndarray) -> np.ndarray:
    """Keep only the background blobs that touch the image edge."""
    if HAVE_SCIPY:
        lbl, _ = ndimage.label(bgmask)
        keep = set(lbl[0, :]) | set(lbl[-1, :]) | set(lbl[:, 0]) | set(lbl[:, -1])
        keep.discard(0)
        return np.isin(lbl, list(keep))
    # Fallback: PIL flood fill from the four corners
    from PIL import ImageDraw
    h, w = bgmask.shape
    m = Image.fromarray((bgmask * 255).astype("uint8"), "L")
    seed = Image.new("L", (w, h), 0)
    # paint border-connected white via flood fill on a tri-color image
    work = m.copy()
    for sx, sy in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]:
        if work.getpixel((sx, sy)) > 127:
            ImageDraw.floodfill(work, (sx, sy), 128, thresh=10)
    return np.asarray(work) == 128

def cut(path: Path, tol: int = TOL) -> None:
    im = Image.open(path).convert("RGB")
    arr = np.asarray(im).astype(np.int16)
    frame = np.concatenate([
        arr[:4, :, :].reshape(-1, 3), arr[-4:, :, :].reshape(-1, 3),
        arr[:, :4, :].reshape(-1, 3), arr[:, -4:, :].reshape(-1, 3)])
    cream = np.median(frame, axis=0)
    dist = np.sqrt(((arr - cream) ** 2).sum(axis=2))
    bg = border_connected_bg(dist < tol)
    fg = keep_large_islands(~bg)
    alpha = np.where(fg, 255, 0).astype("uint8")
    A = Image.fromarray(alpha, "L").filter(ImageFilter.GaussianBlur(FEATHER))
    out = im.convert("RGBA"); out.putalpha(A)
    bbox = A.point(lambda a: 255 if a > 8 else 0).getbbox()
    if bbox:
        pad = round(MARGIN * max(bbox[2] - bbox[0], bbox[3] - bbox[1]))
        out = out.crop((max(0, bbox[0] - pad), max(0, bbox[1] - pad),
                        min(out.width, bbox[2] + pad), min(out.height, bbox[3] + pad)))
    out.save(path)
    print(f"  [key]  {path.name}  -> {out.width}x{out.height}  (tol={tol} scipy={HAVE_SCIPY})")

if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser(
        description="Deterministic cream-ground key-out (in place). "
                    "Lower --tol for pale/white-bellied birds: at the default "
                    "their underparts read as cream and the flood fill eats the "
                    "lower outline (Vireo/Chickadee belly, gulls, doves).")
    ap.add_argument("paths", nargs="+", type=Path, help="PNG(s) to key out in place")
    ap.add_argument("--tol", type=int, default=TOL,
                    help=f"color distance from cream counted as ground "
                         f"(default {TOL}; use ~18 for pale birds)")
    a = ap.parse_args()
    for p in a.paths:
        cut(p, tol=a.tol)
