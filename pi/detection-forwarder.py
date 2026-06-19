#!/usr/bin/env python3
"""avian-detection-forwarder — Pi side of AvianVisitors Phase 2.

Tails BirdNET-Pi's ``~/BirdNET-Pi/BirdDB.txt`` (one line appended per detection)
and POSTs each new detection to avian-worker's ``/api/detection``. It is fully
**decoupled** from BirdNET-Pi's source — no edits to reporting.py / the analysis
service — so a ``git pull`` of BirdNET-Pi never clobbers it. The Pi stays
outbound-only: this only makes outbound POSTs, opens no ports.

BirdDB.txt line format (see scripts/utils/reporting.py ``summary()``):
    Date;Time;Sci_Name;Com_Name;Confidence;Lat;Lon;Cutoff;Week;Sens;Overlap
e.g.  2026-06-19;07:48:01;Turdus migratorius;American Robin;0.91;...

The worker dedupes by (sci, ts) with INSERT OR IGNORE, so an occasional replay
(e.g. this service restarting) is harmless. We start at end-of-file so a restart
doesn't re-post the whole history.

Config via env (set in the systemd unit):
    AVIAN_WORKER       base URL of avian-worker (no trailing /api)
    AVIAN_SECRET_FILE  path to a file holding the shared ingest secret (mode 600)
    AVIAN_BIRDDB       path to BirdDB.txt
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.request
from datetime import datetime

WORKER = os.environ.get("AVIAN_WORKER", "https://avian-worker.s-friedman.workers.dev")
SECRET_FILE = os.environ.get("AVIAN_SECRET_FILE", os.path.expanduser("~/.avian/ingest-secret"))
DB_TXT = os.environ.get("AVIAN_BIRDDB", os.path.expanduser("~/BirdNET-Pi/BirdDB.txt"))
ENDPOINT = WORKER.rstrip("/") + "/api/detection"


def load_secret() -> str:
    with open(os.path.expanduser(SECRET_FILE)) as f:
        return f.read().strip()


def parse_ts(date_s: str, time_s: str) -> int:
    # BirdDB.txt records local wall-clock; datetime.timestamp() interprets a
    # naive datetime in the Pi's local tz and returns the correct unix epoch.
    time_s = time_s.split(".")[0]  # tolerate any fractional seconds
    dt = datetime.strptime(f"{date_s} {time_s}", "%Y-%m-%d %H:%M:%S")
    return int(dt.timestamp())


def post(secret: str, sci: str, com: str, conf: float, ts: int) -> int:
    body = json.dumps({"sci": sci, "com": com, "conf": conf, "ts": ts}).encode()
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
    try:
        status = post(secret, sci, com, conf, ts)
        print(f"posted {sci} ({com}) conf={conf:.3f} ts={ts} -> {status}", flush=True)
    except Exception as e:  # network blip etc. — drop this one, keep watching
        print(f"POST failed for {sci}: {e}", file=sys.stderr, flush=True)


def follow(path: str):
    """Yield new lines appended to ``path``, surviving the file not existing yet,
    truncation, and rotation/recreation (BirdNET-Pi can roll BirdDB.txt)."""
    path = os.path.expanduser(path)
    while not os.path.exists(path):
        time.sleep(2)
    f = open(path, "r")
    f.seek(0, os.SEEK_END)
    inode = os.fstat(f.fileno()).st_ino
    while True:
        line = f.readline()
        if line:
            yield line
            continue
        time.sleep(1)
        try:
            st = os.stat(path)
            if st.st_ino != inode or st.st_size < f.tell():
                f.close()
                while not os.path.exists(path):
                    time.sleep(2)
                f = open(path, "r")
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
    for line in follow(DB_TXT):
        handle_line(secret, line)


if __name__ == "__main__":
    main()
