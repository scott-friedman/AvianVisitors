"""Unit tests for frame/panel_mirror.py — the Pi side of the site's
"on the frame now" view. No panel needed: a fake Inky driver stands in.

Run:  python3 -m pytest pi/tests -q
"""
import hashlib
import io
import json
import pathlib
import sys

import pytest

np = pytest.importorskip("numpy")
Image = pytest.importorskip("PIL.Image")

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2] / "frame"))
import panel_mirror as pm  # noqa: E402


class FakeInky:
    """Just the parts of inky_ac073tc1a.Inky the mirror reads."""
    def __init__(self):
        self.buf = np.zeros((480, 800), dtype=np.uint8)
        self.buf[:, :400] = 1          # left half palette index 1
        self.buf[0, 799] = 4           # one marker pixel, top-right

    def _palette_blend(self, saturation, dtype="uint8"):
        assert saturation == 0.0
        pal = [(0, 0, 0), (255, 255, 255), (0, 255, 0), (0, 0, 255),
               (255, 0, 0), (255, 255, 0), (255, 128, 0)]
        return [c for rgb in pal for c in rgb] + [255, 255, 255]


def _open(png):
    return Image.open(io.BytesIO(png)).convert("RGB")


def test_snapshot_is_the_panel_buffer_in_its_colours():
    img = _open(pm.snapshot_device(FakeInky()))
    assert img.size == (800, 480)
    assert img.getpixel((10, 10)) == (255, 255, 255)
    assert img.getpixel((600, 10)) == (0, 0, 0)
    assert img.getpixel((799, 0)) == (255, 0, 0)


def test_snapshot_turns_a_portrait_mount_back():
    img = _open(pm.snapshot_device(FakeInky(), rotate=90))
    assert img.size == (480, 800)


def test_snapshot_of_an_unknown_driver_is_none():
    class Other:
        pass
    assert pm.snapshot_device(Other()) is None


class Resp:
    def __init__(self, status):
        self.status = status
    def __enter__(self):
        return self
    def __exit__(self, *a):
        return False


def _cfg(tmp_path, **kw):
    cfg = {"state": str(tmp_path / "state.json"),
           "image_url": "https://w.example/frame.png?k=sekrit"}
    cfg.update(kw)
    return cfg


def test_record_then_publish_sends_once_with_key_in_a_header(tmp_path):
    cfg = _cfg(tmp_path)
    png = pm.snapshot_device(FakeInky())
    pm.record_shown(png, cfg, 1700000000.5, "night", "sky")
    sent = []

    def opener(req, timeout):
        sent.append(req)
        return Resp(204)

    assert pm.publish_pending(cfg, opener) is True
    req = sent[0]
    assert req.full_url == "https://w.example/api/frame-confirmed"
    assert "sekrit" not in req.full_url
    h = {k.lower(): v for k, v in req.header_items()}
    assert h["x-frame-key"] == "sekrit"
    assert h["x-image-sha256"] == hashlib.sha256(png).hexdigest()
    assert h["x-frame-kind"] == "night" and h["x-frame-screen"] == "sky"
    assert req.data == png
    # Already sent: no second upload.
    assert pm.publish_pending(cfg, opener) is True
    assert len(sent) == 1


def test_failed_upload_is_kept_for_the_next_tick(tmp_path):
    cfg = _cfg(tmp_path)
    pm.record_shown(pm.snapshot_device(FakeInky()), cfg, 1.0)

    def down(req, timeout):
        raise OSError("offline")

    assert pm.publish_pending(cfg, down) is False
    meta = json.loads((tmp_path / "display-confirmed.json").read_text())
    assert meta["uploaded"] is False
    assert pm.publish_pending(cfg, lambda r, timeout: Resp(204)) is True


def test_half_written_pair_or_no_key_sends_nothing(tmp_path):
    cfg = _cfg(tmp_path)
    pm.record_shown(pm.snapshot_device(FakeInky()), cfg, 1.0)
    (tmp_path / "display-confirmed.png").write_bytes(b"not the same picture")
    boom = lambda r, timeout: pytest.fail("must not upload")  # noqa: E731
    assert pm.publish_pending(cfg, boom) is False
    cfg2 = _cfg(tmp_path / "b", image_url="https://w.example/frame.png")
    pm.record_shown(b"png", cfg2, 1.0)
    assert pm.publish_pending(cfg2, boom) is False
    assert pm.publish_pending(_cfg(tmp_path, mirror=False), boom) is False
