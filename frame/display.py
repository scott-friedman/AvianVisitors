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
import urllib.request
from datetime import datetime

from PIL import Image, ImageEnhance

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
    "border": 0,            # inset the image this many px on every edge (white margin under a frame bezel)
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


def signature(species):
    items = sorted((slugify(s["sci"]), _bucket(int(s.get("n") or 1))) for s in species)
    return hashlib.sha256(json.dumps(items).encode()).hexdigest()[:16]


# --- image ------------------------------------------------------------------
def get_image(src, timeout, auth=None):
    if re.match(r"^https?://", src):
        req = urllib.request.Request(src, headers={"User-Agent": "AvianVisitors-frame/1.0"})
        if auth:
            req.add_header("Authorization", auth)
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return Image.open(io.BytesIO(r.read(20_000_000))).convert("RGB")
    return Image.open(os.path.expanduser(src)).convert("RGB")


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
            sig = signature(fetch_recent(cfg["base_url"], cfg["hours"], cfg["timeout"], _auth(cfg)))
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
        img = fit_panel(obtain_image(cfg), cfg["border"])
    except Exception as e:
        print(f"could not get image: {e}", file=sys.stderr)  # keep the last panel image
        return
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
    ap.add_argument("--border", type=int, help="inset the image N px on every edge (bezel margin)")
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
    if args.border is not None:
        cfg["border"] = args.border
    run(cfg, preview=args.preview, force=args.force, use_signature=not args.no_signature)


if __name__ == "__main__":
    main()
