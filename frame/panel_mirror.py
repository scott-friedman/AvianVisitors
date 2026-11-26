"""The panel mirror, Pi side: tell the worker what the panel is ACTUALLY showing.

After each successful redraw, display.py hands us the exact 7-colour pixels the
Inky driver sent to the glass. We keep a copy on disk and upload it to
POST /api/frame-confirmed (FRAME_KEY-gated), where the site's "on the frame now"
view reads it back (worker/src/panel-mirror.js).

Rules this file keeps:
- Only a picture the panel finished showing is ever reported (record_shown is
  called after dev.show() returns). A rendered-but-not-shown image never is.
- Nothing here can stop or delay the panel: every entry point swallows its own
  errors, and an upload that fails is retried on the next timer tick.
- No rendering and no extra panel refreshes; the key never goes in a URL.

Python 3.9-compatible (CI runs 3.9 and 3.11).
"""
import hashlib
import io
import json
import os
import urllib.parse
import urllib.request
from pathlib import Path

from PIL import Image

UA = "AvianVisitors-frame-mirror/1.0"


def snapshot_device(dev, rotate=0):
    """PNG of the panel's buffer as quantised by set_image(), before show().

    Reads the driver's own palette-index buffer, so the dither and the choice
    of ink at every pixel are exactly what goes to the glass. Each ink is drawn
    in its plain colour (the driver's palette at saturation 0: pure black,
    white, green, blue, red, yellow, orange). A rotated (portrait) mount is
    turned back the way a viewer sees it.
    Returns None for a driver that does not expose a 7-colour buffer.
    """
    buf = getattr(dev, "buf", None)
    blend = getattr(dev, "_palette_blend", None)
    if buf is None or blend is None:
        return None
    image = Image.fromarray(buf.copy(), "P")
    palette = list(blend(0.0))
    image.putpalette(palette + [0] * (768 - len(palette)))
    image = image.convert("RGB")
    rot = int(rotate or 0) % 360
    if rot:
        image = image.rotate(-rot, expand=True)
    if image.size not in ((800, 480), (480, 800)):
        return None
    out = io.BytesIO()
    image.save(out, format="PNG", optimize=True)
    return out.getvalue()


def _paths(cfg):
    base = Path(os.path.expanduser(cfg["state"])).parent
    return base / "display-confirmed.png", base / "display-confirmed.json"


def _atomic(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    with tmp.open("wb") as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.replace(str(tmp), str(path))


def record_shown(png, cfg, displayed_at, kind="", screen=""):
    """Keep the picture the panel just finished showing, marked not yet sent.
    Call only after dev.show() returned."""
    try:
        if not png:
            return
        image, meta = _paths(cfg)
        _atomic(image, png)
        _atomic(meta, json.dumps({
            "sha256": hashlib.sha256(png).hexdigest(), "displayed_at": displayed_at,
            "kind": kind or "", "screen": screen or "", "uploaded": False,
        }).encode())
    except Exception:
        pass


def _endpoint_and_key(cfg):
    src = urllib.parse.urlsplit(cfg.get("image_url") or "")
    key = cfg.get("frame_key") or urllib.parse.parse_qs(src.query).get("k", [""])[0]
    if src.scheme != "https" or not src.netloc or not key:
        return None, None
    return urllib.parse.urlunsplit((src.scheme, src.netloc, "/api/frame-confirmed", "", "")), key


def publish_pending(cfg, opener=None):
    """Upload the kept picture if it has not reached the worker yet.
    Returns True when the worker has it. Never raises."""
    try:
        if cfg.get("mirror") is False:
            return False
        image, meta = _paths(cfg)
        if not meta.exists():
            return False
        state = json.loads(meta.read_text())
        if state.get("uploaded"):
            return True
        png = image.read_bytes()
        if hashlib.sha256(png).hexdigest() != state.get("sha256"):
            return False  # half-written pair; the next redraw rewrites both
        url, key = _endpoint_and_key(cfg)
        if not url:
            return False
        headers = {
            "Content-Type": "image/png", "User-Agent": UA, "X-Frame-Key": key,
            "X-Displayed-At": str(state["displayed_at"]), "X-Image-SHA256": state["sha256"],
        }
        if state.get("kind"):
            headers["X-Frame-Kind"] = state["kind"]
        if state.get("screen"):
            headers["X-Frame-Screen"] = state["screen"]
        req = urllib.request.Request(url, data=png, method="POST", headers=headers)
        with (opener or urllib.request.urlopen)(req, timeout=8) as response:
            if response.status not in (200, 204):
                return False
        # Mark sent only if a newer redraw did not replace the pair meanwhile.
        current = json.loads(meta.read_text())
        if current.get("sha256") == state["sha256"] and current.get("displayed_at") == state["displayed_at"]:
            current["uploaded"] = True
            _atomic(meta, json.dumps(current).encode())
        return True
    except Exception:
        return False
