#!/usr/bin/env python3
"""Frame-Pi client: fetch the rendered collage and push it to the Inky 7.3".

Runs on the Pi Zero 2 W on a systemd timer. Each run it decides whether a
refresh is worth it (the species set or call-count brackets changed, and it is
not quiet hours), then fetches a ready-made 800x480 PNG — rendered off-Pi by
avian-worker's /frame.png (Cloudflare Browser Rendering) — fits it to the
panel, dithers to the 7-colour ACeP palette, and pushes it to the Inky
Impression 7.3". ``--preview out.png`` writes the same 7-colour dither to a
file instead, so the look can be checked on any machine without the panel.

The heavy layout lives in the web /frame view, so this client stays thin: no
local browser (a Zero 2 W can't run one) — just fetch, fit, dither, push. The
one bit of local compositing is an optional ``border`` inset (a white margin)
so a picture-frame bezel that overlaps the panel edge can't clip the artwork;
it is off (0) by default. (The 13.3" port that this replaces did its own
screenshot cropping/matting; here the Worker renders frame-ready, so that is
otherwise gone.)
"""
from __future__ import annotations

import argparse
import base64
import hashlib
import inspect
import io
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime

from PIL import Image, ImageChops, ImageEnhance

try:
    import tomllib
except ModuleNotFoundError:  # Python < 3.11
    import tomli as tomllib

PANEL_W, PANEL_H = 800, 480  # Inky Impression 7.3", landscape native buffer

# 7-colour ACeP palette for the 7.3" panel. On hardware the Inky library maps
# to the panel's real palette; this is also the --preview quantisation target,
# so the preview closely matches what the panel will actually show.
INKY7 = [
    (0, 0, 0),        # black
    (255, 255, 255),  # white
    (0, 128, 0),      # green
    (0, 0, 255),      # blue
    (255, 0, 0),      # red
    (255, 255, 0),    # yellow
    (255, 128, 0),    # orange
]

PREVIEW_SATURATION = 1.4  # --preview only: approximate the Inky lib's on-panel boost

DEFAULTS = {
    "base_url": "https://avian-worker.s-friedman.workers.dev",  # for the recent-API change check
    "hours": 24,
    "image": "",            # a local PNG written by a sibling process, or
    "image_url": "",        # the /frame.png URL (include ?k=FRAME_KEY)
    "rotate": 0,            # 0 or 180 to flip landscape; 90/270 for a portrait mount
    "tilt": 0.0,            # fine rotation (deg, e.g. -0.5) to level content in a slightly cocked frame; +CCW
    "border": 0,            # symmetric inset on every edge (white margin under a frame bezel)
    "inset": [],            # per-edge [left, top, right, bottom]; overrides border for an uneven mat
    "fill": False,          # crop surrounding whitespace so the collage fills the visible window
    "fill_pad": 16,         # px of breathing room kept around the content when fill is on
    "saturation": 0.7,     # Inky colour saturation on hardware (0..1)
    "panel": "",            # force a driver module (e.g. "inky_ac073tc1") if auto() fails
    "quiet_start": 0, "quiet_end": 0,    # 0/0 = no quiet hours
    "heal_hours": 24,
    "state": "~/.birdframe/state.json",
    "timeout": 45,
    "basic_user": None, "basic_pass": None,
}


def _auth(cfg):
    if not cfg.get("basic_user"):
        return None
    raw = f"{cfg['basic_user']}:{cfg.get('basic_pass') or ''}".encode()
    return "Basic " + base64.b64encode(raw).decode()


# --- change detection -------------------------------------------------------
def slugify(sci):
    return re.sub(r"[^a-z0-9]+", "-", sci.lower()).strip("-")


def _bucket(n):
    for i, edge in enumerate((1, 2, 5, 15, 40, 100, 300, 1000)):
        if n <= edge:
            return i
    return 8


def fetch_recent(base, hours, timeout, auth=None):
    # avian-worker's native route (the stock PHP path was /avian/api/birdnet-api.php).
    url = f"{base.rstrip('/')}/api/recent?hours={hours}"
    req = urllib.request.Request(url, headers={"User-Agent": "AvianVisitors-frame/1.0"})
    if auth:
        req.add_header("Authorization", auth)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read(2_000_000)).get("species", [])


def fetch_frame_window(base, timeout, auth=None):
    """GET the shared frame window (hours) the website set, so the change-detector
    hashes the SAME window the rendered /frame.png shows. Returns int hours, or
    None on any failure (caller falls back to cfg["hours"]). MUST send a
    User-Agent — the worker 403s the default urllib UA (project gotcha)."""
    url = f"{base.rstrip('/')}/api/frame-config"
    req = urllib.request.Request(url, headers={"User-Agent": "AvianVisitors-frame/1.0"})
    if auth:
        req.add_header("Authorization", auth)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            w = json.loads(r.read(10_000)).get("window_hours")
            return int(w) if w is not None else None
    except Exception:
        return None


def signature(species):
    items = sorted((slugify(s["sci"]), _bucket(int(s.get("n") or 1))) for s in species)
    return hashlib.sha256(json.dumps(items).encode()).hexdigest()[:16]


# --- image ------------------------------------------------------------------
def get_image(src, timeout, auth=None):
    if re.match(r"^https?://", src):
        req = urllib.request.Request(src, headers={"User-Agent": "AvianVisitors-frame/1.0"})
        # Also send any ?k= frame key as X-Frame-Key: the worker prefers the
        # header (a query-string key would land in request-URL logs once
        # Workers Logs is enabled); ?k= keeps working during the transition.
        k = urllib.parse.parse_qs(urllib.parse.urlparse(src).query).get("k")
        if k:
            req.add_header("X-Frame-Key", k[0])
        if auth:
            req.add_header("Authorization", auth)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return Image.open(io.BytesIO(r.read(20_000_000))).convert("RGB")
    return Image.open(os.path.expanduser(src)).convert("RGB")


def autocrop(img, thresh=12, pad=16):
    """Crop away the surrounding background so the collage fills the panel instead
    of floating in whitespace (the off-Pi /frame.png centres a small cluster on a
    big white field). The background colour is sampled from the top-left corner;
    pixels differing from it by more than ``thresh`` count as content. ``pad`` px of
    breathing room is kept around the content (also giving the tilt room before any
    bird reaches the mat). Returns the original if the image is effectively blank."""
    rgb = img.convert("RGB")
    bg = Image.new("RGB", rgb.size, rgb.getpixel((0, 0)))
    mask = ImageChops.difference(rgb, bg).convert("L").point(lambda p: 255 if p > thresh else 0)
    bbox = mask.getbbox()
    if not bbox:
        return img
    l, t, r, b = bbox
    return img.crop((max(0, l - pad), max(0, t - pad),
                     min(rgb.width, r + pad), min(rgb.height, b + pad)))


def fit_panel(img, border=0):
    """Fit onto the 800x480 panel buffer on a white field (letterbox),
    preserving aspect. ``border`` insets the image by that many px on every edge
    — a white margin so a picture-frame bezel that overlaps the panel edge can't
    clip the artwork. With border=0 and an already-800x480 image (the usual case
    — /frame.png renders frame-ready) this is a straight pass-through."""
    if border <= 0 and img.size == (PANEL_W, PANEL_H):
        return img
    box_w = max(1, PANEL_W - 2 * border)   # the inner rectangle the image fits into
    box_h = max(1, PANEL_H - 2 * border)
    src = img.width / img.height
    tgt = box_w / box_h
    if src > tgt:
        nw, nh = box_w, max(1, round(box_w / src))
    else:
        nh, nw = box_h, max(1, round(box_h * src))
    resized = img.resize((nw, nh), Image.LANCZOS)
    canvas = Image.new("RGB", (PANEL_W, PANEL_H), (255, 255, 255))
    canvas.paste(resized, ((PANEL_W - nw) // 2, (PANEL_H - nh) // 2))
    return canvas


def fit_window(img, left=0, top=0, right=0, bottom=0):
    """Like fit_panel but with independent per-edge insets, for a frame whose mat
    overlaps the panel unevenly (measured with frame/calibrate.py). Letterboxes the
    image into the visible window (panel minus per-edge insets) on a white field,
    centred within that window. With all insets 0 this is fit_panel(img, 0)."""
    if left <= 0 and top <= 0 and right <= 0 and bottom <= 0:
        return fit_panel(img, 0)
    box_w = max(1, PANEL_W - left - right)
    box_h = max(1, PANEL_H - top - bottom)
    src = img.width / img.height
    tgt = box_w / box_h
    if src > tgt:
        nw, nh = box_w, max(1, round(box_w / src))
    else:
        nh, nw = box_h, max(1, round(box_h * src))
    resized = img.resize((nw, nh), Image.LANCZOS)
    canvas = Image.new("RGB", (PANEL_W, PANEL_H), (255, 255, 255))
    canvas.paste(resized, (left + (box_w - nw) // 2, top + (box_h - nh) // 2))
    return canvas


def quantize_inky7(img, saturation_boost=1.0):
    """Floyd-Steinberg dither to the 7-colour palette. saturation_boost
    compensates for e-ink's pale look (preview only; on hardware the Inky
    library applies its own boost via set_image(saturation=...))."""
    img = img.convert("RGB")
    if saturation_boost != 1.0:
        img = ImageEnhance.Color(img).enhance(saturation_boost)
    pal = Image.new("P", (1, 1))
    flat = [c for ink in INKY7 for c in ink]
    flat += [0] * (768 - len(flat))  # pad to a full 256-entry palette
    pal.putpalette(flat)
    return img.quantize(colors=len(INKY7), palette=pal,
                        dither=Image.Dither.FLOYDSTEINBERG).convert("RGB")


# --- hardware ---------------------------------------------------------------
def push_panel(img, rotate, saturation, panel=""):
    """Push to the Inky Impression 7.3". Lazy import so this module still loads
    on a machine without the Inky library (e.g. for --preview)."""
    if panel:
        import importlib
        dev = importlib.import_module(f"inky.{panel}").Inky()
    else:
        from inky.auto import auto
        dev = auto()
    buf = img.rotate(rotate, expand=True) if rotate else img
    if buf.size != (dev.width, dev.height):
        buf = buf.resize((dev.width, dev.height), Image.LANCZOS)
    kw = {"saturation": saturation} if "saturation" in inspect.signature(dev.set_image).parameters else {}
    dev.set_image(buf, **kw)
    dev.show()


# --- state ------------------------------------------------------------------
def load_state(path):
    try:
        with open(os.path.expanduser(path)) as f:
            return json.load(f)
    except Exception:
        return {"signature": None, "last_refresh": 0}


def save_state(path, sig, when):
    path = os.path.expanduser(path)
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"signature": sig, "last_refresh": when}, f)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)  # atomic: a power cut can't leave a half-written file


def in_quiet_hours(cfg, hour):
    s, e = cfg["quiet_start"], cfg["quiet_end"]
    if s == e:
        return False
    return s <= hour < e if s < e else hour >= s or hour < e


# --- run --------------------------------------------------------------------
def obtain_image(cfg):
    src = cfg["image_url"] or cfg["image"]
    if not src:
        raise ValueError("set image_url (the /frame.png URL) or image in config")
    return get_image(src, cfg["timeout"], _auth(cfg))


def run(cfg, preview=None, force=False, use_signature=True):
    now = time.time()
    state = load_state(cfg["state"])
    sig = None
    if use_signature:
        try:
            # Track the SAME window the website set for the frame (falls back to the
            # configured hours if /api/frame-config is unreachable). The ":win" suffix
            # makes a window change always bust the signature even if the species set
            # is identical — mirrors the worker folding the window into its own sig.
            win = fetch_frame_window(cfg["base_url"], cfg["timeout"], _auth(cfg)) or cfg["hours"]
            sig = signature(fetch_recent(cfg["base_url"], win, cfg["timeout"], _auth(cfg))) + ":" + str(win)
        except Exception as e:
            print(f"signature fetch failed: {e}", file=sys.stderr)  # treat as no change
    heal_due = now - state.get("last_refresh", 0) >= cfg["heal_hours"] * 3600
    changed = (not use_signature) or (sig is not None and sig != state.get("signature"))
    if not force and not preview:
        if in_quiet_hours(cfg, datetime.now().hour):
            print("quiet hours; skip")
            return
        if not changed and not heal_due:
            print("no change; skip")
            return
        print("refresh:", "changed" if changed else "heal")

    try:
        raw = obtain_image(cfg)
        if cfg.get("fill"):
            raw = autocrop(raw, pad=int(cfg.get("fill_pad") or 16))
        inset = cfg.get("inset") or []
        if len(inset) == 4 and any(int(v) > 0 for v in inset):
            img = fit_window(raw, *(int(v) for v in inset))
        else:
            img = fit_panel(raw, cfg["border"])
    except Exception as e:
        print(f"could not get image: {e}", file=sys.stderr)  # keep the last panel image
        return
    tilt = float(cfg.get("tilt") or 0)
    if tilt:
        # fine rotation to counter a panel sitting slightly cocked in its frame;
        # expand=False keeps the 800x480 buffer, white fills the exposed corners
        # (which land under the mat). +tilt = CCW, so a CCW-mounted panel wants -tilt.
        img = img.rotate(tilt, resample=Image.BICUBIC, expand=False, fillcolor=(255, 255, 255))
    if preview:
        quantize_inky7(img, PREVIEW_SATURATION).save(preview)
        print(f"wrote preview {preview}")
        return
    try:
        push_panel(img, cfg["rotate"], cfg["saturation"], cfg.get("panel", ""))
    except Exception as e:
        print(f"panel push failed: {e}", file=sys.stderr)
        return
    save_state(cfg["state"], sig if sig is not None else state.get("signature"), now)
    print("panel updated")


def load_config(path):
    cfg = dict(DEFAULTS)
    if path:
        with open(os.path.expanduser(path), "rb") as f:
            cfg.update(tomllib.load(f))
    return cfg


def main():
    ap = argparse.ArgumentParser(description="Push the rendered collage to the Inky 7.3\" panel.")
    ap.add_argument("--config")
    ap.add_argument("--base-url")
    ap.add_argument("--image")
    ap.add_argument("--image-url")
    ap.add_argument("--preview", help="write a 7-colour preview PNG instead of pushing")
    ap.add_argument("--rotate", type=int)
    ap.add_argument("--tilt", type=float, help="fine level correction in degrees (+CCW, e.g. -0.5)")
    ap.add_argument("--fill", action=argparse.BooleanOptionalAction, help="crop whitespace so the collage fills the panel")
    ap.add_argument("--fill-pad", type=int, help="px of breathing room around content when --fill is on")
    ap.add_argument("--border", type=int, help="inset the image N px on every edge (bezel margin)")
    ap.add_argument("--inset", help="per-edge insets L,T,R,B (overrides border for an uneven mat)")
    ap.add_argument("--force", action="store_true", help="refresh even if unchanged")
    ap.add_argument("--no-signature", action="store_true", help="skip change detection")
    args = ap.parse_args()

    cfg = load_config(args.config)
    for key in ("base_url", "image", "image_url"):
        val = getattr(args, key)
        if val:
            cfg[key] = val
    if args.rotate is not None:
        cfg["rotate"] = args.rotate
    if args.tilt is not None:
        cfg["tilt"] = args.tilt
    if args.fill is not None:
        cfg["fill"] = args.fill
    if args.fill_pad is not None:
        cfg["fill_pad"] = args.fill_pad
    if args.border is not None:
        cfg["border"] = args.border
    if args.inset:
        cfg["inset"] = [int(v) for v in args.inset.split(",")]
    run(cfg, preview=args.preview, force=args.force, use_signature=not args.no_signature)


if __name__ == "__main__":
    main()
