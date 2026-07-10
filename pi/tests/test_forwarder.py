"""Unit tests for pi/detection-forwarder.py — pure-python, no Pi needed.

Focus (IMPROVEMENTS.md → Testing): handle_line() parsing, because a silent
parse failure drops detections at the source with the heartbeat still green;
and the outage/spool contract added 2026-07-10 — a sustained POST failure must
exit(1) WITHOUT the caller having advanced the offset (systemd restarts the
service and BirdDB.txt acts as the spool), while a worker-rejected payload
(plain 4xx) is skipped so one poison line can't wedge the queue.

Run:  python3 -m pytest pi/tests -q
"""
import importlib.util
import io
import pathlib
import urllib.error

import pytest

# The filename has a dash, so import it by path.
_MOD_PATH = pathlib.Path(__file__).resolve().parents[1] / "detection-forwarder.py"
_spec = importlib.util.spec_from_file_location("detection_forwarder", _MOD_PATH)
fwd = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fwd)

GOOD_LINE = "2026-06-19;07:48:01;Turdus migratorius;American Robin;0.91;42.4;-71.4;0.7;25;1.25;0.0\n"

# The autouse fixture stubs fwd.find_clip for the handle_line tests; keep the
# real function reachable for the test that exercises it directly.
_real_find_clip = fwd.find_clip


@pytest.fixture(autouse=True)
def no_sleep_no_clip(monkeypatch):
    """Never sleep in retry backoff; default to 'no clip found' so tests that
    don't care about clips skip the upload path."""
    monkeypatch.setattr(fwd.time, "sleep", lambda s: None)
    monkeypatch.setattr(fwd, "find_clip", lambda *a: (None, None))


def _capture_posts(monkeypatch):
    posts = []

    def fake_post(secret, sci, com, conf, ts, file=None):
        posts.append({"sci": sci, "com": com, "conf": conf, "ts": ts, "file": file})
        return 204

    monkeypatch.setattr(fwd, "post", fake_post)
    return posts


def _http_error(code):
    return urllib.error.HTTPError("http://x", code, "boom", {}, io.BytesIO(b""))


def test_good_line_posts_parsed_fields(monkeypatch):
    posts = _capture_posts(monkeypatch)
    fwd.handle_line("s3cret", GOOD_LINE)
    assert len(posts) == 1
    p = posts[0]
    assert p["sci"] == "Turdus migratorius"
    assert p["com"] == "American Robin"
    assert p["conf"] == pytest.approx(0.91)
    assert isinstance(p["ts"], int)
    assert p["file"] is None  # no clip found -> no dangling R2 key


def test_fractional_seconds_tolerated(monkeypatch):
    posts = _capture_posts(monkeypatch)
    fwd.handle_line("s", GOOD_LINE.replace("07:48:01", "07:48:01.5031"))
    assert len(posts) == 1


@pytest.mark.parametrize("line", [
    "\n",
    "Date;Time;Sci_Name;Com_Name;Confidence\n",          # header line (conf not a float)
    "2026-06-19;07:48:01;Turdus migratorius\n",          # too few fields
    "2026-06-19;07:48:01;;American Robin;0.91\n",        # empty sci
    "not-a-date;07:48:01;Turdus migratorius;Robin;0.91\n",
])
def test_malformed_lines_are_skipped_silently(monkeypatch, line):
    posts = _capture_posts(monkeypatch)
    fwd.handle_line("s", line)
    assert posts == []


def test_clip_found_uploads_and_sets_file_key(monkeypatch, tmp_path):
    posts = _capture_posts(monkeypatch)
    uploads = []
    monkeypatch.setattr(fwd, "find_clip", lambda *a: ("/tmp/x.mp3", "Robin-91.mp3"))
    monkeypatch.setattr(fwd, "post_clip", lambda s, b, d: uploads.append(b) or 204)
    clip = tmp_path / "x.mp3"
    clip.write_bytes(b"ID3fake")
    monkeypatch.setattr(fwd, "find_clip", lambda *a: (str(clip), "Robin-91.mp3"))
    fwd.handle_line("s", GOOD_LINE)
    assert uploads == ["Robin-91.mp3"]
    assert posts[0]["file"] == "Robin-91.mp3"


def test_failed_clip_upload_never_blocks_the_detection(monkeypatch, tmp_path):
    posts = _capture_posts(monkeypatch)
    clip = tmp_path / "x.mp3"
    clip.write_bytes(b"ID3fake")
    monkeypatch.setattr(fwd, "find_clip", lambda *a: (str(clip), "Robin-91.mp3"))

    def boom(*a):
        raise OSError("network down")

    monkeypatch.setattr(fwd, "post_clip", boom)
    fwd.handle_line("s", GOOD_LINE)
    assert len(posts) == 1
    assert posts[0]["file"] is None  # upload failed -> no dangling key


def test_sustained_outage_exits_nonzero_to_spool(monkeypatch):
    """URLError on every attempt -> exit(1). systemd restarts the forwarder at
    the saved offset, so the line is replayed instead of dropped."""
    attempts = []

    def down(*a, **k):
        attempts.append(1)
        raise urllib.error.URLError("network unreachable")

    monkeypatch.setattr(fwd, "post", down)
    with pytest.raises(SystemExit) as exc:
        fwd.handle_line("s", GOOD_LINE)
    assert exc.value.code == 1
    assert len(attempts) == 4  # full backoff schedule before giving up


def test_server_5xx_also_spools(monkeypatch):
    monkeypatch.setattr(fwd, "post", lambda *a, **k: (_ for _ in ()).throw(_http_error(500)))
    with pytest.raises(SystemExit):
        fwd.handle_line("s", GOOD_LINE)


def test_rejected_payload_is_skipped_not_wedged(monkeypatch):
    """A plain 4xx means the worker refused this payload — retrying or exiting
    would wedge the spool forever on one poison line. Skip it, once."""
    attempts = []

    def rejected(*a, **k):
        attempts.append(1)
        raise _http_error(400)

    monkeypatch.setattr(fwd, "post", rejected)
    fwd.handle_line("s", GOOD_LINE)  # returns; no SystemExit
    assert len(attempts) == 1


def test_auth_failure_spools_so_secret_rotation_self_heals(monkeypatch):
    monkeypatch.setattr(fwd, "post", lambda *a, **k: (_ for _ in ()).throw(_http_error(401)))
    with pytest.raises(SystemExit):
        fwd.handle_line("s", GOOD_LINE)


def test_find_clip_matches_by_time_suffix(tmp_path, monkeypatch):
    monkeypatch.setattr(fwd, "EXTRACTED", str(tmp_path))
    d = tmp_path / "By_Date" / "2026-06-19" / "American_Robin"
    d.mkdir(parents=True)
    (d / "American_Robin-91-2026-06-19-birdnet-07:48:01.mp3").write_bytes(b"x")
    (d / "American_Robin-88-2026-06-19-birdnet-09:00:00.mp3").write_bytes(b"x")
    path, base = _real_find_clip("2026-06-19", "07:48:01", "American Robin")
    assert base == "American_Robin-91-2026-06-19-birdnet-07:48:01.mp3"
    assert path and path.endswith(base)
    assert _real_find_clip("2026-06-19", "23:59:59", "American Robin") == (None, None)
    assert _real_find_clip("2026-06-20", "07:48:01", "American Robin") == (None, None)
