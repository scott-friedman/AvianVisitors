"""Unit tests for scripts/utils/owlwatch.py — which "maybe an owl" guesses are kept.

Pure python: the module only needs utils.classes (which needs tzlocal; stubbed
here so CI doesn't install BirdNET-Pi's requirements).

Run:  python3 -m pytest pi/tests -q
"""
import datetime
import importlib
import pathlib
import sys
import types

import pytest

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scripts"))
if "tzlocal" not in sys.modules:
    tz = types.ModuleType("tzlocal")
    tz.get_localzone = lambda: datetime.timezone.utc
    sys.modules["tzlocal"] = tz

owlwatch = importlib.import_module("utils.owlwatch")
from utils.classes import Detection, ParseFileName  # noqa: E402

NAMES = {
    "Strix varia": "Barred Owl",
    "Bubo bubo": "Eurasian Eagle-Owl",
    "Bubo virginianus": "Great Horned Owl",
    "Cyanocitta cristata": "Blue Jay",
    "Strix aluco": "Tawny Owl",
}


def test_keeps_owls_birdnet_dropped_and_skips_the_rest():
    raw = {
        "0.0;3.0": [("Strix varia", 0.96), ("Cyanocitta cristata", 0.8)],
        "3.0;6.0": [("Strix varia", 0.61), ("Bubo bubo", 0.4)],
        "6.0;9.0": [("Strix aluco", 0.12)],  # below the bar
    }
    c = owlwatch.candidates(raw, kept=[], names=NAMES, threshold=0.3)
    assert [x["sci"] for x in c] == ["Strix varia", "Bubo bubo"]
    assert c[0]["conf"] == 0.96 and c[0]["start"] == 0.0  # best window per species
    assert all(x["sci"] != "Cyanocitta cristata" for x in c)  # not an owl


def test_skips_an_owl_birdnet_already_kept():
    raw = {"0.0;3.0": [("Bubo virginianus", 0.83)]}
    kept = [Detection(datetime.datetime(2026, 11, 25, 3, 46), 0.0, 3.0, "Bubo virginianus", "Great Horned Owl", 0.83)]
    assert owlwatch.candidates(raw, kept=kept, names=NAMES, threshold=0.3) == []


def test_threshold_zero_turns_it_off():
    raw = {"0.0;3.0": [("Strix varia", 0.96)]}
    assert owlwatch.candidates(raw, kept=[], names=NAMES, threshold=0) == []


def test_common_name_fallback_for_unlisted_genus():
    assert owlwatch.is_owl("Novus genus", "Some New Owl")
    assert not owlwatch.is_owl("Corvus corax", "Common Raven")


def test_save_cuts_clip_logs_line_and_spaces_repeats(tmp_path, monkeypatch):
    calls = []

    def fake_run(args, **kw):
        calls.append(args)
        pathlib.Path(args[3]).write_bytes(b"ID3")
        return types.SimpleNamespace(returncode=0)

    monkeypatch.setattr(owlwatch.subprocess, "run", fake_run)
    owlwatch._last_kept.clear()
    wav = tmp_path / "2026-11-23-birdnet-05:31:51.wav"
    wav.write_bytes(b"RIFF")
    conf = {"RECS_DIR": str(tmp_path)}

    f = ParseFileName(str(wav))
    f.owl_watch = [{"sci": "Strix varia", "com": "Barred Owl", "conf": 0.96, "start": 12.0, "end": 15.0}]
    out = owlwatch.save(f, conf, now=f.file_date.timestamp())
    assert len(out) == 1
    assert calls[0][-2:] == ["=10.5", "=16.5"]  # 1.5 s either side
    line = (tmp_path / "owl_watch.txt").read_text().strip().split(";")
    assert line[:4] == ["2026-11-23", "05:32:03", "Strix varia", "Barred Owl"]
    assert line[5].endswith("Barred_Owl-96-2026-11-23-owlwatch-05:32:03.mp3")

    # The same owl a minute later is the same moment: no second clip.
    f2 = ParseFileName(str(tmp_path / "2026-11-23-birdnet-05:32:51.wav"))
    f2.file_name = str(wav)
    f2.owl_watch = [{"sci": "Strix varia", "com": "Barred Owl", "conf": 0.8, "start": 0.0, "end": 3.0}]
    assert owlwatch.save(f2, conf, now=f2.file_date.timestamp()) == []


def test_save_never_raises(tmp_path, monkeypatch):
    def boom(*a, **k):
        raise OSError("sox missing")

    monkeypatch.setattr(owlwatch.subprocess, "run", boom)
    owlwatch._last_kept.clear()
    f = ParseFileName(str(tmp_path / "2026-11-23-birdnet-05:31:51.wav"))
    f.owl_watch = [{"sci": "Strix varia", "com": "Barred Owl", "conf": 0.96, "start": 0.0, "end": 3.0}]
    assert owlwatch.save(f, {"RECS_DIR": str(tmp_path)}) == []
