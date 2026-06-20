#!/usr/bin/env python3
"""avian-detection-forwarder — Pi side of AvianVisitors Phase 2.

Tails BirdNET-Pi's ``~/BirdNET-Pi/BirdDB.txt`` (one line appended per detection)
and POSTs each new detection to avian-worker's ``/api/detection``. It is fully
**decoupled** from BirdNET-Pi's source — no edits to reporting.py / the analysis
service — so a ``git pull`` of BirdNET-Pi never clobbers it. The Pi stays
outbound-only: this only makes outbound POSTs, opens no ports.

It also uploads each detection's extracted mp3 to ``/api/clip`` so the public
site can play it. BirdDB.txt carries no filename, but BirdNET-Pi writes the clip
to a deterministic path *before* it appends the line (birdnet_analysis.py orders
extract -> write_to_file), so the clip already exists when we read the line:
    EXTRACTED/By_Date/<date>/<Com_safe>/<Com_safe>-<pct>-<date>-birdnet-[RTSP_id]<HH:MM:SS>.mp3
where Com_safe = common name with apostrophes dropped + spaces -> '_' (classes.py).
We match it by the unique HH:MM:SS within that species/date dir. The basename is
sent as ``file`` in the detection POST only when the clip upload succeeds, so D1
never holds a key for an object that isn't in R2 (a missing clip -> "no audio").

BirdDB.txt line format (see scripts/utils/reporting.py ``summary()``):
    Date;Time;Sci_Name;Com_Name;Confidence;Lat;Lon;Cutoff;Week;Sens;Overlap
e.g.  2026-06-19;07:48:01;Turdus migratorius;American Robin;0.91;...

The worker dedupes by (sci, ts) with INSERT OR IGNORE, so an occasional replay
(e.g. this service restarting) is harmless. We persist the last-forwarded byte
offset to a state file and resume from it on restart, so detections appended
while the forwarder — or the network at Dad's — was down aren't dropped; only the
very first run starts at end-of-file so it doesn't re-post the whole back-history.

Config via env (set in the systemd unit):
    AVIAN_WORKER       base URL of avian-worker (no trailing /api)
    AVIAN_SECRET_FILE  path to a file holding the shared ingest secret (mode 600)
    AVIAN_BIRDDB       path to BirdDB.txt
    AVIAN_STATE_FILE   where to persist the read offset (default ~/.avian/forwarder-state.json)
    AVIAN_EXTRACTED    BirdNET-Pi's EXTRACTED dir (default ~/BirdSongs/Extracted)
    AVIAN_AUDIOFMT     extracted clip extension (default mp3; matches AUDIOFMT)

Note: the ingest secret is read once at startup, so rotating it requires a
forwarder restart (otherwise every POST 401s and is dropped).
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime

WORKER = os.environ.get("AVIAN_WORKER", "https://avian-worker.s-friedman.workers.dev")
SECRET_FILE = os.environ.get("AVIAN_SECRET_FILE", os.path.expanduser("~/.avian/ingest-secret"))
DB_TXT = os.environ.get("AVIAN_BIRDDB", os.path.expanduser("~/BirdNET-Pi/BirdDB.txt"))
STATE_FILE = os.environ.get("AVIAN_STATE_FILE", os.path.expanduser("~/.avian/forwarder-state.json"))
EXTRACTED = os.environ.get("AVIAN_EXTRACTED", os.path.expanduser("~/BirdSongs/Extracted"))
AUDIOFMT = os.environ.get("AVIAN_AUDIOFMT", "mp3")
ENDPOINT = WORKER.rstrip("/") + "/api/detection"
CLIP_ENDPOINT = WORKER.rstrip("/") + "/api/clip"


def load_secret() -> str:
    with open(os.path.expanduser(SECRET_FILE)) as f:
        return f.read().strip()


def load_state() -> tuple[int | None, int | None]:
    """Last persisted (byte offset, file inode), or (None, None) on first run."""
    try:
        with open(os.path.expanduser(STATE_FILE)) as f:
            d = json.load(f)
        return int(d["offset"]), int(d["inode"])
    except Exception:
        return None, None


def save_state(offset: int, inode: int) -> None:
    # Atomic via os.replace (mirrors display.py). No fsync: re-posting is harmless
    # (the worker dedupes), so durability-across-power-loss doesn't matter here, and
    # skipping it spares the SD card — atomicity alone prevents a corrupt half-write.
    path = os.path.expanduser(STATE_FILE)
    os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w") as f:
        json.dump({"offset": offset, "inode": inode}, f)
    os.replace(tmp, path)


def parse_ts(date_s: str, time_s: str) -> int:
    # BirdDB.txt records local wall-clock; datetime.timestamp() interprets a
    # naive datetime in the Pi's local tz and returns the correct unix epoch.
    time_s = time_s.split(".")[0]  # tolerate any fractional seconds
    dt = datetime.strptime(f"{date_s} {time_s}", "%Y-%m-%d %H:%M:%S")
    return int(dt.timestamp())


def post(secret: str, sci: str, com: str, conf: float, ts: int, file: str | None = None) -> int:
    payload = {"sci": sci, "com": com, "conf": conf, "ts": ts}
    if file:
        payload["file"] = file
    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        ENDPOINT, data=body, method="POST",
        headers={
            "Content-Type": "application/json",
            "X-Avian-Secret": secret,
            "User-Agent": "avian-forwarder/1.0",
        },
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        return r.status


def find_clip(date_s: str, time_s: str, com: str) -> tuple[str | None, str | None]:
    """Locate the extracted mp3 for one detection; return (path, basename) or
    (None, None). The species dir is deterministic (common_name_safe, classes.py);
    within it the clip is matched by its unique HH:MM:SS suffix, so an RTSP_ prefix
    or an unexpected confidence-pct format doesn't matter. scandir (not glob) so a
    '*'/'[' in a common name can't break the match."""
    com_safe = com.replace("'", "").replace(" ", "_")
    species_dir = os.path.join(EXTRACTED, "By_Date", date_s, com_safe)
    suffix = f"{time_s}.{AUDIOFMT}"  # e.g. "07:48:01.mp3"
    try:
        for entry in os.scandir(species_dir):
            if entry.is_file() and "birdnet-" in entry.name and entry.name.endswith(suffix):
                return entry.path, entry.name
    except FileNotFoundError:
        pass
    return None, None


def post_clip(secret: str, basename: str, data: bytes) -> int:
    # Key in the query string (percent-encoded — the basename contains ':').
    url = CLIP_ENDPOINT + "?file=" + urllib.parse.quote(basename, safe="")
    req = urllib.request.Request(
        url, data=data, method="POST",
        headers={
            "Content-Type": "audio/mpeg",
            "X-Avian-Secret": secret,
            "User-Agent": "avian-forwarder/1.0",
        },
    )
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.status


def handle_line(secret: str, line: str) -> None:
    parts = line.rstrip("\n").split(";")
    if len(parts) < 5:
        return
    date_s, time_s, sci, com, conf_s = (p.strip() for p in parts[:5])
    if not sci or not com:
        return
    try:
        conf = float(conf_s)
        ts = parse_ts(date_s, time_s)
    except ValueError:
        return  # header line or malformed; skip

    # Locate + upload the clip first, so the detection's `file` key is set only
    # when the object is really in R2 (a failed/absent clip -> NULL -> the site
    # shows "no audio", never a dangling key). Best-effort: never blocks the
    # detection POST below. The clip is already on disk (extract precedes the
    # BirdDB.txt line), so this is a local read + one small upload.
    file_key = None
    clip_time = time_s.split(".")[0]  # filename uses HH:MM:SS, no fractional
    path, basename = find_clip(date_s, clip_time, com)
    if basename:
        try:
            with open(path, "rb") as fh:
                data = fh.read()
            for attempt in range(2):  # one quick retry rides a transient blip
                try:
                    post_clip(secret, basename, data)
                    file_key = basename
                    break
                except Exception:
                    if attempt == 0:
                        time.sleep(2)
                    else:
                        raise
        except Exception as e:
            print(f"clip upload failed for {basename}: {e}", file=sys.stderr, flush=True)
    else:
        print(f"no clip for {sci} @ {date_s} {clip_time} under {EXTRACTED}/By_Date",
              file=sys.stderr, flush=True)

    # A few quick retries ride out a transient blip (DNS, a momentary wifi drop) —
    # common on a Pi. A sustained outage still drops the line: acceptable for a
    # species collage (common birds re-detect constantly; the worker dedupes), and
    # not worth a persistent spool. Offset persistence covers the *restart* case.
    last = None
    for attempt in range(3):
        try:
            status = post(secret, sci, com, conf, ts, file_key)
            print(f"posted {sci} ({com}) conf={conf:.3f} ts={ts} file={file_key or '-'} -> {status}", flush=True)
            return
        except Exception as e:  # HTTPError (4xx/5xx) or URLError (network) — retry then give up
            last = e
            if attempt < 2:
                time.sleep(2)
    print(f"POST failed for {sci} after retries: {last}", file=sys.stderr, flush=True)


def follow(path: str):
    """Yield ``(line, offset, inode)`` for new lines, resuming from the persisted
    offset across restarts so anything appended while we were down isn't lost (the
    worker dedupes any overlap). Survives the file not existing yet, truncation, and
    rotation/recreation (BirdNET-Pi can roll BirdDB.txt)."""
    path = os.path.expanduser(path)
    while not os.path.exists(path):
        time.sleep(2)
    f = open(path, "r")
    inode = os.fstat(f.fileno()).st_ino
    size = os.fstat(f.fileno()).st_size
    saved_offset, saved_inode = load_state()
    if saved_offset is None:
        f.seek(0, os.SEEK_END)               # first run: skip pre-existing history
    elif saved_inode == inode and saved_offset <= size:
        f.seek(saved_offset)                 # resume exactly where we left off
    else:
        f.seek(0)                            # rotation/truncation: read the new file from the start
    save_state(f.tell(), inode)              # persist now so a quick restart resumes here, not at a newer EOF
    while True:
        line = f.readline()
        if line:
            yield line, f.tell(), inode
            continue
        time.sleep(1)
        try:
            st = os.stat(path)
            if st.st_ino != inode or st.st_size < f.tell():
                f.close()
                while not os.path.exists(path):
                    time.sleep(2)
                f = open(path, "r")          # fresh open is at offset 0 → don't miss the new file's head
                inode = os.fstat(f.fileno()).st_ino
        except FileNotFoundError:
            f.close()
            while not os.path.exists(path):
                time.sleep(2)
            f = open(path, "r")
            inode = os.fstat(f.fileno()).st_ino


def main() -> None:
    secret = load_secret()
    print(f"avian-forwarder: watching {os.path.expanduser(DB_TXT)} -> {ENDPOINT}", flush=True)
    for line, offset, inode in follow(DB_TXT):
        handle_line(secret, line)
        # Persist after each handled line so a restart resumes here. Re-posting is
        # dedupe-safe, so even if a POST failed above, advancing the offset is fine.
        save_state(offset, inode)


if __name__ == "__main__":
    main()
