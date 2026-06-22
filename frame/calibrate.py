#!/usr/bin/env python3
"""Matting-calibration test pattern for the Inky 7.3" (800x480 landscape).

After the panel is set into a picture frame, the mat board overlaps the outer
edge of the 800x480 active area, so some pixels near each edge are hidden. This
draws a ruled test card: push it to the panel, read off the smallest and largest
number still fully visible on each ruler, and that gives the visible window in
panel pixels — which we then feed back as a per-edge inset when rendering frame.png.

Everything is drawn in pure 7-colour ACeP inks (white/black/red/blue) so the panel
renders the marks crisp, with no dither noise to misread.

  # generate (writes ~/Downloads/calib-matting.png by default)
  python3 frame/calibrate.py

  # on the Pi: push it, bypassing change-detection and the bezel border
  python3 frame/display.py --image ~/calib-matting.png --border 0 --rotate 0 \
          --force --no-signature

Read-back: the horizontal ruler is the X axis (0 left -> 800 right); its smallest
visible number is the LEFT inset, 800 minus its largest is the RIGHT inset. The
vertical ruler is the Y axis (0 top -> 480 bottom); smallest = TOP inset, 480
minus largest = BOTTOM inset. A visible red edge means ~0 crop on that side.
"""
from __future__ import annotations

import argparse
import os

from PIL import Image, ImageDraw, ImageFont

W, H = 800, 480  # Inky Impression 7.3" native landscape buffer

# Pure ACeP palette inks (see frame/display.py INKY7) so nothing dithers.
WHITE = (255, 255, 255)
BLACK = (0, 0, 0)
RED = (255, 0, 0)
BLUE = (0, 0, 255)
GREEN = (0, 128, 0)  # matches the panel's ACeP green ink (display.py INKY7) so it renders crisp

EDGE = 4          # red true-edge border thickness (px)
HX, VY = H // 2, W // 2  # ruler positions: H ruler at y=240, V ruler at x=400
STEP = 20         # labelled major ticks every STEP px
MINOR = 10        # unlabelled minor ticks every MINOR px

_FONTS = [
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/System/Library/Fonts/Menlo.ttc",
]


def font(size):
    for path in _FONTS:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                pass
    return ImageFont.load_default()


def _clamp(v, lo, hi):
    return max(lo, min(hi, v))


def label(d, cx, cy, text, f, fill=BLACK):
    """Centre text at (cx,cy) but keep it fully on-canvas at the extremes."""
    w = d.textlength(text, font=f)
    asc, desc = f.getmetrics()
    h = asc + desc
    cx = _clamp(cx, w / 2 + 2, W - w / 2 - 2)
    cy = _clamp(cy, h / 2 + 2, H - h / 2 - 2)
    d.text((cx, cy), text, font=f, fill=fill, anchor="mm")


def build():
    img = Image.new("RGB", (W, H), WHITE)
    d = ImageDraw.Draw(img)
    fnum = font(15)
    ftitle = font(26)
    fsmall = font(14)

    # Red true-edge border: if you can see red on a side, the mat barely clips it.
    for i in range(EDGE):
        d.rectangle([i, i, W - 1 - i, H - 1 - i], outline=RED)

    # --- horizontal ruler (X): spans full width at mid-height ----------------
    d.line([(0, HX), (W, HX)], fill=BLACK, width=1)
    for x in range(0, W + 1, MINOR):
        major = x % STEP == 0
        ln = 16 if major else 8
        d.line([(x, HX - ln), (x, HX + ln)], fill=BLACK, width=1)
    for x in range(0, W + 1, STEP):
        # alternate labels above / below the line so dense numbers never collide
        cy = HX - 30 if (x // STEP) % 2 else HX + 30
        label(d, x, cy, str(x), fnum)

    # --- vertical ruler (Y): spans full height at mid-width -------------------
    d.line([(VY, 0), (VY, H)], fill=BLACK, width=1)
    for y in range(0, H + 1, MINOR):
        major = y % STEP == 0
        ln = 16 if major else 8
        d.line([(VY - ln, y), (VY + ln, y)], fill=BLACK, width=1)
    for y in range(0, H + 1, STEP):
        cx = VY - 32 if (y // STEP) % 2 else VY + 32
        label(d, cx, y, str(y), fnum)

    # --- corner tags: confirm orientation / that the corner isn't clipped -----
    pad = 34
    label(d, pad + 24, pad, "TL 0,0", fsmall, BLUE)
    label(d, W - pad - 28, pad, "TR 800,0", fsmall, BLUE)
    label(d, pad + 28, H - pad, "BL 0,480", fsmall, BLUE)
    label(d, W - pad - 32, H - pad, "BR 800,480", fsmall, BLUE)

    # --- centre title + instructions over a clean white panel ----------------
    bw, bh = 300, 150
    cx, cy = W // 2, H // 2
    d.rectangle([cx - bw // 2, cy - bh // 2, cx + bw // 2, cy + bh // 2],
                fill=WHITE, outline=BLACK, width=1)
    lines = [
        ("MATTING CALIBRATION", ftitle),
        ("800 x 480  -  border 0", fsmall),
        ("Smallest & largest number", fsmall),
        ("visible on each ruler.", fsmall),
        ("Red edge = no crop there.", fsmall),
    ]
    ty = cy - bh // 2 + 24
    for text, f in lines:
        label(d, cx, ty, text, f)
        ty += 28 if f is ftitle else 22

    return img


def build_window(left, top, right, bottom):
    """Verify card: fill ONLY the computed visible window green on white. Push it
    (border 0), and if the green reaches the mat opening with thin, even margins
    on all four sides — nothing important hidden — the measured insets are right.
    Green is the pure ACeP ink so it renders crisp (no dither to misjudge)."""
    img = Image.new("RGB", (W, H), WHITE)
    d = ImageDraw.Draw(img)
    x0, y0, x1, y1 = left, top, W - right, H - bottom
    d.rectangle([x0, y0, x1 - 1, y1 - 1], fill=GREEN)
    f = font(22)
    fs = font(15)
    cx, cy = (x0 + x1) // 2, (y0 + y1) // 2
    label(d, cx, cy - 12, "VISIBLE WINDOW", f, fill=WHITE)
    label(d, cx, cy + 12, f"L{left}  T{top}  R{right}  B{bottom}", fs, fill=WHITE)
    label(d, cx, y0 + 14, f"top {top}", fs, fill=WHITE)
    label(d, cx, y1 - 14, f"bottom {bottom}", fs, fill=WHITE)
    label(d, x0 + 34, cy, f"L{left}", fs, fill=WHITE)
    label(d, x1 - 34, cy, f"R{right}", fs, fill=WHITE)
    return img


def main():
    ap = argparse.ArgumentParser(description="Generate the matting-calibration test card.")
    ap.add_argument("-o", "--out", default="~/Downloads/calib-matting.png")
    ap.add_argument("--window", help="L,T,R,B insets: fill only the computed visible window green (verify card)")
    args = ap.parse_args()
    out = os.path.expanduser(args.out)
    if args.window:
        l, t, r, b = (int(v) for v in args.window.split(","))
        build_window(l, t, r, b).save(out)
        print(f"wrote {out}  ({W}x{H})  window L{l} T{t} R{r} B{b}")
    else:
        build().save(out)
        print(f"wrote {out}  ({W}x{H})")


if __name__ == "__main__":
    main()
